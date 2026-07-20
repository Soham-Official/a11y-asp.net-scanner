import { z } from "zod";

export const SeveritySchema = z.enum([
  "blocker",
  "severe",
  "major",
  "minor",
  "review",
]);
export type Severity = z.infer<typeof SeveritySchema>;

export const WcagLevelSchema = z.enum(["A", "AA", "AAA"]);
export type WcagLevel = z.infer<typeof WcagLevelSchema>;

export const ConfidenceSchema = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const SourceSchema = z.enum([
  "axe",
  "eslint-jsx-a11y",
  "eslint-angular-template",
  "html-lint",
  "aaa-semantic",
  "content-quality",
  "validator",
  "keyboard",
  "reflow",
]);
export type Source = z.infer<typeof SourceSchema>;

export const RelatedNodeSchema = z.object({
  html: z.string(),
  target: z.array(z.string()),
});
export type RelatedNode = z.infer<typeof RelatedNodeSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  wcagSc: z.string(),
  wcagLevel: WcagLevelSchema,
  severity: SeveritySchema,
  source: SourceSchema,
  ruleId: z.string(),
  title: z.string(),
  description: z.string(),
  impact: z.string().optional(),
  // Canonical W3C "Understanding" URL, stamped from wcag.ts via enrichFinding.
  helpUrl: z.string().optional(),
  // Secondary vendor deep-link (axe → deque, static → GitHub rule docs). Set at
  // the source; enrichment never touches it. Reporters render it as "Developer
  // docs" alongside the primary WCAG link. Absent for keyboard/reflow/LLM.
  docUrl: z.string().optional(),
  selector: z.string().optional(),
  xpath: z.string().optional(),
  filePath: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
  htmlSnippet: z.string().optional(),
  remediation: z.string().optional(),
  aiGenerated: z.boolean().default(false),
  confidence: ConfidenceSchema.optional(),
  requiresHumanReview: z.boolean().default(false),
  // Structured diagnostic data from axe-core incomplete checks.
  // Only populated when this finding came from axe's `incomplete` array.
  incompleteData: z
    .object({
      checkId: z.string(), // e.g. "color-contrast", "aria-allowed-attr"
      message: z.string(), // node.any[0].message (already captured, but now explicit)
      data: z.record(z.unknown()).nullable(), // node.any[0].data — structured fields (fgColor, bgColor, fontSize, etc.)
      relatedNodes: z.array(RelatedNodeSchema).default([]), // node.any[0].relatedNodes (e.g. the background element)
    })
    .optional(),
  // Structured evidence for keyboard-trap findings (source: "keyboard").
  // Captures the observed focus walk so reports can show the trap concretely:
  // which keys were tried, the repeating focus cycle, the modal context, and a
  // screenshot of the trap point. Only populated for keyboard-trap findings.
  keyboardEvidence: z
    .object({
      // Direction(s) the trap manifests in. A trap can be one-directional.
      direction: z.enum(["forward", "backward", "both"]),
      // The repeating focus cycle (the minimal loop that proves the trap), in
      // tab order. Each step annotated with accessible name + role for clarity.
      cycle: z
        .array(
          z.object({
            selector: z.string(),
            role: z.string(), // computed/explicit role or tag name
            name: z.string(), // accessible name (aria-label, text, value, etc.)
          }),
        )
        .default([]),
      // Each key we attempted and what happened — the clearest trap summary.
      keysAttempted: z
        .array(
          z.object({
            key: z.string(), // "Tab" | "Shift+Tab" | "Escape"
            result: z.string(), // human-readable outcome
          }),
        )
        .default([]),
      // Modal context, when the trap is inside a dialog/aria-modal region.
      modal: z
        .object({
          selector: z.string(),
          closeControl: z
            .object({ selector: z.string(), name: z.string() })
            .nullable()
            .default(null),
        })
        .nullable()
        .default(null),
      // One screenshot at the trap point, trapped element outlined, as a
      // base64 PNG data-URI. Self-contained so the scanner needn't know the
      // report output directory. Optional — capture failures are non-fatal.
      screenshotDataUri: z.string().optional(),
    })
    .optional(),
  // Phase-2 keyboard evidence (source: "keyboard"). All three are deterministic
  // runtime probes from the focus walk — no LLM, no network. Only one is
  // populated per finding, matching the finding's ruleId.
  //
  // Point 1 — focus landed on an off-screen / invisible element (2.4.3 / 2.4.7).
  focusVisibilityEvidence: z
    .object({
      // Why the element is considered not-visibly-focusable. "offscreen" is the
      // only one gated by the scrollIntoView re-measure guard; the rest are
      // unconditional (viewport-independent) invisibility.
      reason: z.enum([
        "offscreen",
        "display-none",
        "visibility-hidden",
        "opacity-zero",
        "zero-area",
      ]),
      rect: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
      viewport: z.object({ width: z.number(), height: z.number() }),
      // True only for "offscreen": an explicit scrollIntoView() still could not
      // pull the element into view (the false-positive guard outcome).
      scrolledIntoViewFailed: z.boolean().default(false),
      // Step number in the focus walk where this was observed.
      tabIndex: z.number(),
      screenshotDataUri: z.string().optional(),
    })
    .optional(),
  // Point 2 — no detectable visible focus indicator (2.4.7, AA-only, review).
  focusIndicatorEvidence: z
    .object({
      // "style-delta-only" = tier-1 / crawl summary (no screenshot run);
      // "screenshot-verified" = tier-2 confirmed NO indicator pixels changed.
      verification: z.enum(["style-delta-only", "screenshot-verified"]),
      // Computed-style properties compared unfocused-vs-focused.
      comparedProperties: z.array(z.string()).default([]),
      // Why tier-2 was skipped on a per-page summary finding. "crawl" = auto-
      // disabled to bound cost; "user-opt-out" = --no-focus-indicator-screenshots.
      // Absent on tier-2 (screenshot-verified) findings.
      skipReason: z.enum(["crawl", "user-opt-out"]).optional(),
      // Crawl per-page summary finding only: how many candidates were skipped.
      candidateCount: z.number().optional(),
      // Tier-2 measured changed-pixel ratio (< threshold ⇒ flagged).
      changedPixelRatio: z.number().optional(),
      // Tier-2 only: the focused-state screenshot of the candidate's box.
      screenshotDataUri: z.string().optional(),
    })
    .optional(),
  // Point 3 — focus moved into content behind an open modal (2.4.3 / 2.1.2).
  modalLeakEvidence: z
    .object({
      modalSelector: z.string(),
      // How the modal was opened — drives blocker vs review severity.
      modalKind: z.enum(["modal-true", "role-dialog", "dialog-modal"]),
      // element.matches(":modal") — true ⇒ top-layer modal ⇒ blocker.
      isTopLayerModal: z.boolean(),
      // Where focus leaked to (the element outside the dialog subtree).
      leakedToSelector: z.string(),
      leakedToRole: z.string(),
      leakedToName: z.string(),
      direction: z.enum(["forward", "backward"]),
      screenshotDataUri: z.string().optional(),
    })
    .optional(),
  // Point 4 — geometric tab-order divergence (2.4.3 Focus Order, Level A,
  // REVIEW-ONLY). Deterministic, offline, screenshot-free. At most ONE per page.
  // Fires only when the keyboard tab order diverges from BOTH the DOM order AND
  // a geometry-reconstructed visual reading order (conjunctive gate). Reading
  // order is subjective, so this is always requiresHumanReview: true.
  focusOrderEvidence: z
    .object({
      // The three orderings, each a list of focusable elements in that order.
      // All three lists contain the SAME set of elements (the naturally-
      // Tab-reached ones), only the sequence differs — that is the whole point.
      // Capped to keep payloads reasonable; tabOrder is the authoritative length.
      tabOrder: z
        .array(
          z.object({
            selector: z.string(),
            role: z.string(), // computed/explicit role or tag name
            name: z.string(), // accessible name approximation
            // Viewport-relative rect at the moment focus landed (post focus-scroll).
            rect: z.object({
              x: z.number(),
              y: z.number(),
              width: z.number(),
              height: z.number(),
            }),
          }),
        )
        .max(60)
        .default([]),
      // The same elements re-sequenced into DOM/document order. Selector-only:
      // the rect/role/name already live in tabOrder keyed by selector.
      domOrderSelectors: z.array(z.string()).max(60).default([]),
      // The same elements re-sequenced into geometry-reconstructed reading order
      // (row-banding: bands top→bottom, within band left→right; mirrored in RTL).
      visualOrderSelectors: z.array(z.string()).max(60).default([]),
      // Normalized Kendall-tau distance (fraction of discordant pairs, 0..1).
      // tauTabVsVisual: how far keyboard order is from the eye's reading order.
      tauTabVsVisual: z.number().min(0).max(1),
      // tauTabVsDom: how far keyboard order is from source/DOM order. Both must
      // exceed their thresholds for the finding to fire (conjunctive gate).
      tauTabVsDom: z.number().min(0).max(1),
      // Document writing direction the visual order was built for ("ltr"|"rtl").
      writingDirection: z.enum(["ltr", "rtl"]),
      // Number of naturally-Tab-reached elements compared (== tabOrder.length).
      elementCount: z.number().int().nonnegative(),
      // FALSE when a programmatic focus jump occurred during the walk (trap
      // recovery) — the captured tab sequence is then not a pure keyboard order,
      // so we DO NOT fire. Surfaced for transparency/debugging; when the finding
      // exists this is always true (we never emit when reliable === false).
      reliable: z.boolean().default(true),
      // The first few worst-offending adjacent transitions (a tab step that
      // jumps far against reading order), for human-readable evidence.
      jumps: z
        .array(
          z.object({
            fromSelector: z.string(),
            toSelector: z.string(),
            // Reading-order rank delta (visualOrder index of `to` minus `from`);
            // large negative = focus jumped backward up the page.
            visualRankDelta: z.number(),
          }),
        )
        .max(10)
        .default([]),
    })
    .optional(),
  focusObscuredEvidence: z
    .object({
      level: z.enum(["min", "enhanced"]),
      obstructorSelector: z.string(),
      obstructorPosition: z.enum(["fixed", "sticky"]),
      focusedRect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      obstructorRect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      coveredCorners: z.number().int().min(0).max(4),
      coveredSamplePoints: z.number().int().min(0).max(8),
      tabIndex: z.number().int().nonnegative(),
    })
    .optional(),
  tags: z.array(z.string()).default([]),
  // Other rule IDs that flagged the same underlying issue (same file/line/
  // equivalence group). The validator collapses overlapping rules — e.g.
  // jsx-a11y/click-events-have-key-events and jsx-a11y/no-static-element-
  // interactions both fire for `<div onClick>` — into one finding while
  // recording the losers here so reports can still surface them.
  relatedRuleIds: z.array(z.string()).default([]),
  // Related DOM nodes from axe-core check results (violations & incomplete).
  // Shows elements that contribute to or are affected by this finding
  // (e.g., the background element in contrast issues, duplicate ID targets).
  // Capped at 10 entries to keep report payloads reasonable.
  relatedNodes: z.array(RelatedNodeSchema).max(10).default([]),
  // Set when the finding came from a multi-page crawl. For single-page scans
  // and repo scans this is omitted (the target URL / repo path is already on
  // the ScanPlan).
  pageUrl: z.string().optional(),
  // LLM-suggested corrected HTML for the failing element. Populated only for
  // url-mode scans by the fix-html agent when a real (non-mock) LLM provider
  // is configured. Always advisory — never auto-applied.
  aiFixedHtml: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const PassedRuleSchema = z.object({
  ruleId: z.string(),
  description: z.string(),
  helpUrl: z.string().optional(),
  wcagSc: z.string(),
  wcagLevel: WcagLevelSchema,
  tags: z.array(z.string()).default([]),
  /** Total number of DOM nodes that passed this rule (across all pages if crawl). */
  nodeCount: z.number().nonnegative(),
  /** Up to 5 sample CSS selectors showing elements that passed. */
  sampleSelectors: z.array(z.string()).max(5).default([]),
  /** Page URL(s) where this rule was evaluated. */
  pageUrls: z.array(z.string()).default([]),
});
export type PassedRule = z.infer<typeof PassedRuleSchema>;

