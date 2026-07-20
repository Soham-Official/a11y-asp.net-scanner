import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { LlmProvider } from "../llm/provider.js";
import type { Finding, PageEvidence, WcagLevel } from "../types.js";
import { extractJson, parseJsonLenient } from "./_llm-json.js";
import { understandingUrlForSc } from "../wcag.js";

/**
 * Content-quality agent. Runs LLM-based judgement for WCAG A & AA Success
 * Criteria that can't be checked mechanically:
 *
 *   Level A:  1.1.1, 1.3.3, 2.4.2, 2.4.4, 2.5.3, 3.3.1, 3.3.2
 *   Level AA: 1.3.5, 2.4.6, 3.1.2, 3.3.3
 *
 * Every finding is `requiresHumanReview: true, severity: "review"`. We never
 * auto-claim conformance — these are *candidates* for an auditor to confirm.
 *
 * Gated upstream on a non-mock LLM provider (graph.ts). When the provider is
 * mocked the agent never runs; users opt out by removing their API key or
 * setting `A11Y_HAIP_MOCK=1`.
 */

const ContentQualityResponseSchema = z.object({
  findings: z.array(
    z.object({
      sc: z.string(),
      title: z.string(),
      description: z.string(),
      evidence: z.string().optional(),
      confidence: z.enum(["low", "medium", "high"]),
      remediation: z.string().optional(),
    }),
  ),
});

// Emit ALLOWLIST: the A/AA SCs this agent is allowed to surface. An SC returned
// by the LLM that is NOT a key here is dropped so reports stay in scope. The
// level value is authoritative in wcag.ts; this map's KEYS are the filter.
const SC_LEVEL: Record<string, WcagLevel> = {
  "1.1.1": "A",
  "1.3.3": "A",
  "2.4.2": "A",
  "2.4.4": "A",
  "2.5.3": "A",
  "3.3.1": "A",
  "3.3.2": "A",
  "1.3.5": "AA",
  "2.4.6": "AA",
  "3.1.2": "AA",
  "3.3.3": "AA",
};

const SYSTEM_PROMPT =
  `You are an accessibility expert reviewing a web page against WCAG 2.2 ` +
  `Level A and AA Success Criteria. You ONLY flag CANDIDATES for human ` +
  `review. You never claim conformance. Be conservative: prefer fewer ` +
  `high-quality findings over many speculative ones. ` +
  `Confidence "high" means a competent SR/keyboard user would also flag it. ` +
  `\n\n` +
  `CRITICAL OUTPUT RULES: ` +
  `1. Respond with ONE JSON object. No prose, no preamble, no markdown fences. ` +
  `2. Start your response with the character "{" and end with "}". ` +
  `3. The JSON shape is exactly: ` +
  `{"findings":[{"sc":"X.X.X","title":"...","description":"...","evidence":"...","confidence":"low|medium|high","remediation":"..."}]} ` +
  `4. If you have nothing to flag, return {"findings":[]}.`;

interface ContentQualityInput {
  evidence: PageEvidence[];
  llm: LlmProvider;
  /**
   * Hard ceiling honoured before each LLM call. The agent stops emitting
   * additional pages once cumulative `llm.totalCost` reaches 95% of this.
   */
  maxCostUsd?: number;
}

const PER_PAGE_FINDING_CAP = 20;

export async function runContentQuality(input: ContentQualityInput): Promise<{
  findings: Finding[];
  costUsd: number;
}> {
  if (input.evidence.length === 0) {
    return { findings: [], costUsd: 0 };
  }

  const findings: Finding[] = [];
  let totalCost = 0;
  const ceiling =
    typeof input.maxCostUsd === "number" ? input.maxCostUsd : Infinity;

  for (const ev of input.evidence) {
    if (input.llm.totalCost >= ceiling * 0.95) {
      console.warn(
        `[a11y-scout] content-quality: cost ceiling ($${ceiling.toFixed(2)}) ` +
          `reached, skipping ${ev.url}`,
      );
      continue;
    }

    const prompt = buildPrompt(ev);
    let parsed: z.infer<typeof ContentQualityResponseSchema>;
    let isMock = false;
    try {
      const resp = await input.llm.chat({
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        model: "reasoner",
        temperature: 0.0,
        maxTokens: 2500,
      });
      isMock = resp.isMock;
      totalCost += resp.costUsd;
      const json = parseJsonLenient(extractJson(resp.content));
      parsed = ContentQualityResponseSchema.parse(json);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.warn(
        `[a11y-scout] content-quality: LLM call failed for ${ev.url}: ${msg}`,
      );
      if (process.env.DEBUG) {
        console.warn(err);
      }
      continue;
    }

    const items = parsed.findings.slice(0, PER_PAGE_FINDING_CAP);
    for (const item of items) {
      const level = SC_LEVEL[item.sc];
      if (!level) {
        // Drop SCs outside our advertised set so reports stay coherent.
        continue;
      }
      findings.push({
        id: uuidv4(),
        wcagSc: item.sc,
        wcagLevel: level,
        severity: "review",
        source: "content-quality",
        ruleId: `content-quality-${item.sc}`,
        title: item.title,
        description: item.description,
        helpUrl: understandingUrlForSc(item.sc),
        htmlSnippet: item.evidence,
        remediation: item.remediation,
        aiGenerated: true,
        confidence: item.confidence,
        requiresHumanReview: true,
        tags: [
          "content-quality",
          "ai-flagged",
          level === "A" ? "wcag-a" : "wcag-aa",
          ...(isMock ? ["__mock__"] : []),
        ],
        relatedRuleIds: [],
        relatedNodes: [],
      });
    }
  }

  return { findings, costUsd: totalCost };
}

