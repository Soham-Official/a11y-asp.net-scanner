import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FindingSchema } from "../types.js";
import {
  runKeyboardTrapChecks,
  FOCUS_ORDER_RULE_ID,
} from "../scanners/keyboard.js";
import { createPlaywrightPageDriver } from "../driver/playwright/index.js";

// Point 4 — geometric tab-order divergence (2.4.3, review-only). Deterministic,
// offline, screenshot-free; runs identically under A11Y_HAIP_MOCK=1.
describe("Point 4 — tab-order divergence", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function loadFixture(filename: string): Promise<Page> {
    const page = await browser.newPage();
    const fixturePath = resolve(
      fileURLToPath(import.meta.url),
      "../../__tests__/fixtures/keyboard",
      filename,
    );
    await page.goto(`file://${fixturePath}`, { waitUntil: "load" });
    await page.waitForTimeout(200);
    return page;
  }

  function orderFindings(findings: { ruleId: string }[]) {
    return findings.filter((f) => f.ruleId === FOCUS_ORDER_RULE_ID);
  }

  it("fires ONE review finding when tab order diverges from both dom and visual", async () => {
    const page = await loadFixture("focus-order-divergent.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
    });
    const hits = orderFindings(result.findings);
    expect(hits.length).toBe(1);
    const f = hits[0]!;
    expect(f.severity).toBe("review");
    expect(f.requiresHumanReview).toBe(true);
    expect(f.aiGenerated).toBe(false);
    expect(f.wcagSc).toBe("2.4.3");
    expect(f.focusOrderEvidence?.reliable).toBe(true);
    expect(f.focusOrderEvidence?.elementCount).toBeGreaterThanOrEqual(6);
    expect(f.focusOrderEvidence?.tauTabVsVisual ?? 0).toBeGreaterThan(0.3);
    expect(f.focusOrderEvidence?.tauTabVsDom ?? 0).toBeGreaterThan(0.2);
    expect(FindingSchema.safeParse(f).success).toBe(true);
    await page.close();
  });

  it("stays silent on a flexbox row-reverse layout (tab follows dom)", async () => {
    const page = await loadFixture("focus-order-flex-reverse.html");
    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url: page.url(), level: "AA" });
    expect(orderFindings(result.findings).length).toBe(0);
    await page.close();
  });

  it("stays silent on a CSS grid column-flow layout", async () => {
    const page = await loadFixture("focus-order-grid.html");
    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url: page.url(), level: "AA" });
    expect(orderFindings(result.findings).length).toBe(0);
    await page.close();
  });

  it("stays silent on a correct RTL layout", async () => {
    const page = await loadFixture("focus-order-rtl.html");
    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url: page.url(), level: "AA" });
    expect(orderFindings(result.findings).length).toBe(0);
    await page.close();
  });

  it("stays silent with a sticky header layout", async () => {
    const page = await loadFixture("focus-order-sticky.html");
    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url: page.url(), level: "AA" });
    expect(orderFindings(result.findings).length).toBe(0);
    await page.close();
  });

  it("stays silent below the minimum element count", async () => {
    const page = await loadFixture("focus-order-too-few.html");
    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url: page.url(), level: "AA" });
    expect(orderFindings(result.findings).length).toBe(0);
    await page.close();
  });

  it("runs at level A too (focus order is a Level A criterion)", async () => {
    // Unlike the focus-indicator check, Point 4 is 2.4.3 (Level A) and is NOT
    // gated behind AA. It should still fire at level A.
    const page = await loadFixture("focus-order-divergent.html");
    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url: page.url(), level: "A" });
    expect(orderFindings(result.findings).length).toBe(1);
    await page.close();
  });

  it("does not run when focusChecks is disabled", async () => {
    const page = await loadFixture("focus-order-divergent.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
      focusChecks: false,
    });
    expect(orderFindings(result.findings).length).toBe(0);
    await page.close();
  });
});