export const InapplicableRuleSchema = z.object({
  ruleId: z.string(),
  description: z.string(),
  helpUrl: z.string().optional(),
  wcagSc: z.string(),
  wcagLevel: WcagLevelSchema,
  tags: z.array(z.string()).default([]),
  pageUrls: z.array(z.string()).default([]),
});
export type InapplicableRule = z.infer<typeof InapplicableRuleSchema>;

export const ScanModeSchema = z.enum(["url", "repo", "fixture"]);
export type ScanMode = z.infer<typeof ScanModeSchema>;

export const ScanLevelSchema = z.enum(["A", "AA", "AAA"]);
export type ScanLevel = z.infer<typeof ScanLevelSchema>;

export const WaitUntilSchema = z.enum(["domcontentloaded", "load", "networkidle"]);
export type WaitUntil = z.infer<typeof WaitUntilSchema>;

export const CrawlOptionsSchema = z.object({
  enabled: z.boolean().default(false),
  maxPages: z.number().int().positive().default(10),
  maxDepth: z.number().int().nonnegative().default(2),
  // Optional regex strings; matched against absolute URL.
  includePattern: z.string().optional(),
  excludePattern: z.string().optional(),
  // Same-origin only. We do not cross origins in V1 to avoid scope creep
  // (e.g. ad networks, CDNs). This is intentional, not configurable.
});
export type CrawlOptions = z.infer<typeof CrawlOptionsSchema>;

