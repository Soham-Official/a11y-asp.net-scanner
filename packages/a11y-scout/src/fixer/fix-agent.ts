/**
 * LLM-powered agent for generating accessibility fixes.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { jsonrepair } from "jsonrepair";
import type { LlmProvider } from "../llm/index.js";
import { FixActionSchema, type Finding, type FixAction } from "../types.js";

/** Front-end framework whose source syntax a generated fix must match. */
type FixFramework = "jsx" | "angular";

/**
 * Build the fix-generator system prompt for a given framework.
 *
 * The `jsx` branch returns the historical React/JSX prompt verbatim (byte-for-
 * byte unchanged, so React behavior is preserved exactly). The `angular` branch
 * keeps the same rules + category list but swaps the JSX-specific syntax
 * examples for plain-HTML Angular template guidance, and forbids characters
 * that would break an inline `template:` string literal in a `.component.ts`.
 */
export function buildSystemPrompt(framework: FixFramework): string {
  if (framework === "angular") {
    return `You are an accessibility fix generator. Generate code fixes for WCAG accessibility issues.

Rules:
1. Only generate HIGH confidence fixes for simple, safe changes (missing alt text, lang attribute, labels, attribute renames, attribute removals).
2. MEDIUM confidence for text improvements (button/link/heading/anchor text) where semantics are guessed.
3. LOW confidence for complex structural changes.
4. Return exact replacement strings that can be applied via string replacement.
5. Include line context to make replacements unique. Match the original whitespace and indentation byte-for-byte — the applier does literal string replacement.
6. Explain each fix clearly.
7. If you cannot safely fix a finding, OMIT it from the response. Do not invent a fix.

Categories:
- missing-alt: add a descriptive alt attribute to <img> / <input type="image"> / role="img".
- missing-lang: add lang="en" (or the appropriate locale) to <html>.
- empty-button: insert button text content or aria-label.
- empty-link: insert link text content or aria-label.
- missing-label: associate <label for="..."> with its control or wrap the control in the label.
- attribute-rename: fix typo'd ARIA prop names (e.g. aria-labeledby → aria-labelledby). Replace the attribute name only.
- attribute-value: replace an invalid attribute value with a valid one (e.g. tabindex="5" → tabindex="0", role="buton" → role="button", autocomplete="not-a-real-token" → autocomplete="off").
- attribute-removal: delete the offending attribute and its leading whitespace; keep sibling props intact.
- iframe-title: add a descriptive title="..." to the <iframe> opening tag.
- empty-heading: insert plausible placeholder content; mark confidence "medium" because the semantics are guessed.
- empty-anchor: insert plausible placeholder text or aria-label; mark confidence "medium".
- other: use only when no other category applies; the fix will likely be skipped.

This source is an Angular HTML template, NOT JSX. Emit plain HTML attribute syntax:
- Use for="id" (not htmlFor), class="..." (not className), tabindex="0" (not tabIndex={0}), alt="...", scope="col" (plain, not [attr.scope]).
- Write role and other values as plain double-quoted strings (role="button"), never role={...}.
- Do NOT emit JSX expression braces { } or camelCased DOM attribute names.
- For no-distracting-elements (<marquee>/<blink>), replace the element with its inner content rather than deleting an attribute.
- Preserve Angular bindings verbatim: leave (click)="...", [prop]="...", *ngIf, {{ }} interpolation, and #templateRefs untouched unless they are the issue itself.
- This template may be embedded in a TypeScript backtick string. Do NOT use backtick (\`) characters or \${...} sequences in your replacement; use plain double-quoted attribute values.

Output valid JSON only.`;
  }

  // jsx — historical prompt, unchanged.
  return `You are an accessibility fix generator. Generate code fixes for WCAG accessibility issues.

Rules:
1. Only generate HIGH confidence fixes for simple, safe changes (missing alt text, lang attribute, labels, attribute renames, attribute removals).
2. MEDIUM confidence for text improvements (button/link/heading/anchor text) where semantics are guessed.
3. LOW confidence for complex structural changes.
4. Return exact replacement strings that can be applied via string replacement.
5. Include line context to make replacements unique. Match the original whitespace and indentation byte-for-byte — the applier does literal string replacement.
6. Explain each fix clearly.
7. If you cannot safely fix a finding, OMIT it from the response. Do not invent a fix.

Categories:
- missing-alt: add a descriptive alt attribute to <img> / <input type="image"> / role="img".
- missing-lang: add lang="en" (or the appropriate locale) to <html>.
- empty-button: insert button text content or aria-label.
- empty-link: insert link text content or aria-label.
- missing-label: associate <label htmlFor="..."> with its control or wrap the control in the label.
- attribute-rename: fix typo'd ARIA prop names (e.g. aria-labeledby → aria-labelledby). Replace the attribute name only.
- attribute-value: replace an invalid attribute value with a valid one (e.g. tabIndex={5} → tabIndex={0}, role="buton" → role="button", autoComplete="not-a-real-token" → autoComplete="off").
- attribute-removal: delete the offending attribute and its leading whitespace; keep sibling props intact.
- iframe-title: add a descriptive title="..." to the <iframe> opening tag.
- empty-heading: insert plausible placeholder content; mark confidence "medium" because the semantics are guessed.
- empty-anchor: insert plausible placeholder text or aria-label; mark confidence "medium".
- other: use only when no other category applies; the fix will likely be skipped.

Output valid JSON only.`;
}

