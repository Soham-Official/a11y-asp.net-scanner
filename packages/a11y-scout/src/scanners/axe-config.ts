import type { AxeRunConfig } from "../driver/interfaces.js";
import type { ScanLevel } from "../types.js";

/**
 * Tag set passed to axe (via `AxeRunConfig.tags`) per WCAG conformance
 * level. Owned here so the fixture and the CLI consume one source of
 * truth.
 */
export const TAGS_FOR_LEVEL: Record<ScanLevel, string[]> = {
  A: ["wcag2a", "wcag21a", "wcag22a", "best-practice"],
  AA: [
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
    "wcag22a",
    "wcag22aa",
    "best-practice",
  ],
  AAA: [
    "wcag2a",
    "wcag2aa",
    "wcag2aaa",
    "wcag21a",
    "wcag21aa",
    "wcag21aaa",
    "wcag22a",
    "wcag22aa",
    "wcag22aaa",
    "best-practice",
  ],
};

export interface BuildAxeOptions {
  /** Optional include selector — restricts axe to a subtree. */
  include?: string;
  /** Optional exclude selectors — pruned from the axe context. */
  exclude?: string[];
}

/**
 * Build the axe-core run config for the given WCAG level. Centralizes the
 * tag list and the small set of opt-in rules so the CLI runtime scanner
 * and the Playwright fixture stay in lockstep — adding a rule in one
 * place updates both call sites.
 *
 * Returns a framework-agnostic `AxeRunConfig`; the driver's axe runner
 * (e.g. `PlaywrightPageDriver.runAxe`) consumes it.
 */
export function buildAxeConfig(
  level: ScanLevel,
  opts: BuildAxeOptions = {},
): AxeRunConfig {
  const tags = TAGS_FOR_LEVEL[level];

  // Rules force-enabled via `rules` override axe-core's tag filter, so they
  // fire regardless of the tag list. For AA-or-better rules that's what we
  // want; for AAA-only rules (color-contrast-enhanced) we gate the opt-in
  // on `level` to avoid leaking AAA findings into AA scans.
  //
  // target-size, css-orientation-lock, and label-content-name-mismatch are
  // either disabled-by-default or experimental in axe-core; opt them in
  // unconditionally so the corresponding WCAG SCs surface at every level
  // that includes their tag.
  const rules: Record<string, { enabled: boolean }> = {
    "target-size": { enabled: true }, // WCAG 2.5.8 (AA)
    "css-orientation-lock": { enabled: true }, // WCAG 1.3.4 (AA, experimental)
    "label-content-name-mismatch": { enabled: true }, // WCAG 2.5.3 (A, experimental)
  };
  if (level === "AAA") {
    rules["color-contrast-enhanced"] = { enabled: true }; // WCAG 1.4.6 (AAA)
  }

  return {
    tags,
    rules,
    include: opts.include,
    exclude: opts.exclude,
  };
}
