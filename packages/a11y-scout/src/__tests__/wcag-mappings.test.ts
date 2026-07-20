import { describe, it, expect } from "vitest";
import axe from "axe-core";
import {
  WCAG_CATALOG,
  SEVERITY_RANK,
  getCriterion,
  severityForSc,
  severityForScList,
  scIdsForAxeRule,
  scIdsForEslintRule,
  scIdsForAngularTemplateRule,
  extractAllScFromTags,
  understandingUrlForSc,
  enrichFinding,
  ANGULAR_TEMPLATE_RULE_IDS,
} from "../wcag.js";
import type { Finding } from "../types.js";

const UNDERSTANDING_BASE = "https://www.w3.org/WAI/WCAG22/Understanding";

/** A real slug URL is the base + a non-numeric slug (not the bare SC id). */
function isRealSlugUrl(sc: string): boolean {
  const url = understandingUrlForSc(sc);
  return url === `${UNDERSTANDING_BASE}/${sc}` ? false : url.startsWith(`${UNDERSTANDING_BASE}/`);
}

// SCs the LLM agents are allowed to emit (kept explicit so a change in the
// agents' allowlists is caught here). Mirrors content-quality SC_LEVEL keys +
// the aaa-semantic prompt set.
const CONTENT_QUALITY_SCS = [
  "1.1.1", "1.3.3", "2.4.2", "2.4.4", "2.5.3", "3.3.1",
  "3.3.2", "1.3.5", "2.4.6", "3.1.2", "3.3.3",
];
const AAA_SCS = ["2.4.9", "2.4.10", "3.1.3", "3.1.4", "3.1.5", "3.3.5"];

// Every jsx-a11y rule we map, mirrored from wcag.ts. Kept explicit (rather than
// importing the private map) so a rename in the source map is caught here.
const ESLINT_RULES = [
  "jsx-a11y/accessible-emoji",
  "jsx-a11y/alt-text",
  "jsx-a11y/anchor-ambiguous-text",
  "jsx-a11y/anchor-has-content",
  "jsx-a11y/anchor-is-valid",
  "jsx-a11y/aria-activedescendant-has-tabindex",
  "jsx-a11y/aria-props",
  "jsx-a11y/aria-proptypes",
  "jsx-a11y/aria-role",
  "jsx-a11y/aria-unsupported-elements",
  "jsx-a11y/autocomplete-valid",
  "jsx-a11y/click-events-have-key-events",
  "jsx-a11y/control-has-associated-label",
  "jsx-a11y/heading-has-content",
  "jsx-a11y/html-has-lang",
  "jsx-a11y/iframe-has-title",
  "jsx-a11y/img-redundant-alt",
  "jsx-a11y/interactive-supports-focus",
  "jsx-a11y/label-has-associated-control",
  "jsx-a11y/label-has-for",
  "jsx-a11y/lang",
  "jsx-a11y/media-has-caption",
  "jsx-a11y/mouse-events-have-key-events",
  "jsx-a11y/no-access-key",
  "jsx-a11y/no-aria-hidden-on-focusable",
  "jsx-a11y/no-autofocus",
  "jsx-a11y/no-distracting-elements",
  "jsx-a11y/no-interactive-element-to-noninteractive-role",
  "jsx-a11y/no-noninteractive-element-interactions",
  "jsx-a11y/no-noninteractive-element-to-interactive-role",
  "jsx-a11y/no-noninteractive-tabindex",
  "jsx-a11y/no-onchange",
  "jsx-a11y/no-redundant-roles",
  "jsx-a11y/no-static-element-interactions",
  "jsx-a11y/prefer-tag-over-role",
  "jsx-a11y/role-has-required-aria-props",
  "jsx-a11y/role-supports-aria-props",
  "jsx-a11y/scope",
  "jsx-a11y/tabindex-no-positive",
];

/** All (source, ruleId, scIds) tuples our resolvers can produce. */
function allMappings(): Array<{ source: string; ruleId: string; scIds: string[] }> {
  const out: Array<{ source: string; ruleId: string; scIds: string[] }> = [];
  for (const rule of axe.getRules())
    out.push({
      source: "axe",
      ruleId: rule.ruleId,
      scIds: scIdsForAxeRule(rule.ruleId, rule.tags),
    });
  for (const r of ESLINT_RULES)
    out.push({ source: "eslint", ruleId: r, scIds: scIdsForEslintRule(r) });
  for (const r of ANGULAR_TEMPLATE_RULE_IDS)
    out.push({
      source: "angular",
      ruleId: r,
      scIds: scIdsForAngularTemplateRule(r),
    });
  return out.filter((m) => m.scIds.length > 0);
}

