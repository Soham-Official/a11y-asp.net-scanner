import type { Finding } from "../types.js";
import { SEVERITY_RANK, equivalenceGroupForRule } from "../wcag.js";

/**
 * V1 validator: dedupes overlapping findings and re-applies the canonical
 * severity from the WCAG catalog. V2 will use Titan embeddings for semantic
 * dedup of message text.
 *
 * Dedup key: (filePath|selector, line, column, equivalenceGroup). Two rules
 * that map to the same equivalence group on the same location collapse into
 * one finding; the loser's ruleId is preserved on `relatedRuleIds` so
 * reporters can surface it.
 */
export function validate(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    // Column is intentionally omitted: two equivalent ESLint rules can flag
    // the same JSX element at slightly different columns (one targets `<div`,
    // the other targets `onClick`). Line + filePath is precise enough.
    const key = [
      equivalenceGroupForRule(f.ruleId),
      f.selector ?? "",
      f.filePath ?? "",
      f.line ?? "",
    ].join("|");
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, f);
      continue;
    }
    seen.set(key, mergeFindings(existing, f));
  }
  return [...seen.values()].sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    return a.wcagSc.localeCompare(b.wcagSc);
  });
}

function mergeFindings(a: Finding, b: Finding): Finding {
  const winner = SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a;
  const loser = winner === a ? b : a;
  const related = new Set<string>([
    ...winner.relatedRuleIds,
    ...loser.relatedRuleIds,
  ]);
  if (loser.ruleId !== winner.ruleId) related.add(loser.ruleId);
  return { ...winner, relatedRuleIds: [...related] };
}
