import { describe, it, expect } from "vitest";
import {
  getIncompleteGuidance,
  IncompleteGuidanceSchema,
} from "../incomplete-guidance.js";

describe("getIncompleteGuidance", () => {
  it("returns exact match when ruleId and checkId match", () => {
    const guidance = getIncompleteGuidance(
      "color-contrast",
      "color-contrast"
    );

    expect(guidance.label).toBe("Color Contrast on Complex Background");
    expect(guidance.verificationSteps).toHaveLength(6);
    expect(guidance.wcagRef).toBe("1.4.3");
  });

  it("returns wildcard match when exact match not found", () => {
    const guidance = getIncompleteGuidance(
      "color-contrast",
      "unknown-check-id"
    );

    expect(guidance.label).toBe("Color Contrast Verification");
    expect(guidance.verificationSteps.length).toBeGreaterThan(0);
    expect(guidance.wcagRef).toBe("1.4.3");
  });

  it("returns default guidance when no match found", () => {
    const guidance = getIncompleteGuidance(
      "unknown-rule",
      "unknown-check"
    );

    expect(guidance.label).toBe("Manual Verification Required");
    expect(guidance.reason).toContain("could not automatically determine");
    expect(guidance.verificationSteps).toHaveLength(3);
    expect(guidance.wcagRef).toBeUndefined();
  });

  it("prioritizes exact match over wildcard", () => {
    // color-contrast::color-contrast should win over color-contrast::*
    const exactGuidance = getIncompleteGuidance(
      "color-contrast",
      "color-contrast"
    );
    const wildcardGuidance = getIncompleteGuidance(
      "color-contrast",
      "some-other-check"
    );

    expect(exactGuidance.label).toBe("Color Contrast on Complex Background");
    expect(wildcardGuidance.label).toBe("Color Contrast Verification");
    expect(exactGuidance.label).not.toBe(wildcardGuidance.label);
  });

  it("all guidance entries have non-empty verificationSteps", () => {
    // Test a sampling of known entries
    const testCases = [
      ["color-contrast", "color-contrast"],
      ["link-in-text-block", "color-contrast"],
      ["hidden-content", "any-check"],
      ["aria-allowed-attr", "aria-allowed-attr"],
      ["label", "any-check"],
      ["image-alt", "any-check"],
    ];

    for (const [ruleId, checkId] of testCases) {
      const guidance = getIncompleteGuidance(ruleId, checkId);
      expect(guidance.verificationSteps.length).toBeGreaterThan(0);
      expect(guidance.verificationSteps.every((step) => step.length > 0)).toBe(
        true
      );
    }
  });

  it("guidance entries have meaningful reasons", () => {
    const testCases = [
      ["color-contrast", "color-contrast"],
      ["hidden-content", "any-check"],
      ["label", "any-check"],
    ];

    for (const [ruleId, checkId] of testCases) {
      const guidance = getIncompleteGuidance(ruleId, checkId);
      expect(guidance.reason.length).toBeGreaterThan(10);
      expect(guidance.reason).not.toBe("");
    }
  });

  it("validates against IncompleteGuidanceSchema", () => {
    const guidance = getIncompleteGuidance(
      "color-contrast",
      "color-contrast"
    );

    // Should not throw
    const result = IncompleteGuidanceSchema.safeParse(guidance);
    expect(result.success).toBe(true);
  });

  it("handles WCAG reference correctly", () => {
    // Some entries have wcagRef, some don't
    const withRef = getIncompleteGuidance("color-contrast", "color-contrast");
    expect(withRef.wcagRef).toBe("1.4.3");

    const defaultGuidance = getIncompleteGuidance("unknown", "unknown");
    expect(defaultGuidance.wcagRef).toBeUndefined();
  });

  it("all verification steps are strings", () => {
    const guidance = getIncompleteGuidance(
      "color-contrast",
      "color-contrast"
    );

    guidance.verificationSteps.forEach((step) => {
      expect(typeof step).toBe("string");
      expect(step.length).toBeGreaterThan(0);
    });
  });

  it("handles aria-related guidance", () => {
    const ariaAttrGuidance = getIncompleteGuidance(
      "aria-allowed-attr",
      "aria-allowed-attr"
    );
    expect(ariaAttrGuidance.label).toContain("ARIA");

    const ariaChildrenGuidance = getIncompleteGuidance(
      "aria-required-children",
      "aria-required-children"
    );
    expect(ariaChildrenGuidance.label).toContain("ARIA");
  });

  it("handles multiple wildcard entries", () => {
    // Test that different wildcard rules return different guidance
    const hiddenGuidance = getIncompleteGuidance("hidden-content", "any-check");
    const labelGuidance = getIncompleteGuidance("label", "any-check");
    const imageGuidance = getIncompleteGuidance("image-alt", "any-check");

    expect(hiddenGuidance.label).not.toBe(labelGuidance.label);
    expect(labelGuidance.label).not.toBe(imageGuidance.label);
    expect(hiddenGuidance.label).not.toBe(imageGuidance.label);
  });
});