function buildPrompt(ev: PageEvidence): string {
  const headingSummary =
    ev.headings.map((h) => `H${h.level}: ${h.text}`).join("\n") || "(none)";

  const linkSummary =
    ev.links
      .slice(0, 30)
      .map((l, i) => `${i + 1}. "${l.text}" -> ${l.href}`)
      .join("\n") || "(none)";

  const imageSummary =
    ev.images
      .slice(0, 30)
      .map((img, i) => {
        const altRepr = img.hasAlt ? `alt="${img.alt}"` : "alt=(missing)";
        const base = img.src ? srcBasename(img.src) : "(no src)";
        return `${i + 1}. ${altRepr} src=${base}`;
      })
      .join("\n") || "(none)";

  const formSummary =
    ev.formFields
      .slice(0, 20)
      .map((f, i) => {
        const parts: string[] = [];
        parts.push(`<${f.tag}`);
        if (f.type) parts.push(`type=${f.type}`);
        if (f.id) parts.push(`id=${f.id}`);
        if (f.name) parts.push(`name=${f.name}`);
        if (f.autocomplete) parts.push(`autocomplete=${f.autocomplete}`);
        if (f.required) parts.push("required");
        const labelRepr = f.labelText ? `label="${f.labelText}"` : "label=(none)";
        const accRepr = f.accessibleName
          ? `accessibleName="${f.accessibleName}"`
          : "accessibleName=(none)";
        const placeholderRepr = f.placeholder
          ? `placeholder="${f.placeholder}"`
          : "";
        const describedByRepr = f.describedByText
          ? `describedBy="${f.describedByText}"`
          : "";
        return `${i + 1}. ${parts.join(" ")} ${labelRepr} ${accRepr} ${placeholderRepr} ${describedByRepr}>`.trim();
      })
      .join("\n") || "(none)";

  const errorSummary =
    ev.errorMessages
      .slice(0, 10)
      .map((e, i) => {
        const role = e.role ? `role=${e.role}` : "";
        const near = e.nearFieldName ? `near=${e.nearFieldName}` : "";
        return `${i + 1}. ${role} "${e.text}" ${near}`.trim();
      })
      .join("\n") || "(none)";

  const instructionSummary =
    ev.instructions
      .slice(0, 10)
      .map((s) => `- "${s}"`)
      .join("\n") || "(none)";

  const langPartsSummary =
    ev.langParts
      .slice(0, 15)
      .map((p) => `- lang=${p.lang} "${p.text}"`)
      .join("\n") || "(none)";

  const text = (ev.textSample ?? "").slice(0, 2500);

  return `Page URL: ${ev.url}
Page title: ${ev.title ?? "(none)"}
HTML lang: ${ev.htmlLang ?? "(none)"}

HEADINGS:
${headingSummary}

LINKS (first 30):
${linkSummary}

IMAGES (first 30, alt='' shown explicitly):
${imageSummary}

FORM FIELDS (first 20):
${formSummary}

ERROR MESSAGES (first 10):
${errorSummary}

INSTRUCTIONS NEAR FORMS (first 10):
${instructionSummary}

LANGUAGE-OF-PARTS SAMPLES (lang != ${ev.htmlLang ?? "(page lang)"}):
${langPartsSummary}

VISIBLE TEXT SAMPLE (first 2500 chars):
${text || "(none)"}

Review against EACH of these criteria. Emit AT MOST ONE finding per SC unless
the violations are clearly distinct elements. Empty findings array is OK.

LEVEL A:
- 1.1.1 Alt text quality: alt that is "image", "photo", "logo", a filename, or duplicates the surrounding text. Missing-alt is already covered by axe — flag only meaningless alt.
- 1.3.3 Sensory characteristics: instructions referencing only shape/color/position/sound ("click the green button", "see the box on the right").
- 2.4.2 Page title descriptiveness: missing or generic ("Untitled", "Home", "Document"). A unique, topical title is required.
- 2.4.4 Link purpose in context: link text like "click here", "read more", "learn more" with no surrounding context disambiguating destination.
- 2.5.3 Label in name: visible label text is NOT contained in the accessible name (e.g. visible "Submit order", aria-label="Send"). Skip if labels and accessibleNames match.
- 3.3.1 Error identification: an error region is present but the text doesn't say WHICH field or WHAT'S wrong (e.g. "Invalid input").
- 3.3.2 Form field labels: a field has no visible label, no aria-label, and no aria-labelledby. Placeholder alone does NOT count.

LEVEL AA:
- 1.3.5 Input purpose: input collecting personal data (email/name/tel/address/cc) missing or wrong autocomplete token. Use the standard WCAG token list.
- 2.4.6 Headings and labels are descriptive: vague headings ("Section 1") or vague labels ("Field") that don't describe content/purpose.
- 3.1.2 Language of parts: a foreign-language passage in the visible text appears without a lang attribute on its element (compare against HTML lang above).
- 3.3.3 Error suggestion: an error has been identified but no suggestion for correction is provided when one is feasible (e.g. "invalid email" without a format hint).

Only flag if you'd stake a real audit on it.`;
}

function srcBasename(src: string): string {
  try {
    const u = new URL(src);
    const path = u.pathname;
    const last = path.slice(path.lastIndexOf("/") + 1);
    return last || u.hostname;
  } catch {
    return src.slice(-60);
  }
}
