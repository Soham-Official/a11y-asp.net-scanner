import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeLoadedPage } from "../scanners/runtime.js";
import { MockProvider } from "../llm/mock-provider.js";
import { createPlaywrightPageDriver } from "../driver/playwright/index.js";
import type { Finding } from "../types.js";

/**
 * Regression guard for axe-core violation coverage.
 *
 * `fixtures/axe/violations.html` deliberately breaks many common WCAG rules.
 * The list below is the set of axe rule IDs that CURRENTLY fire on that fixture
 * at level AA — captured empirically, not aspirationally. The test asserts each
 * one still fires.
 *
 * Purpose: if a future change to this package (e.g. a tweak to the axe tag
 * filter in TAGS_FOR_LEVEL, the WCAG SC mapping, or the validator dedup) were
 * to silently drop or suppress one of these rules, the corresponding assertion
 * fails and names the exact rule that regressed.
 *
 * To intentionally change the baseline (e.g. an axe-core upgrade adds/removes a
 * rule), re-run the fixture and update this list deliberately — never loosen it
 * to make a failing test pass.
 */
const EXPECTED_AXE_RULES = [
  "aria-hidden-focus",
  "aria-required-attr",
  "button-name",
  "color-contrast",
  "definition-list",
  "empty-heading",
  "empty-table-header",
  "frame-title",
  "html-has-lang",
  "image-alt",
  "input-image-alt",
  "label",
  "landmark-one-main",
  "link-name",
  "list",
  "meta-viewport",
  "page-has-heading-one",
  "region",
  "select-name",
  "tabindex",
] as const;

describe("axe-core violation regression baseline", () => {
  let browser: Browser;
  let findings: Finding[];
  let firedRuleIds: Set<string>;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    // axe-core requires an explicit BrowserContext (not the implicit one from
    // browser.newPage()), mirroring the scanner's own launchContext().
    const context = await browser.newContext();
    const page = await context.newPage();
    const fixturePath = resolve(
      fileURLToPath(import.meta.url),
      "../../__tests__/fixtures/axe/violations.html",
    );
    // keyboard:false isolates this test to axe — the keyboard scanner has its
    // own suite and would otherwise add a 2.1.2 finding here.
    // MockProvider keeps the LLM stages (content-quality, fix-html) inert so
    // this regression baseline only depends on axe.
    const result = await analyzeLoadedPage({
      page: createPlaywrightPageDriver(page),
      url: `file://${fixturePath}`,
      level: "AA",
      llm: new MockProvider(),
      keyboard: false,
    });
    findings = result.findings;
    firedRuleIds = new Set(
      findings.filter((f) => f.source === "axe").map((f) => f.ruleId),
    );
    await page.close();
  });

  afterAll(async () => {
    await browser?.close();
  });

  // One assertion per rule so a regression names the exact rule that vanished.
  for (const ruleId of EXPECTED_AXE_RULES) {
    it(`still flags axe rule: ${ruleId}`, () => {
      expect(firedRuleIds.has(ruleId)).toBe(true);
    });
  }

  it("fires at least the full baseline set of axe rules", () => {
    // Guards against a wholesale drop even if individual rule names drift.
    expect(firedRuleIds.size).toBeGreaterThanOrEqual(EXPECTED_AXE_RULES.length);
  });

  it("every axe finding carries a stable shape (ruleId, wcagSc, severity, source)", () => {
    const axeFindings = findings.filter((f) => f.source === "axe");
    expect(axeFindings.length).toBeGreaterThan(0);
    for (const f of axeFindings) {
      expect(f.ruleId).toBeTruthy();
      expect(f.wcagSc).toBeTruthy();
      expect(f.severity).toBeTruthy();
      expect(f.aiGenerated).toBe(false);
    }
  });

  it("maps key rules to their expected WCAG success criteria", () => {
    // Locks the rule→SC mapping for a few well-known rules so a wcag.ts change
    // can't silently remap them.
    const scFor = (ruleId: string) =>
      findings.find((f) => f.ruleId === ruleId)?.wcagSc;
    expect(scFor("image-alt")).toBe("1.1.1");
    expect(scFor("input-image-alt")).toBe("1.1.1");
    expect(scFor("color-contrast")).toBe("1.4.3");
    expect(scFor("html-has-lang")).toBe("3.1.1");
    // Primary SC is the highest-severity criterion in the mapping so the
    // displayed SC agrees with severity. `label` and `link-name` both map to
    // 4.1.2 (blocker) + a secondary A-level SC; 4.1.2 is primary.
    expect(scFor("label")).toBe("4.1.2");
    expect(scFor("link-name")).toBe("4.1.2");
  });

  it("enriched axe findings carry a W3C helpUrl and a deque docUrl", () => {
    // helpUrl is stamped from the WCAG catalog (W3C Understanding); docUrl keeps
    // the axe-supplied deque deep-link as a secondary developer reference.
    const withSc = findings.filter(
      (f) => f.source === "axe" && f.wcagSc !== "n/a",
    );
    expect(withSc.length).toBeGreaterThan(0);
    for (const f of withSc) {
      expect(f.helpUrl, `${f.ruleId} helpUrl`).toMatch(
        /^https:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\//,
      );
      expect(f.docUrl, `${f.ruleId} docUrl`).toMatch(/deque/i);
    }
  });

  it("blocker-bearing rules are reported as blockers, never downgraded", () => {
    // Regression guard for the `label` bug: a rule mapping to 4.1.2 must not be
    // downgraded to `severe` because a lower-severity SC was listed first.
    const sevFor = (ruleId: string) =>
      findings.find((f) => f.ruleId === ruleId)?.severity;
    if (findings.some((f) => f.ruleId === "label"))
      expect(sevFor("label")).toBe("blocker");
    if (findings.some((f) => f.ruleId === "link-name"))
      expect(sevFor("link-name")).toBe("blocker");
  });
});
