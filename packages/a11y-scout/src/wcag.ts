import type { Finding, Severity, WcagLevel } from "./types.js";

export interface WcagCriterion {
  id: string;
  level: WcagLevel;
  title: string;
  /**
   * W3C "Understanding" doc slug (the last path segment). The single source of
   * truth for this SC's help URL — `url` below is derived from it, and
   * `understandingUrlForSc` reads it. Adding a supported SC = one catalog edit.
   */
  slug: string;
  /**
   * Canonical W3C Understanding URL. DERIVED from `slug` post-construction (see
   * `deriveUrl` / the map below); do not hand-write it on catalog entries.
   */
  url: string;
  coverage: "automated" | "ai_assisted" | "manual_only";
  defaultSeverity: Severity;
}

const UNDERSTANDING_BASE = "https://www.w3.org/WAI/WCAG22/Understanding";

function understandingUrl(slug: string): string {
  return `${UNDERSTANDING_BASE}/${slug}`;
}

const blockerScIds = new Set([
  "1.1.1",
  "1.4.3",
  "2.1.1",
  "2.1.2",
  "2.4.7",
  "2.4.11",
  "4.1.2",
]);

export function severityForSc(sc: string, level: WcagLevel): Severity {
  if (blockerScIds.has(sc)) return "blocker";
  if (level === "A") return "severe";
  if (level === "AA") return "major";
  return "minor";
}

/**
 * Domain severity ordering (highest → lowest). Exported so callers that need to
 * compare/sort by severity (e.g. the validator's dedup) share one authority
 * rather than re-declaring it. This is domain ordering, NOT presentation — the
 * reporters keep their own label/color maps.
 */
export const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 5,
  severe: 4,
  major: 3,
  minor: 2,
  review: 1,
};

/**
 * Severity for a finding that maps to MULTIPLE success criteria. Returns the
 * HIGHEST severity across all mapped SCs — a finding that violates both 3.3.2
 * (severe) and 4.1.2 (blocker) is a blocker.
 *
 * CRITICAL: callers must derive severity from the full SC list via this helper,
 * NOT from `scIds[0]`. Deriving severity from array position couples it to
 * ordering and silently downgrades blockers when a lower-severity SC happens to
 * be listed first (this was a real bug with the `label` rule). The unit test in
 * `wcag-mappings.test.ts` enforces the invariant.
 */
export function severityForScList(scIds: string[]): Severity | undefined {
  let best: Severity | undefined;
  for (const sc of scIds) {
    const crit = getCriterion(sc);
    if (!crit) continue;
    const sev = severityForSc(sc, crit.level);
    if (!best || SEVERITY_RANK[sev] > SEVERITY_RANK[best]) best = sev;
  }
  return best;
}

// Raw catalog entries carry `slug` (the single URL source); `url` is derived
// post-construction below to avoid a temporal-dead-zone on the resolver.
type RawWcagCriterion = Omit<WcagCriterion, "url">;

