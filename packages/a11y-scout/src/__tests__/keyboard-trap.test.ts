import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FindingSchema } from "../types.js";
import {
  runKeyboardTrapChecks,
  KEYBOARD_TRAP_RULE_ID,
} from "../scanners/keyboard.js";
import { createPlaywrightPageDriver } from "../driver/playwright/index.js";

describe("runKeyboardTrapChecks", () => {
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
    // Wait a moment for any auto-open modals
    await page.waitForTimeout(200);
    return page;
  }

  it("detects a real trap (blocker)", async () => {
    const page = await loadFixture("real-trap.html");
    const url = page.url();

    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url });

    // Should find exactly 1 trap
    expect(result.findings.length).toBe(1);
    const finding = result.findings[0]!;

    // Verify finding structure
    expect(finding.source).toBe("keyboard");
    expect(finding.ruleId).toBe(KEYBOARD_TRAP_RULE_ID);
    expect(finding.wcagSc).toBe("2.1.2");
    expect(finding.wcagLevel).toBe("A");
    expect(finding.severity).toBe("blocker");
    expect(finding.requiresHumanReview).toBe(false);
    expect(finding.aiGenerated).toBe(false);
    expect(finding.selector).toBeTruthy();
    expect(finding.title).toContain("Keyboard Trap");

    // No passed rules when a trap is found
    expect(result.passes.length).toBe(0);

    // Evidence: forward Tab trap, an annotated cycle, keys attempted, and a
    // screenshot data-URI.
    const ev = finding.keyboardEvidence!;
    expect(ev).toBeTruthy();
    expect(["forward", "both"]).toContain(ev.direction);
    expect(ev.cycle.length).toBeGreaterThan(0);
    // Cycle steps carry selector + role + name annotations.
    for (const step of ev.cycle) {
      expect(step.selector).toBeTruthy();
      expect(step.role).toBeTruthy();
    }
    // Keys-attempted records Tab and Escape outcomes.
    const keys = ev.keysAttempted.map((k) => k.key);
    expect(keys).toContain("Escape");
    // Non-modal region trap → no modal context.
    expect(ev.modal).toBeNull();
    // Screenshot captured as a PNG data-URI.
    expect(ev.screenshotDataUri).toMatch(/^data:image\/png;base64,/);

    await page.close();
  });

  it("suppresses correct modal (0 findings, 1 pass)", async () => {
    const page = await loadFixture("correct-modal.html");
    const url = page.url();

    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url });

    // No findings
    expect(result.findings.length).toBe(0);

    // Should have passed rule
    expect(result.passes.length).toBe(1);
    const pass = result.passes[0]!;
    expect(pass.ruleId).toBe(KEYBOARD_TRAP_RULE_ID);
    expect(pass.wcagSc).toBe("2.1.2");
    expect(pass.wcagLevel).toBe("A");
    expect(pass.nodeCount).toBeGreaterThan(0);

    await page.close();
  });

  it("flags modal with broken escape but close control as review", async () => {
    const page = await loadFixture("modal-broken-escape-with-close.html");
    const url = page.url();

    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url });

    // Should find exactly 1 review finding
    expect(result.findings.length).toBe(1);
    const finding = result.findings[0]!;

    expect(finding.source).toBe("keyboard");
    expect(finding.ruleId).toBe(KEYBOARD_TRAP_RULE_ID);
    expect(finding.wcagSc).toBe("2.1.2");
    expect(finding.severity).toBe("review");
    expect(finding.requiresHumanReview).toBe(true);
    expect(finding.description).toContain("Close control");

    // Evidence: modal context with the detected close control surfaced.
    const ev = finding.keyboardEvidence!;
    expect(ev).toBeTruthy();
    expect(ev.modal).not.toBeNull();
    expect(ev.modal!.selector).toBeTruthy();
    expect(ev.modal!.closeControl).not.toBeNull();
    expect(ev.modal!.closeControl!.name.toLowerCase()).toContain("close");
    expect(ev.screenshotDataUri).toMatch(/^data:image\/png;base64,/);

    // No passed rules when a finding is present
    expect(result.passes.length).toBe(0);

    await page.close();
  });

  it("passes on normal page with no trap (0 findings, 1 pass)", async () => {
    const page = await loadFixture("no-trap.html");
    const url = page.url();

    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url });

    // No findings
    expect(result.findings.length).toBe(0);

    // Should have passed rule
    expect(result.passes.length).toBe(1);
    const pass = result.passes[0]!;
    expect(pass.ruleId).toBe(KEYBOARD_TRAP_RULE_ID);
    expect(pass.wcagSc).toBe("2.1.2");
    expect(pass.wcagLevel).toBe("A");
    expect(pass.nodeCount).toBeGreaterThan(0);

    await page.close();
  });

  it("produces deterministic selectors (runs 3x)", async () => {
    const page = await loadFixture("real-trap.html");
    const url = page.url();

    const run1 = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url });
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(200);

    const run2 = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url });
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(200);

    const run3 = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url });

    expect(run1.findings.length).toBe(1);
    expect(run2.findings.length).toBe(1);
    expect(run3.findings.length).toBe(1);

    const selector1 = run1.findings[0]!.selector;
    const selector2 = run2.findings[0]!.selector;
    const selector3 = run3.findings[0]!.selector;

    // All selectors should be identical
    expect(selector1).toBe(selector2);
    expect(selector2).toBe(selector3);

    await page.close();
  });

  it("validates Finding schema for keyboard source", () => {
    const mockFinding = {
      id: "test-id",
      wcagSc: "2.1.2",
      wcagLevel: "A",
      severity: "blocker",
      source: "keyboard",
      ruleId: KEYBOARD_TRAP_RULE_ID,
      title: "No Keyboard Trap",
      description: "Test description",
      htmlSnippet: "<div>test</div>",
      remediation: "Fix it",
      aiGenerated: false,
      requiresHumanReview: false,
      tags: ["keyboard", "wcag2a", "wcag212"],
      relatedRuleIds: [],
      relatedNodes: [],
      pageUrl: "https://example.com",
    };

    // Should parse successfully
    const result = FindingSchema.safeParse(mockFinding);
    expect(result.success).toBe(true);
  });

  it("returns empty arrays for page with no focusable elements", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <html lang="en">
      <head><title>Empty Page</title></head>
      <body><p>No focusable elements</p></body>
      </html>
    `);
    const url = page.url();

    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url });

    // No findings and no passes when nothing was tested
    expect(result.findings.length).toBe(0);
    expect(result.passes.length).toBe(0);

    await page.close();
  });

  it("flags modal with broken escape and no close control as blocker", async () => {
    const page = await loadFixture("modal-blocker.html");
    const url = page.url();

    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url });

    // A trapped modal with neither a working Escape nor a close control is a
    // hard blocker — distinct from the modal-review case.
    expect(result.findings.length).toBe(1);
    const finding = result.findings[0]!;
    expect(finding.source).toBe("keyboard");
    expect(finding.ruleId).toBe(KEYBOARD_TRAP_RULE_ID);
    expect(finding.wcagSc).toBe("2.1.2");
    expect(finding.severity).toBe("blocker");
    expect(finding.requiresHumanReview).toBe(false);
    expect(result.passes.length).toBe(0);

    await page.close();
  });

  it("detects a backward-only (Shift+Tab) trap", async () => {
    const page = await loadFixture("backward-trap.html");
    const url = page.url();

    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url });

    // Forward Tab exits cleanly; the trap only manifests walking backward.
    // Exercises the Shift+Tab direction independently.
    expect(result.findings.length).toBe(1);
    const finding = result.findings[0]!;
    expect(finding.source).toBe("keyboard");
    expect(finding.ruleId).toBe(KEYBOARD_TRAP_RULE_ID);
    expect(finding.wcagSc).toBe("2.1.2");
    expect(finding.severity).toBe("blocker");
    expect(result.passes.length).toBe(0);

    await page.close();
  });

  it("does not flag a single focusable element as a trap", async () => {
    const page = await loadFixture("single-focusable.html");
    const url = page.url();

    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url });

    // One focusable element is normal browser behavior, never a trap. It
    // should pass cleanly (false-positive guard).
    expect(result.findings.length).toBe(0);
    expect(result.passes.length).toBe(1);
    expect(result.passes[0]!.ruleId).toBe(KEYBOARD_TRAP_RULE_ID);

    await page.close();
  });

  it("detects multiple independent traps on a single page", async () => {
    const page = await loadFixture("multi-trap.html");
    const url = page.url();

    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url });

    // Should find exactly 3 traps (one for each independent trap region)
    expect(result.findings.length).toBe(3);

    // All findings should be keyboard traps
    for (const finding of result.findings) {
      expect(finding.source).toBe("keyboard");
      expect(finding.ruleId).toBe(KEYBOARD_TRAP_RULE_ID);
      expect(finding.wcagSc).toBe("2.1.2");
      expect(finding.wcagLevel).toBe("A");
      expect(finding.severity).toBe("blocker");

      // Each trap should have its own evidence
      const ev = finding.keyboardEvidence!;
      expect(ev).toBeTruthy();
      expect(ev.cycle.length).toBeGreaterThan(0);
      expect(ev.keysAttempted.length).toBeGreaterThan(0);
      expect(ev.screenshotDataUri).toMatch(/^data:image\/png;base64,/);
    }

    // All selectors should be distinct (different trap regions)
    const selectors = result.findings.map((f) => f.selector);
    const uniqueSelectors = new Set(selectors);
    expect(uniqueSelectors.size).toBe(3);

    // Verify each trap is in one of the expected regions
    const expectedRegions = ["#trap-top", "#trap-middle", "#trap-bottom"];
    for (const selector of selectors) {
      // Selector should contain one of the trap region IDs
      const matchesExpected = expectedRegions.some((region) =>
        selector.includes(region.slice(1)), // Remove # from the ID
      );
      expect(matchesExpected).toBe(true);
    }

    // No passed rules when traps are found
    expect(result.passes.length).toBe(0);

    await page.close();
  });

  it("detects the auto-detectable cases on the combined reference page", async () => {
    // all-cases.html mirrors examples/keyboard-test-cases.html. Only the
    // inline/always-open cases are walked by scan-url; the trigger-gated modals
    // (cases 5-7) stay closed and are not auto-detected. So we expect exactly
    // the three auto-detectable cases: real trap (1) + backward-only (3) +
    // always-open inline review dialog (8).
    const page = await loadFixture("all-cases.html");
    const url = page.url();

    // This is a Phase-1 trap test on the largest fixture. Disable the Phase-2
    // focus checks so the walk stays fast and the assertions isolate traps.
    const result = await runKeyboardTrapChecks({ page: createPlaywrightPageDriver(page), url, focusChecks: false });

    expect(result.findings.length).toBe(3);
    for (const f of result.findings) {
      expect(f.source).toBe("keyboard");
      expect(f.ruleId).toBe(KEYBOARD_TRAP_RULE_ID);
      expect(f.wcagSc).toBe("2.1.2");
      expect(f.keyboardEvidence?.screenshotDataUri).toMatch(
        /^data:image\/png;base64,/,
      );
    }

    const byRegion = new Map(result.findings.map((f) => [f.selector, f]));

    // Case 1: real non-modal trap → blocker.
    const real = byRegion.get("#trap-real");
    expect(real).toBeTruthy();
    expect(real!.severity).toBe("blocker");
    expect(real!.requiresHumanReview).toBe(false);

    // Case 3: backward-only trap → blocker, direction backward.
    const back = byRegion.get("#trap-backward");
    expect(back).toBeTruthy();
    expect(back!.severity).toBe("blocker");
    expect(["backward", "both"]).toContain(back!.keyboardEvidence!.direction);

    // Case 8: always-open inline dialog, broken Escape, Close in cycle → review.
    const inline = byRegion.get("#inline-review");
    expect(inline).toBeTruthy();
    expect(inline!.severity).toBe("review");
    expect(inline!.requiresHumanReview).toBe(true);
    expect(inline!.keyboardEvidence!.modal).not.toBeNull();
    expect(
      inline!.keyboardEvidence!.modal!.closeControl?.name.toLowerCase(),
    ).toContain("close");

    // Mix of blockers + a review means no clean pass is emitted.
    expect(result.passes.length).toBe(0);

    await page.close();
    // The combined reference page is the largest fixture; the both-direction
    // walk on it exceeds vitest's 5s default on slower machines. Give it room.
  }, 20_000);
});
