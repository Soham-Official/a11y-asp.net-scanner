/**
 * Single source of truth for fix categorization. The fix-agent uses this to
 * label generated FixActions; the report-loader uses it to decide which
 * findings the Phase-1 fixer can actually handle.
 *
 * Adding a new automatable rule:
 *   1. Add an entry to RULE_ID_TO_CATEGORY below (exact ruleId match).
 *   2. Add the resulting category to SUPPORTED_FIX_CATEGORIES.
 *   3. Update the LLM prompt in fix-agent.ts to describe how to fix it.
 */

import type { Finding, FixCategory } from "../types.js";

/**
 * Categories the auto-fixer can resolve today.
 *
 * Anything mapped to "other" requires manual remediation.
 */
export const SUPPORTED_FIX_CATEGORIES: ReadonlySet<FixCategory> = new Set<FixCategory>([
  "missing-alt",
  "missing-lang",
  "empty-button",
  "empty-link",
  "missing-label",
  "attribute-rename",
  "attribute-value",
  "attribute-removal",
  "iframe-title",
  "empty-heading",
  "empty-anchor",
]);

/**
 * Exact ruleId → category. Exact match avoids the substring trap where
 * "label" would otherwise capture `aria-labeledby`-shaped ids and where
 * "alt" would catch unrelated rules.
 */
const RULE_ID_TO_CATEGORY: Record<string, FixCategory> = {
  // missing-alt family
  "jsx-a11y/alt-text": "missing-alt",
  "jsx-a11y/img-redundant-alt": "missing-alt",
  // missing-lang family
  "jsx-a11y/html-has-lang": "missing-lang",
  "jsx-a11y/lang": "missing-lang",
  // missing-label family
  "jsx-a11y/control-has-associated-label": "missing-label",
  "jsx-a11y/label-has-associated-control": "missing-label",
  "jsx-a11y/label-has-for": "missing-label",
  // attribute-rename — typo'd ARIA prop name
  "jsx-a11y/aria-props": "attribute-rename",
  // attribute-value — change a value, keep the attribute
  "jsx-a11y/aria-proptypes": "attribute-value",
  "jsx-a11y/tabindex-no-positive": "attribute-value",
  "jsx-a11y/autocomplete-valid": "attribute-value",
  "jsx-a11y/aria-role": "attribute-value",
  // attribute-removal — delete the offending attribute
  "jsx-a11y/no-access-key": "attribute-removal",
  "jsx-a11y/no-autofocus": "attribute-removal",
  "jsx-a11y/aria-unsupported-elements": "attribute-removal",
  "jsx-a11y/no-redundant-roles": "attribute-removal",
  "jsx-a11y/scope": "attribute-removal",
  "jsx-a11y/no-distracting-elements": "attribute-removal",
  "jsx-a11y/no-noninteractive-tabindex": "attribute-removal",
  // content insertion
  "jsx-a11y/iframe-has-title": "iframe-title",
  "jsx-a11y/heading-has-content": "empty-heading",
  "jsx-a11y/anchor-has-content": "empty-anchor",

  // ---------------------------------------------------------------------------
  // Angular template rules (@angular-eslint/template/*). Categories mirror the
  // React jsx-a11y parity above: a rule is fixable here only if its React
  // counterpart is fixable. The interactive rules (click/mouse-events,
  // interactive-supports-focus) and role-has-required-aria are intentionally
  // OMITTED — they fall through to "other" (unfixable), exactly as the
  // equivalent jsx-a11y rules do, because they need handlers/structure rather
  // than a localized string edit.
  // ---------------------------------------------------------------------------
  // missing-alt family
  "@angular-eslint/template/alt-text": "missing-alt",
  // missing-label family
  "@angular-eslint/template/label-has-associated-control": "missing-label",
  // attribute-rename — @angular-eslint/template/valid-aria fires mostly on
  // misspelled/unknown aria attribute names; the per-finding snippet still lets
  // the LLM re-value when the issue is a bad value instead.
  "@angular-eslint/template/valid-aria": "attribute-rename",
  // attribute-removal — delete the offending attribute / distracting element
  "@angular-eslint/template/no-autofocus": "attribute-removal",
  "@angular-eslint/template/no-distracting-elements": "attribute-removal",
  "@angular-eslint/template/table-scope": "attribute-removal",
  // content insertion — elements-content collapses React's anchor-has-content
  // and heading-has-content into one rule; empty-anchor's "insert placeholder
  // text or aria-label" guidance is the broader, element-agnostic blurb and
  // reads correctly for anchors, buttons, and headings alike.
  "@angular-eslint/template/elements-content": "empty-anchor",
};

export function categorize(finding: Finding): FixCategory {
  const exact = RULE_ID_TO_CATEGORY[finding.ruleId];
  if (exact) return exact;

  // Fallback for axe-core runtime ids (non-jsx-a11y namespace). Use exact
  // tokens, not substrings, so unrelated rules don't accidentally match.
  const r = finding.ruleId.toLowerCase();
  if (r === "image-alt" || r === "input-image-alt" || r === "role-img-alt") {
    return "missing-alt";
  }
  if (r === "html-has-lang" || r === "html-lang-valid" || r === "valid-lang") {
    return "missing-lang";
  }
  if (r === "button-name") return "empty-button";
  if (r === "link-name") return "empty-link";
  if (r === "label" || r === "form-field-multiple-labels") return "missing-label";

  return "other";
}

export function isFixable(finding: Finding): boolean {
  return SUPPORTED_FIX_CATEGORIES.has(categorize(finding));
}
