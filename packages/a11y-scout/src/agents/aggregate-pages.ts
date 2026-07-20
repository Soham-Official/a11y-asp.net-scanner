import type {
  Finding,
  InapplicableRule,
  PageEvidence,
  PassedRule,
} from "../types.js";
import { validate } from "./validator.js";

/**
 * One page's worth of scan output. Both the CLI crawler and the Playwright
 * fixture build these per page and hand a list to `aggregatePages` for the
 * merge step.
 */
export interface PerPageSlice {
  url: string;
  findings: Finding[];
  evidence: PageEvidence;
  passes: PassedRule[];
  inapplicable: InapplicableRule[];
}

export interface AggregatedPages {
  /** Concatenated findings, then `validate()`d so cross-page duplicates collapse. */
  findings: Finding[];
  evidence: PageEvidence[];
  /** Merged by ruleId. nodeCount summed, sampleSelectors deduped + capped at 5, pageUrls extended. */
  passes: PassedRule[];
  /** Rules inapplicable on *every* page (intersection). pageUrls extended for survivors. */
  inapplicable: InapplicableRule[];
  /** Page URLs in slice order. */
  pagesScanned: string[];
}

/**
 * Multi-page aggregator. Lives outside both `crawler.ts` and the Playwright
 * fixture so the merge semantics stay identical across surfaces.
 *
 * - findings: concat + run through the validator once so duplicates collapse.
 * - passes: union by ruleId; sum node counts, take first 5 unique sample selectors,
 *   extend `pageUrls` with every page the rule passed on.
 * - inapplicable: only keep rules that were inapplicable on *every* page (a rule
 *   that became applicable on any page drops out). Mirrors the crawler's
 *   conservative semantics so "Not Applicable" really means "nothing to test".
 */
export function aggregatePages(slices: PerPageSlice[]): AggregatedPages {
  const findings: Finding[] = [];
  const evidence: PageEvidence[] = [];
  const pagesScanned: string[] = [];
  const passesMap = new Map<string, PassedRule>();
  const inapplicableMap = new Map<string, InapplicableRule>();
  let firstSlice = true;

  for (const slice of slices) {
    findings.push(...slice.findings);
    evidence.push(slice.evidence);
    pagesScanned.push(slice.url);

    for (const pass of slice.passes) {
      const existing = passesMap.get(pass.ruleId);
      if (existing) {
        existing.nodeCount += pass.nodeCount;
        const all = [...existing.sampleSelectors, ...pass.sampleSelectors];
        existing.sampleSelectors = [...new Set(all)].slice(0, 5);
        for (const u of pass.pageUrls) {
          if (!existing.pageUrls.includes(u)) existing.pageUrls.push(u);
        }
      } else {
        passesMap.set(pass.ruleId, {
          ...pass,
          sampleSelectors: [...new Set(pass.sampleSelectors)].slice(0, 5),
          pageUrls: [...pass.pageUrls],
        });
      }
    }

    if (firstSlice) {
      for (const rule of slice.inapplicable) {
        inapplicableMap.set(rule.ruleId, {
          ...rule,
          pageUrls: [...rule.pageUrls],
        });
      }
      firstSlice = false;
    } else {
      const currentIds = new Set(slice.inapplicable.map((r) => r.ruleId));
      const toRemove: string[] = [];
      for (const [ruleId, rule] of inapplicableMap) {
        if (currentIds.has(ruleId)) {
          if (!rule.pageUrls.includes(slice.url)) {
            rule.pageUrls.push(slice.url);
          }
        } else {
          toRemove.push(ruleId);
        }
      }
      for (const id of toRemove) inapplicableMap.delete(id);
    }
  }

  return {
    findings: validate(findings),
    evidence,
    passes: [...passesMap.values()],
    inapplicable: [...inapplicableMap.values()],
    pagesScanned,
  };
}