export const ScanPlanSchema = z.object({
  mode: ScanModeSchema,
  target: z.string(),
  level: ScanLevelSchema.default("AA"),
  scanners: z.array(
    z.enum(["static", "runtime", "aaa-semantic", "content-quality"]),
  ),
  authStatePath: z.string().optional(),
  captureAuth: z.boolean().default(false),
  headed: z.boolean().default(false),
  ignoreHttpsErrors: z.boolean().default(false),
  maxCostUsd: z.number().default(1.0),
  waitUntil: WaitUntilSchema.default("load"),
  extraWaitMs: z.number().nonnegative().default(0),
  keyboard: z.boolean().default(true),
  // Phase-2 focus checks (off-screen focus 2.4.3, focus-indicator 2.4.7, modal
  // leak 2.4.3/2.1.2). On by default; `--no-focus-checks` opts out. Keyboard
  // trap detection (2.1.2) stays on regardless via the `keyboard` flag.
  focusChecks: z.boolean().default(true),
  // Disable tier-2 screenshot verification of focus indicators on single-page
  // scans. Crawl always auto-disables tier-2 for cost regardless of this flag.
  noFocusIndicatorScreenshots: z.boolean().default(false),
  // Generate AI-suggested fixed HTML per finding. url mode only; gated again
  // at graph level on `!llm.isMock` so mock-only environments stay deterministic.
  aiFix: z.boolean().default(true),
  crawl: CrawlOptionsSchema.default({
    enabled: false,
    maxPages: 10,
    maxDepth: 2,
  }),
});
export type ScanPlan = z.infer<typeof ScanPlanSchema>;

