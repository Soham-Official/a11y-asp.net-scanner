#!/usr/bin/env node
/**
 * Audit script to compare axe-core's built-in WCAG tag metadata against our
 * manual mappings. Identifies:
 * - Rules missing from our map that have WCAG tags in axe-core
 * - Rules where our map disagrees with axe-core's tags
 * - Best-practice rules that we assign to WCAG criteria
 */

import axe from "axe-core";

// Extract WCAG SC from axe-core tag format (e.g., "wcag412" → "4.1.2")
function extractAllScFromTags(tags: string[]): string[] {
  const scIds: string[] = [];
  for (const t of tags) {
    const m = /^wcag(\d)(\d{2,})$/.exec(t);
    if (m) {
      const [, a, b] = m;
      if (b && b.length >= 2) {
        const major = a;
        const middle = b.slice(0, 1);
        const last = b.slice(1);
        scIds.push(`${major}.${middle}.${Number(last)}`);
      }
    }
  }
  return scIds;
}

// Current manual map from wcag.ts (will be replaced by override-only map)
const currentAxeRuleToScMap: Record<string, string[]> = {
  "image-alt": ["1.1.1"],
  "input-image-alt": ["1.1.1"],
  "area-alt": ["1.1.1"],
  "object-alt": ["1.1.1"],
  "svg-img-alt": ["1.1.1"],
  "role-img-alt": ["1.1.1"],
  "aria-allowed-attr": ["4.1.2"],
  "aria-hidden-body": ["4.1.2"],
  "aria-hidden-focus": ["4.1.2"],
  "aria-required-attr": ["4.1.2"],
  "aria-required-children": ["1.3.1"],
  "aria-required-parent": ["1.3.1"],
  "aria-roles": ["4.1.2"],
  "aria-valid-attr": ["4.1.2"],
  "aria-valid-attr-value": ["4.1.2"],
  "aria-input-field-name": ["4.1.2"],
  "aria-toggle-field-name": ["4.1.2"],
  "aria-command-name": ["4.1.2"],
  "aria-tooltip-name": ["4.1.2"],
  "color-contrast": ["1.4.3"],
  "color-contrast-enhanced": ["1.4.6"],
  "document-title": ["2.4.2"],
  "duplicate-id-aria": ["4.1.1"],
  "frame-title": ["2.4.1", "4.1.2"],
  "html-has-lang": ["3.1.1"],
  "html-lang-valid": ["3.1.1"],
  "html-xml-lang-mismatch": ["3.1.1"],
  label: ["3.3.2", "4.1.2"],
  "label-title-only": ["3.3.2"],
  "form-field-multiple-labels": ["3.3.2"],
  "link-name": ["2.4.4", "4.1.2"],
  "button-name": ["4.1.2"],
  list: ["1.3.1"],
  listitem: ["1.3.1"],
  "definition-list": ["1.3.1"],
  dlitem: ["1.3.1"],
  region: ["1.3.1"],
  "page-has-heading-one": ["1.3.1", "2.4.6"],
  "heading-order": ["1.3.1", "2.4.6"],
  "empty-heading": ["2.4.6"],
  "landmark-one-main": ["1.3.1"],
  "landmark-unique": ["1.3.1"],
  "scrollable-region-focusable": ["2.1.1"],
  "skip-link": ["2.4.1"],
  bypass: ["2.4.1"],
  tabindex: ["4.1.2"],
};

interface AuditResult {
  ruleId: string;
  axeTags: string[];
  axeScIds: string[];
  ourScIds: string[];
  status: "match" | "override-needed" | "best-practice-assignment" | "missing";
  reason?: string;
}

function main() {
  const rules = axe.getRules();
  const results: AuditResult[] = [];

  console.log(`\n📊 Auditing ${rules.length} axe-core rules...\n`);

  for (const rule of rules) {
    const axeScIds = extractAllScFromTags(rule.tags);
    const ourScIds = currentAxeRuleToScMap[rule.ruleId] ?? [];
    const isBestPracticeOnly =
      rule.tags.includes("best-practice") && axeScIds.length === 0;

    let status: AuditResult["status"];
    let reason: string | undefined;

    if (ourScIds.length === 0 && axeScIds.length > 0) {
      status = "missing";
      reason = `axe-core provides ${axeScIds.join(", ")} but we have no mapping`;
    } else if (ourScIds.length > 0 && axeScIds.length === 0) {
      status = "best-practice-assignment";
      reason = `We assign ${ourScIds.join(", ")} to a best-practice rule`;
    } else if (ourScIds.length > 0 && axeScIds.length > 0) {
      const match =
        ourScIds.length === axeScIds.length &&
        ourScIds.every((sc) => axeScIds.includes(sc));
      if (match) {
        status = "match";
      } else {
        status = "override-needed";
        reason = `Our ${ourScIds.join(", ")} disagrees with axe's ${axeScIds.join(", ")}`;
      }
    } else {
      status = "match"; // Both empty
    }

    results.push({
      ruleId: rule.ruleId,
      axeTags: rule.tags,
      axeScIds,
      ourScIds,
      status,
      reason,
    });
  }

  // Summary
  const missing = results.filter((r) => r.status === "missing");
  const overrides = results.filter((r) => r.status === "override-needed");
  const bestPractice = results.filter(
    (r) => r.status === "best-practice-assignment",
  );
  const matches = results.filter((r) => r.status === "match");

  console.log("📈 Summary:");
  console.log(`  ✅ Matches (redundant): ${matches.length}`);
  console.log(`  ❌ Missing from our map: ${missing.length}`);
  console.log(`  ⚠️  Overrides needed: ${overrides.length}`);
  console.log(`  📝 Best-practice assignments: ${bestPractice.length}`);
  console.log();

  if (missing.length > 0) {
    console.log("❌ Missing mappings (axe-core has WCAG tags, we don't):");
    missing.forEach((r) => {
      console.log(
        `  - ${r.ruleId.padEnd(40)} → ${r.axeScIds.join(", ")}`,
      );
    });
    console.log();
  }

  if (overrides.length > 0) {
    console.log("⚠️  Override candidates (disagreements with axe-core):");
    overrides.forEach((r) => {
      console.log(`  - ${r.ruleId.padEnd(40)} ${r.reason}`);
    });
    console.log();
  }

  if (bestPractice.length > 0) {
    console.log("📝 Best-practice assignments (our editorial additions):");
    bestPractice.forEach((r) => {
      console.log(`  - ${r.ruleId.padEnd(40)} → ${r.ourScIds.join(", ")}`);
    });
    console.log();
  }

  // Identify key overrides to keep
  console.log("🎯 Recommended overrides to preserve (with rationale needed):");
  overrides.forEach((r) => {
    console.log(`  "${r.ruleId}": [${r.ourScIds.map((s) => `"${s}"`).join(", ")}],  // ${r.reason}`);
  });
  console.log();
}

main();
