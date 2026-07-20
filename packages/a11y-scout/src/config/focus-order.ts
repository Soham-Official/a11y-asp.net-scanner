// Central, single-source-of-truth tuning for the Point 4 geometric tab-order
// divergence check (WCAG 2.4.3 "Focus Order"). To re-tune the check, edit ONLY
// this file — the scanner, its pure helpers, the conjunctive gate, and the tests
// all import FOCUS_ORDER_CONFIG from here.
//
// These thresholds are intentionally conservative: reading order is subjective,
// so we prefer silence over noise. Compile-time by design; see PLAN §12 for the
// (deliberately deferred) runtime-override option modeled on A11Y_MAX_COST_USD.
export const FOCUS_ORDER_CONFIG = {
  // Minimum naturally-Tab-reached elements before ordering comparison is
  // trustworthy; below this, ordering noise dominates.
  minElements: 6,
  // tab-vs-visual normalized Kendall-tau must EXCEED this (>=30% of pairs out of
  // reading order) before we consider the keyboard order visually divergent.
  tauVsVisual: 0.3,
  // tab-vs-dom normalized Kendall-tau must EXCEED this. Rules out the common,
  // acceptable case where the keyboard order simply follows DOM order (which CSS
  // then re-laid-out visually — flex/grid/float/absolute).
  tauVsDom: 0.2,
  // Two rects share a horizontal band if their vertical overlap is >= this
  // fraction of the SHORTER rect's height. Drives the row-banding visual order.
  bandOverlapRatio: 0.5,
  // If this fraction or more of elements collapse into a SINGLE band, the
  // geometry is degenerate (e.g. one toolbar row) — visual order is not
  // meaningfully reconstructable, so we treat it as untrustworthy and stay silent.
  maxBandFraction: 0.9,
  // Upper bound on elements analyzed. The schema caps the evidence arrays at 60;
  // above this a partial analysis would mislead, so we skip Point 4 entirely.
  maxElements: 60,
} as const;
