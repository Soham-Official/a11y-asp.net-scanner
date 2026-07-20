import { describe, it, expect } from "vitest";
import { __focusOrderInternals } from "../scanners/keyboard.js";

const { normalizedKendallTau, buildVisualOrder, decideFocusOrderFinding } =
  __focusOrderInternals;

describe("focus-order math", () => {
  it("tau is 0 for identical orders and 1 for fully reversed", () => {
    expect(normalizedKendallTau(["a", "b", "c", "d"], ["a", "b", "c", "d"])).toBe(0);
    expect(normalizedKendallTau(["a", "b", "c", "d"], ["d", "c", "b", "a"])).toBe(1);
  });

  it("row-banding groups overlapping rects into rows, sorts within row L→R", () => {
    const els = [
      { selector: "r1c2", rect: { x: 200, y: 0, width: 50, height: 30 }, domRank: 1 },
      { selector: "r1c1", rect: { x: 0, y: 0, width: 50, height: 30 }, domRank: 2 },
      { selector: "r2c1", rect: { x: 0, y: 100, width: 50, height: 30 }, domRank: 3 },
    ];
    const { order } = buildVisualOrder(els, "ltr");
    expect(order).toEqual(["r1c1", "r1c2", "r2c1"]);
  });

  it("mirrors within-band order for RTL", () => {
    const els = [
      { selector: "left", rect: { x: 0, y: 0, width: 50, height: 30 }, domRank: 1 },
      { selector: "right", rect: { x: 200, y: 0, width: 50, height: 30 }, domRank: 2 },
    ];
    const { order } = buildVisualOrder(els, "rtl");
    expect(order).toEqual(["right", "left"]);
  });

  it("returns null below the minimum element count", () => {
    const steps = Array.from({ length: 4 }, (_, i) => ({
      selector: `s${i}`,
      role: "button",
      name: "",
      rect: { x: 0, y: i * 40, width: 50, height: 30 },
      domRank: i + 1,
    }));
    expect(
      decideFocusOrderFinding({ steps, reliable: true, writingDirection: "ltr" }),
    ).toBeNull();
  });

  it("returns null when the sequence was unreliable (programmatic jump)", () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({
      selector: `s${i}`,
      role: "button",
      name: "",
      rect: { x: 0, y: i * 40, width: 50, height: 30 },
      domRank: ((i * 5) % 8) + 1, // scrambled
    }));
    expect(
      decideFocusOrderFinding({ steps, reliable: false, writingDirection: "ltr" }),
    ).toBeNull();
  });
});
