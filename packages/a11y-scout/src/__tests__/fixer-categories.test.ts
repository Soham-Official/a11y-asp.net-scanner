import { describe, expect, it } from "vitest";
import { categorize, isFixable } from "../fixer/categories.js";
import { buildSystemPrompt } from "../fixer/fix-agent.js";
import type { Finding, FixCategory } from "../types.js";

/**
 * Minimal Finding factory for category tests. Only `ruleId` and `source`
 * affect categorization; the rest are schema-satisfying defaults.
 */
function makeFinding(
  ruleId: string,
  source: Finding["source"] = "eslint-angular-template",
): Finding {
  return {
    id: "test-id",
    wcagSc: "1.1.1",
    wcagLevel: "A",
    severity: "blocker",
    source,
    ruleId,
    title: ruleId,
    description: "test finding",
    aiGenerated: false,
    requiresHumanReview: false,
    tags: [],
    relatedRuleIds: [],
    relatedNodes: [],
  };
}

describe("fixer categories - Angular template rules", () => {
  const fixable: Array<[string, FixCategory]> = [
    ["@angular-eslint/template/alt-text", "missing-alt"],
    ["@angular-eslint/template/label-has-associated-control", "missing-label"],
    ["@angular-eslint/template/no-autofocus", "attribute-removal"],
    ["@angular-eslint/template/no-distracting-elements", "attribute-removal"],
    ["@angular-eslint/template/table-scope", "attribute-removal"],
    // Ambiguous-collapse decisions — pinned so they can't drift silently.
    ["@angular-eslint/template/valid-aria", "attribute-rename"],
    ["@angular-eslint/template/elements-content", "empty-anchor"],
  ];

  it.each(fixable)(
    "%s categorizes as %s and is fixable",
    (ruleId, expectedCategory) => {
      const finding = makeFinding(ruleId);
      expect(categorize(finding)).toBe(expectedCategory);
      expect(isFixable(finding)).toBe(true);
    },
  );

  const unfixable = [
    "@angular-eslint/template/click-events-have-key-events",
    "@angular-eslint/template/mouse-events-have-key-events",
    "@angular-eslint/template/interactive-supports-focus",
    "@angular-eslint/template/role-has-required-aria",
  ];

  it.each(unfixable)(
    "%s falls through to 'other' and is not fixable (React parity)",
    (ruleId) => {
      const finding = makeFinding(ruleId);
      expect(categorize(finding)).toBe("other");
      expect(isFixable(finding)).toBe(false);
    },
  );

  it("does not regress React jsx-a11y categorization", () => {
    expect(categorize(makeFinding("jsx-a11y/alt-text", "eslint-jsx-a11y"))).toBe(
      "missing-alt",
    );
    expect(
      categorize(makeFinding("jsx-a11y/no-autofocus", "eslint-jsx-a11y")),
    ).toBe("attribute-removal");
  });
});

describe("fixer fix-agent - framework-aware system prompt", () => {
  it("angular prompt instructs plain-HTML syntax and forbids template-breaking chars", () => {
    const prompt = buildSystemPrompt("angular");
    expect(prompt).toContain("Angular HTML template, NOT JSX");
    expect(prompt).toContain('for="id"');
    expect(prompt).toContain('tabindex="0"');
    // Inline-template guardrail must be present.
    expect(prompt).toContain("backtick");
    expect(prompt).toContain("${...}");
  });

  it("jsx prompt keeps JSX-specific syntax and no Angular block", () => {
    const prompt = buildSystemPrompt("jsx");
    expect(prompt).toContain("htmlFor");
    expect(prompt).toContain("tabIndex={5}");
    expect(prompt).not.toContain("Angular HTML template");
    expect(prompt).not.toContain("backtick");
  });
});