export const PageEvidenceSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  textSample: z.string().optional(),
  links: z.array(z.object({ href: z.string(), text: z.string() })).default([]),
  headings: z
    .array(z.object({ level: z.number(), text: z.string() }))
    .default([]),
  screenshotPath: z.string().optional(),
  // Extended evidence for the content-quality LLM agent (A/AA semantic checks).
  // All optional/defaulted so older serialised reports remain parseable.
  htmlLang: z.string().optional(),
  images: z
    .array(
      z.object({
        alt: z.string(),
        src: z.string(),
        hasAlt: z.boolean(),
      }),
    )
    .default([]),
  formFields: z
    .array(
      z.object({
        tag: z.string(),
        type: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
        autocomplete: z.string().optional(),
        placeholder: z.string().optional(),
        labelText: z.string().optional(),
        accessibleName: z.string().optional(),
        describedByText: z.string().optional(),
        required: z.boolean().optional(),
      }),
    )
    .default([]),
  errorMessages: z
    .array(
      z.object({
        text: z.string(),
        role: z.string().optional(),
        nearFieldName: z.string().optional(),
      }),
    )
    .default([]),
  langParts: z
    .array(z.object({ lang: z.string(), text: z.string() }))
    .default([]),
  instructions: z.array(z.string()).default([]),
});
export type PageEvidence = z.infer<typeof PageEvidenceSchema>;