const RAW_WCAG_CATALOG: RawWcagCriterion[] = [
  {
    id: "1.1.1",
    level: "A",
    title: "Non-text Content",
    slug: "non-text-content",
    coverage: "automated",
    defaultSeverity: "blocker",
  },
  {
    id: "1.3.1",
    level: "A",
    title: "Info and Relationships",
    slug: "info-and-relationships",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    id: "1.3.2",
    level: "A",
    title: "Meaningful Sequence",
    slug: "meaningful-sequence",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    // Emitted by the content-quality LLM agent (sensory characteristics).
    id: "1.3.3",
    level: "A",
    title: "Sensory Characteristics",
    slug: "sensory-characteristics",
    coverage: "ai_assisted",
    defaultSeverity: "severe",
  },
  {
    id: "1.3.4",
    level: "AA",
    title: "Orientation",
    slug: "orientation",
    coverage: "automated",
    defaultSeverity: "major",
  },
  {
    id: "1.3.5",
    level: "AA",
    title: "Identify Input Purpose",
    slug: "identify-input-purpose",
    coverage: "automated",
    defaultSeverity: "major",
  },
  {
    id: "1.4.1",
    level: "A",
    title: "Use of Color",
    slug: "use-of-color",
    coverage: "ai_assisted",
    defaultSeverity: "severe",
  },
  {
    id: "1.4.3",
    level: "AA",
    title: "Contrast (Minimum)",
    slug: "contrast-minimum",
    coverage: "automated",
    defaultSeverity: "blocker",
  },
  {
    id: "1.4.4",
    level: "AA",
    title: "Resize Text",
    slug: "resize-text",
    coverage: "automated",
    defaultSeverity: "major",
  },
  {
    id: "1.4.6",
    level: "AAA",
    title: "Contrast (Enhanced)",
    slug: "contrast-enhanced",
    coverage: "automated",
    defaultSeverity: "minor",
  },
  {
    id: "1.4.10",
    level: "AA",
    title: "Reflow",
    slug: "reflow",
    coverage: "automated",
    defaultSeverity: "major",
  },
  {
    id: "2.1.1",
    level: "A",
    title: "Keyboard",
    slug: "keyboard",
    coverage: "ai_assisted",
    defaultSeverity: "blocker",
  },
  {
    id: "2.1.2",
    level: "A",
    title: "No Keyboard Trap",
    slug: "no-keyboard-trap",
    coverage: "automated",
    defaultSeverity: "blocker",
  },
  {
    id: "2.4.1",
    level: "A",
    title: "Bypass Blocks",
    slug: "bypass-blocks",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    id: "2.4.2",
    level: "A",
    title: "Page Titled",
    slug: "page-titled",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    id: "2.4.3",
    level: "A",
    title: "Focus Order",
    slug: "focus-order",
    // Phase-2 keyboard walk detects deterministic focus-order failures
    // (off-screen/invisible focus, focus leaking behind an open modal).
    coverage: "automated",
    // NOT added to blockerScIds: both off-screen focus AND modal-leak map to
    // 2.4.3 and default to "severe" via severityForSc.
    defaultSeverity: "severe",
  },
  {
    id: "2.4.4",
    level: "A",
    title: "Link Purpose (In Context)",
    slug: "link-purpose-in-context",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    id: "2.4.6",
    level: "AA",
    title: "Headings and Labels",
    slug: "headings-and-labels",
    coverage: "ai_assisted",
    defaultSeverity: "major",
  },
  {
    id: "2.4.7",
    level: "AA",
    title: "Focus Visible",
    slug: "focus-visible",
    coverage: "ai_assisted",
    defaultSeverity: "blocker",
  },
  {
    id: "2.4.9",
    level: "AAA",
    title: "Link Purpose (Link Only)",
    slug: "link-purpose-link-only",
    coverage: "ai_assisted",
    defaultSeverity: "minor",
  },
  {
    id: "2.4.10",
    level: "AAA",
    title: "Section Headings",
    slug: "section-headings",
    coverage: "ai_assisted",
    defaultSeverity: "minor",
  },
  {
    id: "2.4.11",
    level: "AA",
    title: "Focus Not Obscured (Minimum)",
    slug: "focus-not-obscured-minimum",
    coverage: "automated",
    defaultSeverity: "blocker",
  },
  {
    id: "2.4.12",
    level: "AAA",
    title: "Focus Not Obscured (Enhanced)",
    slug: "focus-not-obscured-enhanced",
    coverage: "automated",
    defaultSeverity: "minor",
  },
  {
    id: "2.5.3",
    level: "A",
    title: "Label in Name",
    slug: "label-in-name",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    id: "2.5.8",
    level: "AA",
    title: "Target Size (Minimum)",
    slug: "target-size-minimum",
    coverage: "automated",
    defaultSeverity: "major",
  },
  {
    id: "3.1.1",
    level: "A",
    title: "Language of Page",
    slug: "language-of-page",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    id: "3.2.2",
    level: "A",
    title: "On Input",
    slug: "on-input",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    id: "3.1.3",
    level: "AAA",
    title: "Unusual Words",
    slug: "unusual-words",
    coverage: "ai_assisted",
    defaultSeverity: "minor",
  },
  {
    id: "3.1.4",
    level: "AAA",
    title: "Abbreviations",
    slug: "abbreviations",
    coverage: "ai_assisted",
    defaultSeverity: "minor",
  },
  {
    id: "3.1.5",
    level: "AAA",
    title: "Reading Level",
    slug: "reading-level",
    coverage: "ai_assisted",
    defaultSeverity: "minor",
  },
  {
    id: "3.3.1",
    level: "A",
    title: "Error Identification",
    slug: "error-identification",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    id: "3.3.2",
    level: "A",
    title: "Labels or Instructions",
    slug: "labels-or-instructions",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    // Emitted by the content-quality LLM agent (error suggestion).
    id: "3.3.3",
    level: "AA",
    title: "Error Suggestion",
    slug: "error-suggestion",
    coverage: "ai_assisted",
    defaultSeverity: "major",
  },
  {
    id: "3.3.5",
    level: "AAA",
    title: "Help",
    slug: "help",
    coverage: "ai_assisted",
    defaultSeverity: "minor",
  },
  {
    id: "4.1.1",
    level: "A",
    title: "Parsing",
    slug: "parsing",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    id: "4.1.2",
    level: "A",
    title: "Name, Role, Value",
    slug: "name-role-value",
    coverage: "automated",
    defaultSeverity: "blocker",
  },
  // --- SCs detectable by axe-core rules (or referenced by ESLint maps) that
  // were previously missing from the catalog. Without an entry here, findings
  // for these criteria silently defaulted to level "AA" / severity "major".
  {
    id: "1.2.1",
    level: "A",
    title: "Audio-only and Video-only (Prerecorded)",
    slug: "audio-only-and-video-only-prerecorded",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    id: "1.2.2",
    level: "A",
    title: "Captions (Prerecorded)",
    slug: "captions-prerecorded",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    id: "1.4.2",
    level: "A",
    title: "Audio Control",
    slug: "audio-control",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    id: "1.4.12",
    level: "AA",
    title: "Text Spacing",
    slug: "text-spacing",
    coverage: "automated",
    defaultSeverity: "major",
  },
  {
    id: "2.2.1",
    level: "A",
    title: "Timing Adjustable",
    slug: "timing-adjustable",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    id: "2.2.2",
    level: "A",
    title: "Pause, Stop, Hide",
    slug: "pause-stop-hide",
    coverage: "automated",
    defaultSeverity: "severe",
  },
  {
    id: "2.2.4",
    level: "AAA",
    title: "Interruptions",
    slug: "interruptions",
    coverage: "automated",
    defaultSeverity: "minor",
  },
  {
    id: "3.1.2",
    level: "AA",
    title: "Language of Parts",
    slug: "language-of-parts",
    coverage: "automated",
    defaultSeverity: "major",
  },
  {
    id: "3.2.5",
    level: "AAA",
    title: "Change on Request",
    slug: "change-on-request",
    coverage: "automated",
    defaultSeverity: "minor",
  },
];

