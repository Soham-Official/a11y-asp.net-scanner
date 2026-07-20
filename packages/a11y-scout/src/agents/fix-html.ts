import { z } from "zod";
import type { LlmProvider } from "../llm/provider.js";
import type { Finding } from "../types.js";
import { extractJson, parseJsonLenient } from "./_llm-json.js";

/**
 * fix-html agent. For each finding that has both an HTML snippet and
 * remediation guidance, ask the LLM to produce a corrected version of just
 * that snippet. Result is written to `finding.aiFixedHtml` and surfaced in
 * the report as an "AI Suggested Fix" block — never auto-applied.
 *
 * Gated upstream on:
 *   - mode === "url" (no use for repo / fixture scans)
 *   - !llm.isMock (mock providers would emit garbage)
 *   - plan.aiFix !== false (CLI `--no-ai-fix` opts out)
 */

const FixHtmlResponseSchema = z.object({
  fixedHtml: z.string(),
});

const SYSTEM_PROMPT =
  `You are an HTML accessibility fixer. You receive a failing HTML snippet ` +
  `and remediation guidance, and return ONLY a corrected version of that ` +
  `snippet. ` +
  `\n\n` +
  `RULES: ` +
  `1. Output exactly one JSON object: {"fixedHtml":"..."}. ` +
  `2. Start with "{" and end with "}". No prose, no markdown fences. ` +
  `3. Fix ONLY the accessibility issue described in the remediation. Do not ` +
  `   rename classes/ids, restructure markup, or change unrelated attributes. ` +
  `4. Preserve original tag, attribute order, indentation, and surrounding ` +
  `   text where unchanged. ` +
  `5. If the remediation needs new content (e.g. an alt text, a label), use ` +
  `   a clear, realistic placeholder based on context (filename, surrounding ` +
  `   text). Do not invent product names. ` +
  `6. If you cannot meaningfully fix the snippet, return the original ` +
  `   snippet unchanged in fixedHtml.`;

interface FixHtmlInput {
  findings: Finding[];
  llm: LlmProvider;
  /** Hard ceiling honoured before each LLM call. Stops once cumulative cost reaches 95% of this. */
  maxCostUsd?: number;
}

const MAX_SNIPPET_CHARS = 2000;

export async function runFixHtml(input: FixHtmlInput): Promise<{
  costUsd: number;
}> {
  let totalCost = 0;
  const ceiling =
    typeof input.maxCostUsd === "number" ? input.maxCostUsd : Infinity;

  for (const f of input.findings) {
    if (!f.htmlSnippet || !f.remediation) continue;

    if (input.llm.totalCost >= ceiling * 0.95) {
      console.warn(
        `[a11y-scout] fix-html: cost ceiling ($${ceiling.toFixed(2)}) ` +
          `reached, skipping remaining findings`,
      );
      break;
    }

    const snippet = f.htmlSnippet.slice(0, MAX_SNIPPET_CHARS);
    const prompt = buildPrompt(snippet, f.remediation, f.title, f.wcagSc);

    try {
      const resp = await input.llm.chat({
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        model: "reasoner",
        temperature: 0.0,
        maxTokens: 1500,
        responseFormat: { type: "json_object" },
      });
      totalCost += resp.costUsd;
      if (resp.isMock) continue;
      const json = parseJsonLenient(extractJson(resp.content));
      const parsed = FixHtmlResponseSchema.parse(json);
      const fixed = parsed.fixedHtml.trim();
      if (fixed && fixed !== snippet) {
        f.aiFixedHtml = fixed;
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.warn(
        `[a11y-scout] fix-html: LLM call failed for finding ${f.id}: ${msg}`,
      );
      if (process.env.DEBUG) console.warn(err);
      continue;
    }
  }

  return { costUsd: totalCost };
}

function buildPrompt(
  snippet: string,
  remediation: string,
  title: string,
  wcagSc: string,
): string {
  return `Issue: ${title} (WCAG ${wcagSc})

Remediation guidance:
${remediation}

Failing HTML:
${snippet}

Return JSON with a single key "fixedHtml" containing the corrected snippet.`;
}