export const CostEntrySchema = z.object({
  model: z.string(),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  costUsd: z.number().default(0),
  ts: z.string(),
});
export type CostEntry = z.infer<typeof CostEntrySchema>;

export const ScanStateSchema = z.object({
  scanId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  plan: ScanPlanSchema,
  evidence: z.array(PageEvidenceSchema).default([]),
  findings: z.array(FindingSchema).default([]),
  passes: z.array(PassedRuleSchema).default([]),
  inapplicable: z.array(InapplicableRuleSchema).default([]),
  cost: z.object({
    totalUsd: z.number().default(0),
    entries: z.array(CostEntrySchema).default([]),
  }),
  meta: z.object({
    version: z.string(),
    // Provider-agnostic fields
    llmMockMode: z.boolean().default(false),
    llmProvider: z.enum(["bedrock", "haip", "mock"]).default("haip"),
    // Deprecated fields (V1.1) - optional for backward compat when deserializing old reports
    haipMockMode: z.boolean().default(false).optional(),
    haipEnv: z.string().default("n/a").optional(),
    // Populated by the runtime scanner. For single-page scans this is the
    // sole target URL. For crawls it lists every page that was visited.
    pagesScanned: z.array(z.string()).default([]),
    // Pages we attempted but couldn't reach (timeouts, 4xx/5xx, redirects
    // to a different origin, etc). Useful for debugging crawl coverage.
    pagesSkipped: z
      .array(z.object({ url: z.string(), reason: z.string() }))
      .default([]),
  }),
});
export type ScanState = z.infer<typeof ScanStateSchema>;

export const ScanSummarySchema = z.object({
  blockers: z.number(),
  severe: z.number(),
  major: z.number(),
  minor: z.number(),
  review: z.number(),
  total: z.number(),
  passes: z.number().default(0),
  inapplicable: z.number().default(0),
  durationMs: z.number(),
  costUsd: z.number(),
});
export type ScanSummary = z.infer<typeof ScanSummarySchema>;

// === Fixer Types ===

export const FixConfidenceSchema = z.enum(["high", "medium", "low"]);
export type FixConfidence = z.infer<typeof FixConfidenceSchema>;

export const FixCategorySchema = z.enum([
  "missing-alt",
  "missing-lang",
  "empty-button",
  "empty-link",
  "missing-label",
  "attribute-rename",
  "attribute-value",
  "attribute-removal",
  "iframe-title",
  "empty-heading",
  "empty-anchor",
  "other",
]);
export type FixCategory = z.infer<typeof FixCategorySchema>;

export const FixActionSchema = z.object({
  findingId: z.string(),
  category: FixCategorySchema,
  confidence: FixConfidenceSchema,
  filePath: z.string(),
  lineNumber: z.number().optional(),
  original: z.string(),
  replacement: z.string(),
  // Narrative-only field surfaced to the user. Some LLMs occasionally omit
  // it — that should not invalidate an otherwise-applicable fix, so we
  // default to empty rather than requiring it.
  explanation: z.string().default(""),
});
export type FixAction = z.infer<typeof FixActionSchema>;

export const FixResultSchema = z.object({
  action: FixActionSchema,
  applied: z.boolean(),
  error: z.string().optional(),
});
export type FixResult = z.infer<typeof FixResultSchema>;

export const FixSummarySchema = z.object({
  totalFindings: z.number(),
  fixesAttempted: z.number(),
  fixesApplied: z.number(),
  // The LLM produced a fix action but the applier rejected it (e.g. text
  // mismatch, ambiguous match). Distinct from `fixesDeclined`.
  fixesFailed: z.number(),
  // The LLM returned no action for this finding at all. Without this we
  // can't tell whether fix-repo's losses come from the model or the applier.
  fixesDeclined: z.number(),
  byCategory: z.record(z.number()),
  byConfidence: z.record(z.number()),
  costUsd: z.number(),
  durationMs: z.number(),
});
export type FixSummary = z.infer<typeof FixSummarySchema>;