// Derive each entry's `url` from its own `slug` post-construction. Done here
// (not inline on each entry) so there is exactly ONE slug→URL rule and no
// temporal-dead-zone referencing a resolver declared later in the file.
export const WCAG_CATALOG: WcagCriterion[] = RAW_WCAG_CATALOG.map((c) => ({
  ...c,
  url: understandingUrl(c.slug),
}));

const catalogIndex = new Map(WCAG_CATALOG.map((c) => [c.id, c]));

export function getCriterion(id: string): WcagCriterion | undefined {
  return catalogIndex.get(id);
}

/**
 * Slugs for WCAG SCs the reporter can LINK to but the catalog does NOT score
 * (manual-audit-only criteria, related-SC references). Catalog-scored SCs are
 * NOT duplicated here — their slug lives on the catalog entry. This is the small
 * companion to the catalog, not a second full slug table.
 */
const EXTRA_SLUG: Record<string, string> = {
  "1.2.3": "audio-description-or-media-alternative-prerecorded",
  "1.2.4": "captions-live",
  "1.2.5": "audio-description-prerecorded",
  "1.2.6": "sign-language-prerecorded",
  "1.2.7": "extended-audio-description-prerecorded",
  "1.2.8": "media-alternative-prerecorded",
  "1.2.9": "audio-only-live",
  "1.3.6": "identify-purpose",
  "1.4.5": "images-of-text",
  "1.4.7": "low-or-no-background-audio",
  "1.4.8": "visual-presentation",
  "1.4.9": "images-of-text-no-exception",
  "1.4.11": "non-text-contrast",
  "1.4.13": "content-on-hover-or-focus",
  "2.1.3": "keyboard-no-exception",
  "2.1.4": "character-key-shortcuts",
  "2.2.3": "no-timing",
  "2.2.5": "re-authenticating",
  "2.2.6": "timeouts",
  "2.3.1": "three-flashes-or-below-threshold",
  "2.3.2": "three-flashes",
  "2.3.3": "animation-from-interactions",
  "2.4.5": "multiple-ways",
  "2.4.8": "location",
  "2.4.13": "focus-appearance",
  "2.5.1": "pointer-gestures",
  "2.5.2": "pointer-cancellation",
  "2.5.4": "motion-actuation",
  "2.5.5": "target-size-enhanced",
  "2.5.6": "concurrent-input-mechanisms",
  "2.5.7": "dragging-movements",
  "3.1.6": "pronunciation",
  "3.2.1": "on-focus",
  "3.2.3": "consistent-navigation",
  "3.2.4": "consistent-identification",
  "3.2.6": "consistent-help",
  "3.3.4": "error-prevention-legal-financial-data",
  "3.3.6": "error-prevention-all",
  "3.3.7": "redundant-entry",
  "3.3.8": "accessible-authentication-minimum",
  "3.3.9": "accessible-authentication-enhanced",
  "4.1.3": "status-messages",
};