describe("wcag.ts mapping integrity", () => {
  it("every mapped SC exists in WCAG_CATALOG", () => {
    const missing: string[] = [];
    for (const { source, ruleId, scIds } of allMappings())
      for (const sc of scIds)
        if (!getCriterion(sc)) missing.push(`[${source}] ${ruleId} → ${sc}`);
    expect(missing, `SCs not in catalog:\n${missing.join("\n")}`).toEqual([]);
  });

  it("primary SC (scIds[0]) is the highest-severity SC — no ordering downgrade", () => {
    const offenders: string[] = [];
    for (const { source, ruleId, scIds } of allMappings()) {
      const sevs = scIds
        .map((sc) => {
          const c = getCriterion(sc);
          return c ? SEVERITY_RANK[severityForSc(sc, c.level)]! : 0;
        })
        .filter((n) => n > 0);
      if (sevs.length < 2) continue;
      if (sevs[0]! < Math.max(...sevs))
        offenders.push(`[${source}] ${ruleId} → [${scIds.join(", ")}]`);
    }
    expect(
      offenders,
      `primary SC is not highest-severity (downgrade risk):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("severityForScList returns the max severity across all mapped SCs", () => {
    // 3.3.2 (severe) + 4.1.2 (blocker) → blocker, regardless of order.
    expect(severityForScList(["3.3.2", "4.1.2"])).toBe("blocker");
    expect(severityForScList(["4.1.2", "3.3.2"])).toBe("blocker");
    expect(severityForScList(["2.4.6"])).toBe("major");
    expect(severityForScList(["9.9.9"])).toBeUndefined();
  });

  it("every axe rule with a WCAG tag resolves to at least one catalog SC", () => {
    const dropped: string[] = [];
    for (const rule of axe.getRules()) {
      if (extractAllScFromTags(rule.tags).length === 0) continue;
      const resolved = scIdsForAxeRule(rule.ruleId, rule.tags);
      if (!resolved.some((sc) => getCriterion(sc)))
        dropped.push(`${rule.ruleId} (tags: ${rule.tags.join(",")})`);
    }
    expect(
      dropped,
      `axe rules whose WCAG SCs are all missing from catalog:\n${dropped.join("\n")}`,
    ).toEqual([]);
  });

  it("catalog defaultSeverity matches severityForSc for every criterion", () => {
    for (const c of WCAG_CATALOG)
      expect(severityForSc(c.id, c.level), `${c.id}`).toBe(c.defaultSeverity);
  });

  it("every catalog entry resolves to a real (non-bare-SC) slug URL", () => {
    const bare: string[] = [];
    for (const c of WCAG_CATALOG) if (!isRealSlugUrl(c.id)) bare.push(c.id);
    expect(bare, `catalog SCs with no slug (bare-SC URL):\n${bare.join("\n")}`).toEqual([]);
  });

  it("every catalog url is derived from its slug", () => {
    for (const c of WCAG_CATALOG)
      expect(c.url, `${c.id}`).toBe(`${UNDERSTANDING_BASE}/${c.slug}`);
  });

  it("every emittable SC resolves to a catalog entry AND a real slug", () => {
    const emittable = new Set<string>([...CONTENT_QUALITY_SCS, ...AAA_SCS]);
    for (const { scIds } of allMappings())
      for (const sc of scIds) emittable.add(sc);

    const bad: string[] = [];
    for (const sc of emittable) {
      if (!getCriterion(sc)) bad.push(`${sc} (not in catalog)`);
      else if (!isRealSlugUrl(sc)) bad.push(`${sc} (bare-SC URL)`);
    }
    expect(bad, `emittable SCs missing catalog/slug:\n${bad.join("\n")}`).toEqual([]);
  });
});

describe("enrichFinding", () => {
  function baseFinding(overrides: Partial<Finding>): Finding {
    return {
      id: "test",
      wcagSc: "1.1.1",
      wcagLevel: "AA",
      severity: "major",
      source: "axe",
      ruleId: "test-rule",
      title: "t",
      description: "d",
      aiGenerated: false,
      requiresHumanReview: false,
      tags: [],
      relatedRuleIds: [],
      relatedNodes: [],
      ...overrides,
    };
  }

  it("sets helpUrl to the W3C Understanding URL for the SC", () => {
    const f = enrichFinding(baseFinding({ wcagSc: "1.1.1", helpUrl: undefined }));
    expect(f.helpUrl).toBe(`${UNDERSTANDING_BASE}/non-text-content`);
  });

  it("leaves docUrl exactly as passed in (never touches it)", () => {
    const docUrl = "https://dequeuniversity.com/rules/axe/4.9/label";
    const f = enrichFinding(baseFinding({ wcagSc: "4.1.2", docUrl }));
    expect(f.docUrl).toBe(docUrl);
  });

  it("never mutates severity, even when the primary SC is lower-severity", () => {
    // 4.1.2 (label) is a blocker; wcagSc points at 3.3.2 (severe). A naive
    // recompute from the primary SC would downgrade to severe — assert it does not.
    const f = enrichFinding(
      baseFinding({ wcagSc: "3.3.2", severity: "blocker" }),
    );
    expect(f.severity).toBe("blocker");
  });

  it("sets wcagLevel from the catalog", () => {
    const f = enrichFinding(baseFinding({ wcagSc: "1.3.5", wcagLevel: "A" }));
    expect(f.wcagLevel).toBe("AA"); // 1.3.5 is AA in the catalog
  });

  it("is idempotent", () => {
    const once = enrichFinding(baseFinding({ wcagSc: "2.4.3" }));
    const twice = enrichFinding(once);
    expect(twice).toEqual(once);
  });

  it("leaves a finding whose SC is not in the catalog untouched", () => {
    const f = enrichFinding(baseFinding({ wcagSc: "9.9.9", helpUrl: "orig" }));
    expect(f.helpUrl).toBe("orig");
  });
});
