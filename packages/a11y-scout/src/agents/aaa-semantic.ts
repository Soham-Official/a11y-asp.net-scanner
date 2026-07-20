import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { LlmProvider } from "../llm/provider.js";
import type { Finding, PageEvidence } from "../types.js";
import { extractJson, parseJsonLenient } from "./_llm-json.js";
import { understandingUrlForSc } from "../wcag.js";

const AaaCheckResponseSchema = z.object({
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

const SYSTEM_PROMPT = `You are an accessibility expert reviewing a web page against WCAG 2.2 Level AAA criteria. \
You only flag CANDIDATES for human review. You never claim conformance. \
Confidence "high" means a competent SR/keyboard user would also flag it. \
Be conservative: prefer fewer high-quality findings over many speculative ones. \
\
CRITICAL OUTPUT RULES: \
1. Respond with ONE JSON object. No prose, no preamble, no markdown fences. \
2. Start your response with the character "{" and end with "}". \
3. The JSON shape is exactly: \
{"findings":[{"sc":"X.X.X","title":"...","description":"...","evidence":"...","confidence":"low|medium|high","remediation":"..."}]} \
4. If you have nothing to flag, return {"findings":[]}.`;

interface AaaSemanticInput {
  evidence: PageEvidence[];
  llm: LlmProvider;
}

export async function runAaaSemantic(input: AaaSemanticInput): Promise<{
  findings: Finding[];
  costUsd: number;
}> {
  if (input.evidence.length === 0) {
    return { findings: [], costUsd: 0 };
  }

  const findings: Finding[] = [];
  let totalCost = 0;

  for (const ev of input.evidence) {
    const prompt = buildPrompt(ev);
    let parsed: z.infer<typeof AaaCheckResponseSchema>;
    let isMock = false;
    try {
      const resp = await input.llm.chat({
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        model: "reasoner",
        // No response_format: not all HAIP-allowlisted models support tool
        // use / JSON mode. We coerce JSON via prompt + extractJson() instead.
        temperature: 0.0,
        maxTokens: 1500,
      });
      isMock = resp.isMock;
      totalCost += resp.costUsd;
      const json = parseJsonLenient(extractJson(resp.content));
      parsed = AaaCheckResponseSchema.parse(json);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.warn(
        `[a11y-scout] AAA semantic agent: LLM call failed for ${ev.url}: ${msg}`,
      );
      if (process.env.DEBUG) {
        console.warn(err);
      }
      continue;
    }

    for (const item of parsed.findings) {
      findings.push({
        id: uuidv4(),
        wcagSc: item.sc,
        wcagLevel: "AAA",
        severity: "review",
        source: "aaa-semantic",
        ruleId: `aaa-${item.sc}`,
        title: item.title,
        description: item.description,
        helpUrl: understandingUrlForSc(item.sc),
        htmlSnippet: item.evidence,
        remediation: item.remediation,
        aiGenerated: true,
        confidence: item.confidence,
        requiresHumanReview: true,
        tags: ["aaa", "ai-flagged", ...(isMock ? ["__mock__"] : [])],
        relatedRuleIds: [],
        relatedNodes: [],
      });
    }
  }

  return { findings, costUsd: totalCost };
}

function buildPrompt(ev: PageEvidence): string {
  const linkSummary = ev.links
    .slice(0, 30)
    .map((l, i) => `${i + 1}. "${l.text}" -> ${l.href}`)
    .join("\n");
  const headingSummary = ev.headings
    .map((h) => `H${h.level}: ${h.text}`)
    .join("\n");
  const text = (ev.textSample ?? "").slice(0, 3000);
  return `Page URL: ${ev.url}
Page title: ${ev.title ?? "(none)"}

HEADINGS:
${headingSummary || "(none)"}

LINKS (first 30):
${linkSummary || "(none)"}

VISIBLE TEXT SAMPLE (first 3000 chars):
${text || "(none)"}

Review against ALL of these AAA criteria and return a JSON object with a "findings" array:
- 2.4.9 Link Purpose (Link Only): is each link's text alone sufficient to know where it goes?
- 2.4.10 Section Headings: are headings present and thematically appropriate?
- 3.1.3 Unusual Words: jargon/idioms used without definition?
- 3.1.4 Abbreviations: undefined abbreviations?
- 3.1.5 Reading Level: text appears above lower-secondary reading level without an alternative?
- 3.3.5 Help: does the page lack contextual help where users likely need it?

Only include findings you'd stake a real audit on. Empty findings array is acceptable.`;
}