/**
 * Generate fix actions for a batch of findings.
 */
export async function generateFixes(
  findings: Finding[],
  llm: LlmProvider,
  opts: { repoRoot?: string } = {},
): Promise<FixAction[]> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const fixes: FixAction[] = [];

  // Group findings by file for efficient processing
  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (!finding.filePath) continue;
    const path = finding.filePath;
    if (!byFile.has(path)) {
      byFile.set(path, []);
    }
    byFile.get(path)!.push(finding);
  }

  // Process each file
  for (const [filePath, fileFindings] of byFile.entries()) {
    const fileFixes = await generateFixesForFile(
      filePath,
      fileFindings,
      llm,
      repoRoot,
    );
    fixes.push(...fileFixes);
  }

  return fixes;
}

/**
 * Generate fixes for all findings in a single file.
 */
async function generateFixesForFile(
  filePath: string,
  findings: Finding[],
  llm: LlmProvider,
  repoRoot: string,
): Promise<FixAction[]> {
  const absolutePath = resolve(repoRoot, filePath);

  // Read file content
  let fileContent: string;
  try {
    fileContent = readFileSync(absolutePath, "utf-8");
  } catch (error) {
    console.warn(`Cannot read file ${filePath}, skipping fixes`);
    return [];
  }

  const lines = fileContent.split("\n");

  // Build context for LLM
  const findingsContext = findings
    .map((f, i) => {
      const lineNum = f.line ?? 0;
      const snippet = f.htmlSnippet ?? (lineNum > 0 ? lines[lineNum - 1] : "");
      return `
Finding ${i + 1}:
- ID: ${f.id}
- Rule: ${f.ruleId}
- Issue: ${f.title}
- Line: ${lineNum}
- Snippet: ${snippet}
- Description: ${f.description}
- Remediation: ${f.remediation ?? "N/A"}
`;
    })
    .join("\n");

  // All findings grouped into one file share a source (grouping is by
  // filePath, and a file belongs to one framework), so the first finding's
  // source determines which syntax the generated fixes must use.
  const framework: FixFramework =
    findings[0]?.source === "eslint-angular-template" ? "angular" : "jsx";
  const systemPrompt = buildSystemPrompt(framework);

  const prompt = `File: ${filePath}

${findingsContext}

Generate fixes for these accessibility issues. Return JSON in this format:
{
  "fixes": [
    {
      "findingId": "finding-id",
      "category": "missing-alt|missing-lang|empty-button|empty-link|missing-label|attribute-rename|attribute-value|attribute-removal|iframe-title|empty-heading|empty-anchor|other",
      "confidence": "high|medium|low",
      "filePath": "${filePath}",
      "lineNumber": 42,
      "original": "exact string to replace (include surrounding context)",
      "replacement": "replacement string",
      "explanation": "Why this fix is correct"
    }
  ]
}

Focus on HIGH confidence fixes. Only include MEDIUM/LOW if you are confident they are safe and correct. If a finding doesn't fit any category and isn't safely fixable, omit it.`;

  try {
    const response = await llm.chat({
      prompt,
      systemPrompt,
      model: "reasoner",
      responseFormat: { type: "json_object" },
      temperature: 0.0,
      maxTokens: 2048,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.content);
    } catch {
      const repaired = jsonrepair(response.content);
      parsed = JSON.parse(repaired);
    }

    // Validate per-item rather than as one array: if the LLM omits a field
    // on fix #N, we still want the other fixes for this file to land. The
    // bad item is logged so it isn't lost silently.
    const rawFixes = (parsed as { fixes?: unknown[] }).fixes ?? [];
    if (!Array.isArray(rawFixes)) {
      console.warn(`LLM response for ${filePath} had no fixes array`);
      return [];
    }
    const valid: FixAction[] = [];
    for (let i = 0; i < rawFixes.length; i++) {
      const result = FixActionSchema.safeParse(rawFixes[i]);
      if (!result.success) {
        console.warn(
          `Skipping malformed fix #${i} for ${filePath}: ${result.error.errors
            .map((e) => `${e.path.join(".")}: ${e.message}`)
            .join("; ")}`,
        );
        continue;
      }
      // Inline-template guardrail: an Angular template can live inside a
      // backtick `template:` string in a .component.ts file. A replacement
      // containing a backtick or `${` would terminate / reinterpret that
      // string literal and corrupt the TypeScript file, so reject it before it
      // ever reaches the (literal string-replacing) applier.
      if (
        result.data.filePath.endsWith(".ts") &&
        (result.data.replacement.includes("`") ||
          result.data.replacement.includes("${"))
      ) {
        console.warn(
          `Skipping fix #${i} for ${filePath}: replacement contains a backtick or \${ } sequence that could break an inline template string literal`,
        );
        continue;
      }
      valid.push(result.data);
    }
    return valid;
  } catch (error) {
    console.warn(
      `LLM fix generation failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}