/**
 * Canonical W3C "Understanding" URL for a WCAG SC id. Resolution order:
 *   1. Catalog `slug` (the SCs we actually score) — single source of truth.
 *   2. `EXTRA_SLUG` (link-only / manual-audit SCs we reference but don't score).
 *   3. Fall back to the bare SC id (guarded against by the mappings test).
 */
export function understandingUrlForSc(sc: string): string {
  const slug = getCriterion(sc)?.slug ?? EXTRA_SLUG[sc] ?? sc;
  return understandingUrl(slug);
}

/**
 * Stamp the report-facing, SC-derived fields onto a finding from the catalog:
 * the canonical W3C `helpUrl` and the WCAG `wcagLevel`. Idempotent.
 *
 * DELIBERATELY sets ONLY helpUrl + wcagLevel:
 *  - `severity` is NOT recomputed. A finding stores only its primary SC
 *    (`wcagSc = scIds[0]`); severity is the MAX across the finding's FULL SC
 *    list, computed at each source via `severityForScList`. Recomputing from
 *    the single primary SC here would silently downgrade a blocker whose
 *    primary SC happens to be lower-severity (the historical `label` bug).
 *  - `docUrl` (the vendor deep-link) is NOT touched. Each source that has one
 *    (axe → deque, static → GitHub rule docs) sets it explicitly; enrichment
 *    never inspects or moves the incoming URL.
 *
 * When the SC is not in the catalog, the finding is left untouched (a dev-time
 * warning fires; the mappings completeness test makes this path unreachable).
 */
export function enrichFinding(f: Finding): Finding {
  const criterion = getCriterion(f.wcagSc);
  if (!criterion) {
    if (process.env.DEBUG) {
      console.warn(
        `[a11y-scout] enrichFinding: no catalog entry for SC "${f.wcagSc}" ` +
          `(rule ${f.ruleId}); leaving helpUrl/level as-is.`,
      );
    }
    return f;
  }
  return {
    ...f,
    wcagLevel: criterion.level,
    helpUrl: criterion.url,
  };
}

export function enrichFindings(findings: Finding[]): Finding[] {
  return findings.map(enrichFinding);
}

/**
 * Intentional editorial overrides where our WCAG SC mapping differs from
 * axe-core's built-in tags. Each entry documents why we override.
 *
 * RATIONALE: axe-core provides WCAG tags (e.g., "wcag412" → 4.1.2) on 74 of its
 * 104 rules. For most rules, we parse those tags at runtime. This map contains
 * the ~7 cases where we intentionally disagree with axe-core's tagging based on
 * our accessibility SME review or Hyland-specific requirements.
 */
const axeRuleScOverrides: Record<string, string[]> = {
  // axe-core tags with 4.1.2 only, but input images also fail 1.1.1 (missing alt)
  "input-image-alt": ["1.1.1", "4.1.2"],

  // axe-core tags with [2.4.4, 4.1.2], but area-alt primarily fails 1.1.1
  "area-alt": ["1.1.1"],

  // axe-core tags with [1.3.1, 4.1.2], but aria-hidden on body is primarily
  // a Name/Role/Value issue (4.1.2), not Info & Relationships
  "aria-hidden-body": ["4.1.2"],

  // axe-core changed from 4.1.1 (Parsing) to 4.1.2 in recent versions, but
  // duplicate IDs in ARIA contexts are still technically parsing errors per WCAG 2.1.
  // Keeping 4.1.1 for backward compatibility with existing reports.
  "duplicate-id-aria": ["4.1.1"],

  // axe-core tags with 4.1.2 only, but frame-title also serves as a bypass
  // mechanism (2.4.1) per WCAG Understanding docs. 4.1.2 (blocker) is primary.
  "frame-title": ["4.1.2", "2.4.1"],

  // axe-core tags with 4.1.2 only, but label issues also fail 3.3.2 (Labels or
  // Instructions) — a form-specific requirement distinct from general Name/Role/Value.
  // 4.1.2 is primary (blocker severity) since missing labels break programmatic access.
  label: ["4.1.2", "3.3.2"],

  // axe-core tags with [2.1.1, 2.1.3], but we simplify to 2.1.1 (Keyboard) only
  // to avoid duplicate severity assignment for the same underlying issue
  "scrollable-region-focusable": ["2.1.1"],

  // axe-core tags with [2.4.4, 4.1.2]. A link with no discernible text fails
  // both link-purpose (2.4.4) and Name/Role/Value (4.1.2). 4.1.2 (blocker) is
  // primary since a nameless link is unusable by assistive tech.
  "link-name": ["4.1.2", "2.4.4"],
};

