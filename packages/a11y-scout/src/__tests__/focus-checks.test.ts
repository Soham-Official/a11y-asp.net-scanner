import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FindingSchema } from "../types.js";
import {
  runKeyboardTrapChecks,
  FOCUS_OFFSCREEN_RULE_ID,
  FOCUS_INDICATOR_RULE_ID,
  MODAL_FOCUS_LEAK_RULE_ID,
} from "../scanners/keyboard.js";
import { createPlaywrightPageDriver } from "../driver/playwright/index.js";

// Phase-2 focus checks (off-screen focus 2.4.3, focus-indicator 2.4.7, modal
// leak 2.4.3/2.1.2). All are deterministic runtime probes — zero LLM, zero
// network — so they run identically with A11Y_HAIP_MOCK=1.
//
// The tier-1 (style-delta) and Points 1/3 assertions are CI-safe and run
// always. The tier-2 SCREENSHOT cases are render/font-flaky and slow; they are
// gated behind A11Y_FOCUS_SHOT_TESTS=1 and excluded from `npm run smoke`.
const RUN_SHOT_TESTS = process.env.A11Y_FOCUS_SHOT_TESTS === "1";

describe("Phase-2 focus checks", () => {
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

  function findingsFor(
    findings: { ruleId: string }[],
    ruleId: string,
  ): { ruleId: string }[] {
    return findings.filter((f) => f.ruleId === ruleId);
  }

  // ===========================================================================
  // Point 3 — modal focus leak
  // ===========================================================================

  it("flags an aria-modal=true leak as severe (catalog 2.4.3)", async () => {
    const page = await loadFixture("modal-leak-aria.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
    });
    const leaks = result.findings.filter(
      (f) => f.ruleId === MODAL_FOCUS_LEAK_RULE_ID,
    );
    expect(leaks.length).toBe(1);
    const leak = leaks[0]!;
    // Severity is now catalog-driven for 2.4.3 (severe) for all modal leaks;
    // an author-declared modal (aria-modal=true) is still a hard finding.
    expect(leak.severity).toBe("severe");
    expect(leak.requiresHumanReview).toBe(false);
    expect(leak.wcagSc).toBe("2.4.3");
    expect(leak.aiGenerated).toBe(false);
    expect(leak.modalLeakEvidence?.modalKind).toBe("modal-true");
    expect(leak.modalLeakEvidence?.leakedToSelector).toBeTruthy();
    await page.close();
  });

  it("does not false-positive on a top-layer modal (browser enforces containment)", async () => {
    // A real showModal() dialog makes the background inert, so focus physically
    // cannot leak even with a buggy handler. The dialog-modal blocker branch is
    // defensive; here we assert no false positive.
    const page = await loadFixture("modal-leak-showmodal.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
    });
    expect(findingsFor(result.findings, MODAL_FOCUS_LEAK_RULE_ID).length).toBe(0);
    await page.close();
  });

  it("flags a bare role=dialog leak as severe but requiring human review", async () => {
    const page = await loadFixture("modal-leak-bare-dialog.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
    });
    const leaks = result.findings.filter(
      (f) => f.ruleId === MODAL_FOCUS_LEAK_RULE_ID,
    );
    expect(leaks.length).toBe(1);
    // Severity is catalog-driven (2.4.3 → severe) for all modal leaks; a bare
    // role="dialog" may be intentionally non-modal, so it still requires review.
    expect(leaks[0]!.severity).toBe("severe");
    expect(leaks[0]!.requiresHumanReview).toBe(true);
    expect(leaks[0]!.modalLeakEvidence?.modalKind).toBe("role-dialog");
    await page.close();
  });

  it("does not flag a properly focus-trapped modal", async () => {
    const page = await loadFixture("modal-no-leak.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
    });
    expect(findingsFor(result.findings, MODAL_FOCUS_LEAK_RULE_ID).length).toBe(0);
    await page.close();
  });

  it("does not flag focus moving into a nested descendant dialog", async () => {
    const page = await loadFixture("modal-nested-dialog.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
    });
    expect(findingsFor(result.findings, MODAL_FOCUS_LEAK_RULE_ID).length).toBe(0);
    await page.close();
  });

  // ===========================================================================
  // Point 1 — off-screen / invisible focus
  // ===========================================================================

  it("flags an off-screen focus target that scrollIntoView cannot recover", async () => {
    const page = await loadFixture("focus-offscreen.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
    });
    const offscreen = result.findings.filter(
      (f) => f.ruleId === FOCUS_OFFSCREEN_RULE_ID,
    );
    expect(offscreen.length).toBeGreaterThanOrEqual(1);
    const f = offscreen.find(
      (x) => x.focusVisibilityEvidence?.reason === "offscreen",
    );
    expect(f).toBeTruthy();
    expect(f!.severity).toBe("severe");
    expect(f!.wcagSc).toBe("2.4.3");
    expect(f!.focusVisibilityEvidence?.scrolledIntoViewFailed).toBe(true);
    await page.close();
  });

  it("flags an opacity:0 focus target", async () => {
    const page = await loadFixture("focus-opacity-zero.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
    });
    const offscreen = result.findings.filter(
      (f) => f.ruleId === FOCUS_OFFSCREEN_RULE_ID,
    );
    expect(
      offscreen.some((x) => x.focusVisibilityEvidence?.reason === "opacity-zero"),
    ).toBe(true);
    await page.close();
  });

  it("flags a zero-area focus target", async () => {
    const page = await loadFixture("focus-zero-area.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
    });
    const offscreen = result.findings.filter(
      (f) => f.ruleId === FOCUS_OFFSCREEN_RULE_ID,
    );
    expect(
      offscreen.some((x) => x.focusVisibilityEvidence?.reason === "zero-area"),
    ).toBe(true);
    await page.close();
  });

  it("does not flag a skip link that becomes visible on focus", async () => {
    const page = await loadFixture("focus-skiplink.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
    });
    expect(findingsFor(result.findings, FOCUS_OFFSCREEN_RULE_ID).length).toBe(0);
    await page.close();
  });

  it("does not flag below-the-fold focus that scrollIntoView recovers", async () => {
    const page = await loadFixture("focus-offscreen-recoverable.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
    });
    expect(findingsFor(result.findings, FOCUS_OFFSCREEN_RULE_ID).length).toBe(0);
    await page.close();
  });

  // ===========================================================================
  // Point 2 — focus indicator (tier-1 gating + crawl summary)
  // ===========================================================================

  it("emits no focus-indicator findings at level A (AA-only gate)", async () => {
    const page = await loadFixture("focus-no-indicator.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "A",
    });
    expect(findingsFor(result.findings, FOCUS_INDICATOR_RULE_ID).length).toBe(0);
    await page.close();
  });

  it("does not flag an element with a clear outline (tier-1 sees a delta)", async () => {
    const page = await loadFixture("focus-good-outline.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
    });
    expect(findingsFor(result.findings, FOCUS_INDICATOR_RULE_ID).length).toBe(0);
    await page.close();
  });

  it("emits ONE per-page summary under crawl when indicators are missing", async () => {
    const page = await loadFixture("focus-no-indicator.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
      inCrawl: true,
    });
    const indicator = result.findings.filter(
      (f) => f.ruleId === FOCUS_INDICATOR_RULE_ID,
    );
    expect(indicator.length).toBe(1);
    expect(indicator[0]!.severity).toBe("review");
    expect(indicator[0]!.requiresHumanReview).toBe(true);
    expect(indicator[0]!.focusIndicatorEvidence?.verification).toBe(
      "style-delta-only",
    );
    expect(
      indicator[0]!.focusIndicatorEvidence?.candidateCount,
    ).toBeGreaterThanOrEqual(1);
    await page.close();
  });

  // ===========================================================================
  // Threading + schema
  // ===========================================================================

  it("runs NO Phase-2 checks when focusChecks is false (traps only)", async () => {
    const page = await loadFixture("modal-leak-aria.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
      focusChecks: false,
    });
    expect(findingsFor(result.findings, MODAL_FOCUS_LEAK_RULE_ID).length).toBe(0);
    expect(findingsFor(result.findings, FOCUS_OFFSCREEN_RULE_ID).length).toBe(0);
    expect(findingsFor(result.findings, FOCUS_INDICATOR_RULE_ID).length).toBe(0);
    await page.close();
  });

  it("produces schema-valid findings for every Phase-2 evidence shape", async () => {
    // Modal leak (modalLeakEvidence) + off-screen (focusVisibilityEvidence).
    for (const fixture of ["modal-leak-aria.html", "focus-zero-area.html"]) {
      const page = await loadFixture(fixture);
      const result = await runKeyboardTrapChecks({
        page: createPlaywrightPageDriver(page),
        url: page.url(),
        level: "AA",
      });
      for (const f of result.findings) {
        expect(FindingSchema.safeParse(f).success).toBe(true);
      }
      await page.close();
    }
    // Focus-indicator crawl summary (focusIndicatorEvidence).
    const page = await loadFixture("focus-no-indicator.html");
    const result = await runKeyboardTrapChecks({
      page: createPlaywrightPageDriver(page),
      url: page.url(),
      level: "AA",
      inCrawl: true,
    });
    for (const f of result.findings) {
      expect(FindingSchema.safeParse(f).success).toBe(true);
    }
    await page.close();
  });

  // ===========================================================================
  // Tier-2 screenshot verification — GATED (flaky/slow; not in CI / smoke).
  // ===========================================================================

  describe.skipIf(!RUN_SHOT_TESTS)("tier-2 screenshot verification", () => {
    it("flags a button with no focus indicator (screenshot-verified)", async () => {
      const page = await loadFixture("focus-no-indicator.html");
      const result = await runKeyboardTrapChecks({
        page: createPlaywrightPageDriver(page),
        url: page.url(),
        level: "AA",
      });
      const indicator = result.findings.filter(
        (f) => f.ruleId === FOCUS_INDICATOR_RULE_ID,
      );
      expect(indicator.length).toBeGreaterThanOrEqual(1);
      expect(indicator[0]!.focusIndicatorEvidence?.verification).toBe(
        "screenshot-verified",
      );
      await page.close();
    });

    it("suppresses a pseudo-element focus indicator (tier-2 save)", async () => {
      const page = await loadFixture("focus-pseudo-indicator.html");
      const result = await runKeyboardTrapChecks({
        page: createPlaywrightPageDriver(page),
        url: page.url(),
        level: "AA",
      });
      expect(
        result.findings.filter((f) => f.ruleId === FOCUS_INDICATOR_RULE_ID)
          .length,
      ).toBe(0);
      await page.close();
    });

    it("suppresses an SVG focus indicator (tier-2 save)", async () => {
      const page = await loadFixture("focus-svg-indicator.html");
      const result = await runKeyboardTrapChecks({
        page: createPlaywrightPageDriver(page),
        url: page.url(),
        level: "AA",
      });
      expect(
        result.findings.filter((f) => f.ruleId === FOCUS_INDICATOR_RULE_ID)
          .length,
      ).toBe(0);
      await page.close();
    });
  });
});
