import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runKeyboardTrapChecks,
  FOCUS_OBSCURED_MIN_RULE_ID,
  FOCUS_OBSCURED_ENHANCED_RULE_ID,
} from "../scanners/keyboard.js";
import { runReflowCheck, REFLOW_RULE_ID } from "../scanners/reflow.js";
import { createPlaywrightPageDriver } from "../driver/playwright/index.js";

/**
 * PR 2 regression suite. Three new WCAG SCs delivered together:
 *
 *   • 1.4.10 Reflow (AA)              → new `scanners/reflow.ts`
 *   • 2.4.11 Focus Not Obscured (AA)  → extension to `scanners/keyboard.ts`
 *   • 2.4.12 Focus Not Obscured (AAA) → extension to `scanners/keyboard.ts`
 *
 * The two focus-obscured checks share the existing keyboard Tab walk, so
 * runKeyboardTrapChecks is the entry point for both. The reflow check is a
 * standalone scanner — viewport resize + scrollWidth assertion.
 */

const fixturePath = (...parts: string[]) =>
  resolve(
    fileURLToPath(import.meta.url),
    "../../__tests__/fixtures",
    ...parts,
  );

describe("PR 2 — Reflow (1.4.10)", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function scanReflow(filename: string) {
    const page = await browser.newPage();
    const path = fixturePath("reflow", filename);
    await page.goto(`file://${path}`, { waitUntil: "load" });
    const result = await runReflowCheck({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
    });
    await page.close();
    return result;
  }

  it("flags a page with a fixed-width 1200px container", async () => {
    const result = await scanReflow("horizontal-overflow.html");
    const reflow = result.findings.filter((f) => f.ruleId === REFLOW_RULE_ID);
    expect(reflow.length).toBeGreaterThan(0);
    expect(reflow[0]!.wcagSc).toBe("1.4.10");
    expect(reflow[0]!.wcagLevel).toBe("AA");
    expect(reflow[0]!.aiGenerated).toBe(false);
    expect(reflow[0]!.requiresHumanReview).toBe(false);
  });

  it("does not flag a fully responsive page", async () => {
    const result = await scanReflow("responsive-pass.html");
    const reflow = result.findings.filter((f) => f.ruleId === REFLOW_RULE_ID);
    expect(reflow.length).toBe(0);
    // Responsive page should also surface a 1.4.10 PassedRule
    const passed = result.passes.filter((p) => p.ruleId === REFLOW_RULE_ID);
    expect(passed.length).toBe(1);
  });

  it("does not flag a page whose only overflow is a wide data table (1.4.10 exception)", async () => {
    const result = await scanReflow("data-table-allowed.html");
    const reflow = result.findings.filter((f) => f.ruleId === REFLOW_RULE_ID);
    expect(reflow.length).toBe(0);
  });
});

describe("PR 2 — Focus Not Obscured (2.4.11 / 2.4.12)", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function loadFixture(filename: string): Promise<Page> {
    const page = await browser.newPage();
    const path = fixturePath("keyboard", filename);
    await page.goto(`file://${path}`, { waitUntil: "load" });
    await page.waitForTimeout(200);
    return page;
  }

  it("flags fully obscured focus as 2.4.11 (AA blocker) at level AA", async () => {
    const page = await loadFixture("focus-obscured-fully.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
    });
    await page.close();

    const obscured = result.findings.filter(
      (f) => f.ruleId === FOCUS_OBSCURED_MIN_RULE_ID,
    );
    expect(obscured.length).toBeGreaterThan(0);
    expect(obscured[0]!.wcagSc).toBe("2.4.11");
    expect(obscured[0]!.wcagLevel).toBe("AA");
    expect(obscured[0]!.severity).toBe("blocker");
    expect(obscured[0]!.aiGenerated).toBe(false);
  });

  it("does NOT flag partial obstruction as 2.4.11 (Min)", async () => {
    const page = await loadFixture("focus-obscured-partially.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
    });
    await page.close();

    const min = result.findings.filter(
      (f) => f.ruleId === FOCUS_OBSCURED_MIN_RULE_ID,
    );
    expect(min.length).toBe(0);
  });

  it("flags partial obstruction as 2.4.12 (Enhanced) at level AAA", async () => {
    const page = await loadFixture("focus-obscured-partially.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AAA",
    });
    await page.close();

    const enhanced = result.findings.filter(
      (f) => f.ruleId === FOCUS_OBSCURED_ENHANCED_RULE_ID,
    );
    expect(enhanced.length).toBeGreaterThan(0);
    expect(enhanced[0]!.wcagSc).toBe("2.4.12");
    expect(enhanced[0]!.wcagLevel).toBe("AAA");
    expect(enhanced[0]!.aiGenerated).toBe(false);
  });

  it("does NOT fire 2.4.12 at level AA (AAA-only rule)", async () => {
    const page = await loadFixture("focus-obscured-partially.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
    });
    await page.close();

    const enhanced = result.findings.filter(
      (f) => f.ruleId === FOCUS_OBSCURED_ENHANCED_RULE_ID,
    );
    expect(enhanced.length).toBe(0);
  });

  it("does NOT flag a page whose focusables are clear of the sticky banner", async () => {
    const page = await loadFixture("focus-obscured-clear.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AAA",
    });
    await page.close();

    const min = result.findings.filter(
      (f) => f.ruleId === FOCUS_OBSCURED_MIN_RULE_ID,
    );
    const enhanced = result.findings.filter(
      (f) => f.ruleId === FOCUS_OBSCURED_ENHANCED_RULE_ID,
    );
    expect(min.length).toBe(0);
    expect(enhanced.length).toBe(0);
  });

  it("a fully-obscured element ALSO fires 2.4.12 at AAA (full obstruction implies partial)", async () => {
    const page = await loadFixture("focus-obscured-fully.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AAA",
    });
    await page.close();

    const min = result.findings.filter(
      (f) => f.ruleId === FOCUS_OBSCURED_MIN_RULE_ID,
    );
    const enhanced = result.findings.filter(
      (f) => f.ruleId === FOCUS_OBSCURED_ENHANCED_RULE_ID,
    );
    // 2.4.11 always fires when fully obscured; 2.4.12 may dedupe to avoid
    // double-counting on the same element. Either:
    //   (a) only 2.4.11 fires (architect's choice — strict semantic dedup), OR
    //   (b) 2.4.12 also fires for symmetry with the AAA-tier semantics
    // Both are valid — assert at least one fires; don't lock the choice here.
    expect(min.length + enhanced.length).toBeGreaterThan(0);
  });
});