/**
 * Editorial assignments of WCAG SC to best-practice rules. axe-core tags these
 * with "best-practice" ONLY (no wcagNNN tags), but we assign them to specific
 * success criteria based on accessibility SME review.
 *
 * RATIONALE: axe-core intentionally avoids claiming WCAG conformance for rules
 * that are judgment calls or "nice to have" patterns. We assign them to criteria
 * here so they receive proper severity classification in reports.
 */
const bestPracticeScAssignments: Record<string, string[]> = {
  "empty-heading": ["2.4.6"], // Headings and Labels
  "heading-order": ["1.3.1", "2.4.6"], // Info & Relationships + Headings
  "label-title-only": ["3.3.2"], // Labels or Instructions
  "landmark-one-main": ["1.3.1"], // Info & Relationships (semantic structure)
  "landmark-unique": ["1.3.1"], // Info & Relationships (semantic structure)
  "page-has-heading-one": ["1.3.1", "2.4.6"], // Info & Relationships + Headings
  region: ["1.3.1"], // Info & Relationships (semantic structure)
  "skip-link": ["2.4.1"], // Bypass Blocks
  tabindex: ["4.1.2"], // Name, Role, Value (focus management)
};

/**
 * Extract WCAG success criterion IDs from axe-core's tag format.
 * Tags like "wcag412" parse to "4.1.2", "wcag258" → "2.5.8", etc.
 *
 * IMPORTANT: This is the primary resolver for WCAG SC mapping. It runs at
 * runtime using axe-core's own metadata, not our manual map.
 */
export function extractAllScFromTags(tags: string[]): string[] {
  const scIds: string[] = [];
  for (const t of tags) {
    const m = /^wcag(\d)(\d{2,})$/.exec(t);
    if (m) {
      const [, a, b] = m;
      if (b && b.length >= 2) {
        const major = a;
        const middle = b.slice(0, 1);
        const last = b.slice(1);
        scIds.push(`${major}.${middle}.${Number(last)}`);
      }
    }
  }
  return scIds;
}

/**
 * Resolve WCAG success criterion IDs for an axe-core rule, using a hybrid
 * runtime-first strategy:
 *
 * 1. Check editorial overrides (intentional disagreements with axe-core)
 * 2. Parse from axe-core's own wcagNNN tags (runtime metadata)
 * 3. Check best-practice assignments (for rules with no wcag tags)
 * 4. Return empty array if no mapping found
 *
 * This replaces the previous axeRuleToScMap which was a static manual map of
 * 47 rules. The new approach auto-covers ~74 rules with WCAG tags, only
 * overriding ~7 rules and manually assigning ~9 best-practice rules.
 */
export function scIdsForAxeRule(ruleId: string, tags: string[]): string[] {
  // Priority 1: Editorial overrides (intentional disagreement with axe-core)
  if (axeRuleScOverrides[ruleId]) {
    return axeRuleScOverrides[ruleId];
  }

  // Priority 2: Parse from axe-core's own tags (runtime metadata)
  const fromTags = extractAllScFromTags(tags);
  if (fromTags.length > 0) {
    return fromTags;
  }

  // Priority 3: Best-practice assignments (rules with no wcag tags)
  if (bestPracticeScAssignments[ruleId]) {
    return bestPracticeScAssignments[ruleId];
  }

  return [];
}

