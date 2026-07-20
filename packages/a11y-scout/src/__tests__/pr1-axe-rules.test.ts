import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeLoadedPage } from "../scanners/runtime.js";
import { MockProvider } from "../llm/mock-provider.js";
import { createPlaywrightPageDriver } from "../driver/playwright/index.js";
import type { Finding } from "../types.js";

/**
 * Regression guard for PR 1: enabling four axe-core rules that map to WCAG
 * SCs 1.3.4, 2.5.3, 2.5.8, and 1.4.6.
 *
 * `target-size` and `color-contrast-enhanced` are disabled by default in
 * axe-core; PR 1 explicitly opt-ins via `.options({ rules: { ... } })` in
 * `buildAxe()`. If a future change drops that opt-in, the AA + AAA assertions
 * below regress and name the missing rule.
 *
 * `css-orientation-lock` and `label-content-name-mismatch` are enabled by
 * default but are tagged experimental — surfacing them depends on the
 * `wcag134` / `wcag253` tags being included in TAGS_FOR_LEVEL.
 */
const fixturePath = resolve(
  fileURLToPath(import.meta.url),
  "../../__tests__/fixtures/axe/pr1-coverage.html",
);

interface ScanResult {
  findings: Finding[];
  axeRuleIds: Set<string>;
}

async function scanFixture(browser: Browser, level: "AA" | "AAA"): Promise<ScanResult> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const result = await analyzeLoadedPage({
      page: createPlaywrightPageDriver(page),
      url: `file://${fixturePath}`,
      level,
      llm: new MockProvider(),
      keyboard: false,
    });
    return {
      findings: result.findings,
      axeRuleIds: new Set(
        result.findings.filter((f) => f.source === "axe").map((f) => f.ruleId),
      ),
    };
  } finally {
    await page.close();
    await context.close();
  }
}

describe("PR1 — newly enabled axe rules surface on the dedicated fixture", () => {
  let browser: Browser;
  let aaScan: ScanResult;
  let aaaScan: ScanResult;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    aaScan = await scanFixture(browser, "AA");
    aaaScan = await scanFixture(browser, "AAA");
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  describe("at level AA", () => {
    it("flags target-size (WCAG 2.5.8)", () => {
      expect(aaScan.axeRuleIds.has("target-size")).toBe(true);
    });

    it("flags label-content-name-mismatch (WCAG 2.5.3)", () => {
      expect(aaScan.axeRuleIds.has("label-content-name-mismatch")).toBe(true);
    });

    it("flags css-orientation-lock (WCAG 1.3.4)", () => {
      expect(aaScan.axeRuleIds.has("css-orientation-lock")).toBe(true);
    });

    it("does NOT flag color-contrast-enhanced (AAA-only rule)", () => {
      // Sanity check: AAA-tagged rules must not leak into AA scans even
      // though buildAxe force-enables them.
      expect(aaScan.axeRuleIds.has("color-contrast-enhanced")).toBe(false);
    });
  });

  describe("at level AAA", () => {
    it("flags color-contrast-enhanced (WCAG 1.4.6)", () => {
      expect(aaaScan.axeRuleIds.has("color-contrast-enhanced")).toBe(true);
    });

    it("still flags the AA-level rules at AAA", () => {
      expect(aaaScan.axeRuleIds.has("target-size")).toBe(true);
      expect(aaaScan.axeRuleIds.has("label-content-name-mismatch")).toBe(true);
      expect(aaaScan.axeRuleIds.has("css-orientation-lock")).toBe(true);
    });
  });

  describe("rule → SC mapping is wired through wcag.ts", () => {
    const scFor = (scan: ScanResult, ruleId: string) =>
      scan.findings.find((f) => f.ruleId === ruleId)?.wcagSc;

    it("maps target-size to 2.5.8", () => {
      expect(scFor(aaScan, "target-size")).toBe("2.5.8");
    });

    it("maps label-content-name-mismatch to 2.5.3", () => {
      expect(scFor(aaScan, "label-content-name-mismatch")).toBe("2.5.3");
    });

    it("maps css-orientation-lock to 1.3.4", () => {
      expect(scFor(aaScan, "css-orientation-lock")).toBe("1.3.4");
    });

    it("maps color-contrast-enhanced to 1.4.6", () => {
      expect(scFor(aaaScan, "color-contrast-enhanced")).toBe("1.4.6");
    });
  });

  it("findings carry the deterministic shape (no AI flags)", () => {
    const newRuleIds = new Set([
      "target-size",
      "label-content-name-mismatch",
      "css-orientation-lock",
      "color-contrast-enhanced",
    ]);
    const newFindings = [...aaScan.findings, ...aaaScan.findings].filter((f) =>
      newRuleIds.has(f.ruleId),
    );
    expect(newFindings.length).toBeGreaterThan(0);
    // Deterministic axe findings must never claim to be AI-generated. They
    // MAY carry requiresHumanReview when axe routes a node through its
    // `incomplete` set (e.g. label-content-name-mismatch on a single-letter
    // visible label) — that's the project's incomplete-guidance pattern, not
    // an AI flag. The non-negotiable rule from CLAUDE.md only forbids the
    // pair (aiGenerated:true, requiresHumanReview:true) on non-AI findings.
    for (const f of newFindings) {
      expect(f.aiGenerated).toBe(false);
      expect(f.source).toBe("axe");
    }
  });
});
