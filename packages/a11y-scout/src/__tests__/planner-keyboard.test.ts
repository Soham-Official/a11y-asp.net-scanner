import { describe, it, expect } from "vitest";
import { plan } from "../agents/planner.js";

const base = { mode: "url" as const, target: "https://example.com", level: "AA" as const };

describe("plan() keyboard flag", () => {
  it("defaults keyboard checks ON when the flag is omitted", () => {
    // Opt-out semantics: no flag means keyboard checks run. This is the
    // critical `?? true` default — a `Boolean(undefined)` regression would
    // silently disable the feature for every default scan.
    expect(plan(base).keyboard).toBe(true);
  });

  it("respects keyboard: false (--no-keyboard)", () => {
    expect(plan({ ...base, keyboard: false }).keyboard).toBe(false);
  });

  it("respects keyboard: true (explicit)", () => {
    expect(plan({ ...base, keyboard: true }).keyboard).toBe(true);
  });
});

describe("plan() content-quality scanner", () => {
  it("includes content-quality for url mode at every level (gated again at graph layer on !isMock)", () => {
    expect(plan({ ...base, level: "A" }).scanners).toContain("content-quality");
    expect(plan({ ...base, level: "AA" }).scanners).toContain("content-quality");
    expect(plan({ ...base, level: "AAA" }).scanners).toContain("content-quality");
  });

  it("includes content-quality for fixture mode", () => {
    expect(
      plan({ mode: "fixture", target: "tests/example.spec.ts", level: "AA" })
        .scanners,
    ).toContain("content-quality");
  });

  it("does NOT include content-quality for repo mode", () => {
    expect(
      plan({ mode: "repo", target: "./pkg", level: "AA" }).scanners,
    ).not.toContain("content-quality");
  });

  it("still adds aaa-semantic only at level=AAA", () => {
    expect(plan({ ...base, level: "AAA" }).scanners).toContain("aaa-semantic");
    expect(plan({ ...base, level: "A" }).scanners).not.toContain("aaa-semantic");
    expect(plan({ ...base, level: "AA" }).scanners).not.toContain("aaa-semantic");
  });
});

describe("plan() focus-check flags", () => {
  it("defaults focusChecks ON when the flag is omitted (--no-focus-checks opt-out)", () => {
    // Same `?? true` opt-out semantics as `keyboard` — a Boolean(undefined)
    // regression would silently disable Points 1/2/3 for every default scan.
    expect(plan(base).focusChecks).toBe(true);
  });

  it("respects focusChecks: false (--no-focus-checks)", () => {
    expect(plan({ ...base, focusChecks: false }).focusChecks).toBe(false);
  });

  it("defaults noFocusIndicatorScreenshots OFF when omitted (tier-2 stays ON for single-page)", () => {
    expect(plan(base).noFocusIndicatorScreenshots).toBe(false);
  });

  it("respects noFocusIndicatorScreenshots: true (--no-focus-indicator-screenshots)", () => {
    expect(
      plan({ ...base, noFocusIndicatorScreenshots: true })
        .noFocusIndicatorScreenshots,
    ).toBe(true);
  });
});