const eslintRuleToScMap: Record<string, string[]> = {
  "jsx-a11y/accessible-emoji": ["1.1.1"],
  "jsx-a11y/alt-text": ["1.1.1"],
  "jsx-a11y/anchor-ambiguous-text": ["2.4.4"],
  "jsx-a11y/anchor-has-content": ["2.4.4"],
  "jsx-a11y/anchor-is-valid": ["2.4.4"],
  "jsx-a11y/aria-activedescendant-has-tabindex": ["4.1.2"],
  "jsx-a11y/aria-props": ["4.1.2"],
  "jsx-a11y/aria-proptypes": ["4.1.2"],
  "jsx-a11y/aria-role": ["4.1.2"],
  "jsx-a11y/aria-unsupported-elements": ["4.1.2"],
  "jsx-a11y/autocomplete-valid": ["1.3.5"],
  "jsx-a11y/click-events-have-key-events": ["2.1.1"],
  "jsx-a11y/control-has-associated-label": ["4.1.2", "1.3.1", "3.3.2"],
  "jsx-a11y/heading-has-content": ["2.4.6"],
  "jsx-a11y/html-has-lang": ["3.1.1"],
  "jsx-a11y/iframe-has-title": ["4.1.2", "2.4.1"],
  "jsx-a11y/img-redundant-alt": ["1.1.1"],
  "jsx-a11y/interactive-supports-focus": ["2.1.1"],
  "jsx-a11y/label-has-associated-control": ["4.1.2", "3.3.2"],
  "jsx-a11y/label-has-for": ["4.1.2", "3.3.2"],
  "jsx-a11y/lang": ["3.1.1"],
  "jsx-a11y/media-has-caption": ["1.2.2"],
  "jsx-a11y/mouse-events-have-key-events": ["2.1.1"],
  "jsx-a11y/no-access-key": ["2.1.1"],
  "jsx-a11y/no-aria-hidden-on-focusable": ["4.1.2"],
  "jsx-a11y/no-autofocus": ["2.4.3"],
  "jsx-a11y/no-distracting-elements": ["2.2.2"],
  "jsx-a11y/no-interactive-element-to-noninteractive-role": ["4.1.2"],
  "jsx-a11y/no-noninteractive-element-interactions": ["4.1.2"],
  "jsx-a11y/no-noninteractive-element-to-interactive-role": ["4.1.2"],
  "jsx-a11y/no-noninteractive-tabindex": ["4.1.2"],
  "jsx-a11y/no-onchange": ["3.2.2"],
  "jsx-a11y/no-redundant-roles": ["4.1.2"],
  "jsx-a11y/no-static-element-interactions": ["2.1.1"],
  "jsx-a11y/prefer-tag-over-role": ["4.1.2"],
  "jsx-a11y/role-has-required-aria-props": ["4.1.2"],
  "jsx-a11y/role-supports-aria-props": ["4.1.2"],
  "jsx-a11y/scope": ["1.3.1"],
  "jsx-a11y/tabindex-no-positive": ["2.4.3"],
};

export function scIdsForEslintRule(ruleId: string): string[] {
  return eslintRuleToScMap[ruleId] ?? [];
}

const angularTemplateRuleToScMap: Record<string, string[]> = {
  "@angular-eslint/template/alt-text": ["1.1.1"],
  "@angular-eslint/template/elements-content": ["4.1.2"],
  "@angular-eslint/template/interactive-supports-focus": ["2.1.1"],
  "@angular-eslint/template/label-has-associated-control": ["4.1.2", "3.3.2"],
  "@angular-eslint/template/click-events-have-key-events": ["2.1.1"],
  "@angular-eslint/template/mouse-events-have-key-events": ["2.1.1"],
  "@angular-eslint/template/no-autofocus": ["2.4.3"],
  "@angular-eslint/template/no-distracting-elements": ["2.2.2"],
  "@angular-eslint/template/role-has-required-aria": ["4.1.2"],
  "@angular-eslint/template/table-scope": ["1.3.1"],
  "@angular-eslint/template/valid-aria": ["4.1.2"],
};

export function scIdsForAngularTemplateRule(ruleId: string): string[] {
  return angularTemplateRuleToScMap[ruleId] ?? [];
}

export const ANGULAR_TEMPLATE_RULE_IDS = Object.keys(angularTemplateRuleToScMap);

// Rules that flag the same underlying defect. Collapsing them stops a single
// `<div onClick>` from being counted twice (once for missing keyboard
// listener, once for non-interactive element with click). Add an entry here
// when two rules consistently co-fire on the same line for the same root
// cause; leave rules out when they describe genuinely different problems.
const ruleEquivalenceGroups: Record<string, string> = {
  "jsx-a11y/click-events-have-key-events": "static-element-click",
  "jsx-a11y/no-static-element-interactions": "static-element-click",
  "jsx-a11y/no-noninteractive-element-interactions": "static-element-click",
};

export function equivalenceGroupForRule(ruleId: string): string {
  return ruleEquivalenceGroups[ruleId] ?? ruleId;
}
