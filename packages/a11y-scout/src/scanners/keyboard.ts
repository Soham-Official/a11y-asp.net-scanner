import zlib from "node:zlib";
import { v4 as uuidv4 } from "uuid";
import type { Finding, PassedRule, ScanLevel } from "../types.js";
import type { PageDriver } from "../driver/interfaces.js";
import { getCriterion, severityForSc } from "../wcag.js";
import { FOCUS_ORDER_CONFIG } from "../config/focus-order.js";

/** Stable rule id — used as the validator dedup key AND the PassedRule ruleId. Constant. */
export const KEYBOARD_TRAP_RULE_ID = "keyboard-trap";

/** Phase-2 rule ids. Each doubles as the validator dedup key for its finding. */
export const FOCUS_OFFSCREEN_RULE_ID = "focus-offscreen"; // Point 1 → 2.4.3 / 2.4.7
export const FOCUS_INDICATOR_RULE_ID = "focus-indicator-missing"; // Point 2 → 2.4.7
export const MODAL_FOCUS_LEAK_RULE_ID = "modal-focus-leak"; // Point 3 → 2.4.3 / 2.1.2
export const FOCUS_ORDER_RULE_ID = "focus-order-divergence"; // Point 4 → 2.4.3
export const FOCUS_OBSCURED_MIN_RULE_ID = "focus-obscured-min"; // Point 5 → 2.4.11
export const FOCUS_OBSCURED_ENHANCED_RULE_ID = "focus-obscured-enhanced"; // Point 5 → 2.4.12

export interface KeyboardTrapOptions {
  maxSteps?: number; // hard cap on key presses regardless of focusable count. Default 300.
  settleMs?: number; // settle wait (ms) after each press. Default 40.
}

/**
 * Phase-2 focus-check toggles. All three checks (off-screen focus, focus
 * indicator, modal leak) ride the SAME focus walk as the Phase-1 trap detector.
 */
export interface FocusCheckOptions {
  level?: ScanLevel; // gates the AA-only focus-indicator check (Point 2)
  inCrawl?: boolean; // disable tier-2 screenshots; emit per-page summary instead
  focusChecks?: boolean; // master switch for Points 1/2/3 (default true)
  noFocusIndicatorScreenshots?: boolean; // disable tier-2 on a single page
}

// Number of computed-style properties compared for the focus-indicator check.
const FOCUS_INDICATOR_PROPS = [
  "outlineStyle",
  "outlineWidth",
  "outlineColor",
  "boxShadow",
  "borderTopColor",
  "borderTopWidth",
  "borderBottomColor",
  "borderLeftColor",
  "borderRightColor",
  "backgroundColor",
  "color",
] as const;

// Tier-2 screenshot tuning (single-page only).
const FOCUS_INDICATOR_SCREENSHOT_CAP = 30; // max candidates screenshotted per page
const FOCUS_INDICATOR_CHANGED_PIXEL_THRESHOLD = 0.005; // >=0.5% changed ⇒ indicator exists

/** Per-step observation accumulator — passed by reference into walkOneDirection
 * so the single-pass walk doesn't keep widening its return tuple. */
interface WalkObservations {
  traps: TrapInfo[]; // Phase-1 output (was the return value)
  leaks: ModalLeakInfo[]; // Point 3
  offscreen: FocusVisibilityInfo[]; // Point 1
  indicatorCandidates: IndicatorCandidate[]; // Point 2 tier-1
  // === Point 4 — tab-order divergence ===
  // The sequence of naturally-Tab-reached elements (forward walk only; see note
  // in walkOneDirection). Accumulated across the FORWARD walk; the backward walk
  // does not append (a single clean forward sequence is the cleanest signal).
  focusOrder: FocusOrderStep[];
  // Set false if ANY programmatic jump happened during the forward walk (trap
  // recovery). When false we never emit the finding (the sequence is corrupted).
  focusOrderReliable: boolean;
  // Point 5 — focused element is fully (min, 2.4.11) or partially (enhanced, 2.4.12)
  // covered by a position:fixed or position:sticky overlay.
  obscured: FocusObscuredInfo[];
}

interface ModalLeakInfo {
  modalSelector: string;
  modalKind: "modal-true" | "role-dialog" | "dialog-modal";
  isTopLayerModal: boolean;
  leakedTo: { selector: string; role: string; name: string };
  direction: "forward" | "backward";
}

interface FocusVisibilityInfo {
  selector: string;
  reason:
    | "offscreen"
    | "display-none"
    | "visibility-hidden"
    | "opacity-zero"
    | "zero-area";
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  scrolledIntoViewFailed: boolean;
  tabIndex: number;
  screenshotDataUri?: string;
}

interface FocusObscuredInfo {
  selector: string;
  level: "min" | "enhanced"; // "min" = full obstruction (4/4 corners), "enhanced" = partial
  obstructorSelector: string;
  obstructorPosition: "fixed" | "sticky";
  focusedRect: { x: number; y: number; width: number; height: number };
  obstructorRect: { x: number; y: number; width: number; height: number };
  coveredCorners: number; // 0..4
  coveredSamplePoints: number; // 0..8
  tabIndex: number;
}

interface IndicatorCandidate {
  selector: string;
  role: string;
  name: string;
  // The focused-state computed style snapshot, kept so tier-1 can diff it
  // against the same element's later unfocused read.
  focusedStyle: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
}

/** Point 4 — one naturally-Tab-reached element, captured for tab-order analysis.
 * Only real key-press landings are recorded; programmatic jumps are excluded and
 * instead flip the `focusOrderReliable` flag (see WalkObservations). */
interface FocusOrderStep {
  selector: string;
  role: string;
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  // 1-based DOM/document-order rank captured at landing time (from readFocusContext
  // extension). Used to build domOrder without a second DOM pass.
  domRank: number;
}

/** What readFocusContext returns for the current activeElement each Tab step. */
interface FocusContext {
  selector: string;
  role: string;
  name: string;
  isBody: boolean;
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  inViewport: boolean;
  display: string;
  visibility: string;
  opacity: number;
  isSkipLinkLike: boolean;
  style: Record<string, string>;
  modal: {
    selector: string;
    kind: "modal-true" | "role-dialog" | "dialog-modal";
    isTopLayerModal: boolean;
  } | null;
  insideModalSubtree: boolean;
  domRank: number; // 1-based document-order rank among focusables; -1 if body/unknown
}

/** Resolved per-walk context derived from FocusCheckOptions. */
interface WalkContext {
  focusChecks: boolean;
  level: ScanLevel;
  inCrawl: boolean;
  noFocusIndicatorScreenshots: boolean; // opt-out for tier-2 pixel-diff (single-page only)
}

interface ActiveSig {
  selector: string; // deterministic CSS selector of effective activeElement
  tag: string;
  role: string; // explicit role attr, or derived from tag (link, button, input[type], …)
  name: string; // accessible name approximation (aria-label, label, text, value, …)
  outerHTML: string; // sliced ~300 chars
  isBody: boolean; // activeElement === body or null → focus left to chrome
  inModal: boolean;
  modalSelector: string | null;
  hasCloseControlInCycle: boolean; // a focusable [aria-label*=close]/button.close/[data-dismiss] in the cycle
  frameDepth: number; // 0 = top doc; >0 = same-origin iframe
}

/** A single element in the captured focus cycle, annotated for the report. */
interface CycleStep {
  selector: string;
  role: string;
  name: string;
}

/** Everything observed during the walk, surfaced as report evidence. */
interface TrapEvidence {
  direction: "forward" | "backward" | "both";
  cycle: CycleStep[]; // the repeating loop only (minimal proof of the trap)
  keysAttempted: { key: string; result: string }[];
  modal: { selector: string; closeControl: { selector: string; name: string } | null } | null;
  screenshotDataUri?: string;
}

interface TrapInfo {
  region: string; // modal or region selector
  trapped: ActiveSig;
  kind: "modal-review" | "modal-blocker" | "region";
  evidence: TrapEvidence;
}

/**
 * Returns findings (traps/reviews) AND passes. `passes` contains ONE PassedRule for 2.1.2
 * when the walk completed cleanly (no findings, ≥1 focusable element); empty otherwise.
 * Returning the PassedRule from the scanner avoids the fixture + runtime callers each
 * rebuilding it (focusableCount lives here).
 */
export async function runKeyboardTrapChecks(
  args: { page: PageDriver; url: string } & KeyboardTrapOptions & FocusCheckOptions,
): Promise<{ findings: Finding[]; passes: PassedRule[] }> {
  const { page, url } = args;
  const maxSteps = args.maxSteps ?? 150;  // Reduced from 300 for performance
  const settleMs = args.settleMs ?? 20;   // Reduced from 40ms for faster walks

  // Phase-2 context. focusChecks defaults ON (opt-out via --no-focus-checks).
  const ctx: WalkContext = {
    focusChecks: args.focusChecks !== false,
    level: args.level ?? "AA",
    inCrawl: args.inCrawl === true,
    noFocusIndicatorScreenshots: args.noFocusIndicatorScreenshots === true,
  };
  // Tier-2 screenshots: ON by default for single pages (thorough detection).
  // Crawl auto-disables tier-2 to bound per-page cost. Single-page users can
  // opt out via --no-focus-indicator-screenshots.
  const tier2Enabled = !ctx.noFocusIndicatorScreenshots && !ctx.inCrawl;

  // Install determinism shim
  await installDeterminismShim(page);

  // Count focusable elements
  const focusableCount = await countFocusable(page);
  if (focusableCount === 0) {
    return { findings: [], passes: [] };
  }

  // Cycle detection needs to see a selector 3 times — i.e. traverse an N-element
  // loop ~3 times — so the cap must be at least ~3*N. `*2` could never trigger
  // detection on a real trap (a 3-input trap first repeats on the 7th press).
  const cap = Math.min(focusableCount * 3 + 10, maxSteps);

  // Enumerate all focusable elements in DOM order (once, up front)
  const focusableList = await enumerateFocusables(page);

  // Reset focus to body
  await resetFocusToBody(page);

  // Walk both directions ONCE, accumulating traps + Phase-2 observations.
  const obs: WalkObservations = {
    traps: [],
    leaks: [],
    offscreen: [],
    indicatorCandidates: [],
    focusOrder: [],
    focusOrderReliable: true,
    obscured: [],
  };
  await walkOneDirection(page, "Tab", cap, settleMs, focusableList, obs, ctx);
  await resetFocusToBody(page);
  await walkOneDirection(page, "Shift+Tab", cap, settleMs, focusableList, obs, ctx);

  // === Phase 1: keyboard traps ===
  const deduped = dedupeByRegion(obs.traps);
  // Capture one screenshot per trap (trapped element outlined) as evidence.
  // Traps are rare + severe, so this scoped screenshot is worth the small cost.
  for (const trap of deduped) {
    trap.evidence.screenshotDataUri = await captureTrapScreenshot(
      page,
      trap.region,
    );
  }
  const findings: Finding[] = deduped.map((trap) => buildFinding(trap, url));

  // === Point 3: modal focus leaks ===
  const dedupedLeaks = dedupeLeaksByModal(obs.leaks);
  for (const leak of dedupedLeaks) {
    const shot = await captureTrapScreenshot(page, leak.modalSelector);
    findings.push(buildModalLeakFinding(leak, url, shot));
  }

  // === Point 1: off-screen / invisible focus ===
  // Suppress any off-screen observation that is already reported as a modal
  // leak (same focus landing — avoid double-reporting).
  const leakedSelectors = new Set(
    dedupedLeaks.map((l) => l.leakedTo.selector),
  );
  const dedupedOffscreen = dedupeOffscreenBySelector(
    obs.offscreen.filter((o) => !leakedSelectors.has(o.selector)),
  );
  for (const info of dedupedOffscreen) {
    // Screenshot only the cases where there is something visible to show, and
    // only when not crawling (shares the tier-2 crawl auto-disable rationale).
    if (
      tier2Enabled &&
      (info.reason === "offscreen" || info.reason === "zero-area")
    ) {
      info.screenshotDataUri = await captureTrapScreenshot(page, info.selector);
    }
    findings.push(buildFocusVisibilityFinding(info, url));
  }

  // === Point 2: focus indicator (AA only) ===
  if (ctx.focusChecks && ctx.level !== "A" && obs.indicatorCandidates.length > 0) {
    const candidates = dedupeCandidatesBySelector(obs.indicatorCandidates);
    if (!tier2Enabled) {
      // Tier-2 skipped: ONE per-page summary review finding (no screenshots).
      // skipReason distinguishes crawl-auto-disable from explicit user opt-out
      // so the report can show the right rescan instructions.
      const skipReason: "crawl" | "user-opt-out" = ctx.inCrawl
        ? "crawl"
        : "user-opt-out";
      findings.push(
        buildIndicatorCrawlSummary(candidates.length, url, skipReason),
      );
    } else {
      // Single page: screenshot-verify each candidate; only flag the ones
      // where no focus indicator pixels appear (tier-2 confirms a true miss).
      const verifyList = candidates.slice(0, FOCUS_INDICATOR_SCREENSHOT_CAP);
      for (const cand of verifyList) {
        const verdict = await verifyIndicatorByScreenshot(page, cand, settleMs);
        if (!verdict.hasIndicator) {
          findings.push(
            buildIndicatorFinding(
              cand,
              url,
              verdict.changedRatio,
              verdict.focusedShot,
            ),
          );
        }
      }
    }
  }

  // === Point 5: 2.4.11 / 2.4.12 — focus obscured ===
  if (ctx.focusChecks && obs.obscured.length > 0) {
    const dedup = dedupeObscuredBySelector(obs.obscured);
    for (const info of dedup) {
      if (info.level === "min") {
        // 2.4.11 fires whenever fully obscured (any level A/AA/AAA includes AA)
        findings.push(buildFocusObscuredFinding(info, "min", url));
      } else if (ctx.level === "AAA") {
        // 2.4.12 (AAA only) — partial obstruction
        findings.push(buildFocusObscuredFinding(info, "enhanced", url));
      }
    }
  }

  // === Point 4: geometric tab-order divergence (2.4.3, review-only) ===
  // Rides focusChecks (no separate flag). At most ONE finding per page. The
  // conjunctive gate + reliability flag keep this quiet on flex/grid/RTL/sticky.
  if (ctx.focusChecks) {
    const writingDirection = await readWritingDirection(page);
    const decision = decideFocusOrderFinding({
      steps: obs.focusOrder,
      reliable: obs.focusOrderReliable,
      writingDirection,
    });
    if (decision) {
      findings.push(buildFocusOrderFinding(decision, writingDirection, url));
    }
  }

  // Emit passed rule if no trap findings and we had focusable elements.
  // (Scoped to traps so Phase-2 review findings don't suppress the 2.1.2 pass.)
  const passes: PassedRule[] = [];
  const hasTrap = findings.some((f) => f.ruleId === KEYBOARD_TRAP_RULE_ID);
  if (!hasTrap && focusableCount > 0) {
    const criterion = getCriterion("2.1.2");
    passes.push({
      ruleId: KEYBOARD_TRAP_RULE_ID,
      description: criterion?.title ?? "No Keyboard Trap",
      helpUrl: criterion?.url,
      wcagSc: "2.1.2",
      wcagLevel: "A",
      tags: ["keyboard", "wcag2a", "wcag212", "cat.keyboard"],
      nodeCount: focusableCount,
      sampleSelectors: [],
      pageUrls: [url],
    });
  }

  return { findings, passes };
}

async function installDeterminismShim(page: PageDriver): Promise<void> {
  await page.addStyleTag({
    content: `* {
      transition: none !important;
      animation: none !important;
      scroll-behavior: auto !important;
    }`,
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
}

async function countFocusable(page: PageDriver): Promise<number> {
  return page.evaluate(() => {
    const selector =
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
    return document.querySelectorAll(selector).length;
  });
}

async function resetFocusToBody(page: PageDriver): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active && "blur" in active && typeof active.blur === "function") {
      active.blur();
    }
    document.body.focus();
  });
}

/**
 * Enumerate all focusable elements in DOM order (document order, not tab order).
 * Returns a stable ordered list of CSS selectors for all focusable elements.
 * This is used to resume walking after detecting a trap.
 */
async function enumerateFocusables(page: PageDriver): Promise<string[]> {
  return page.evaluate(/* js */`
    (() => {
      // Same focusable selector as countFocusable
      const selector = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
      const elements = Array.from(document.querySelectorAll(selector));

      // Build deterministic CSS selector for each element (same logic as cssSelectorFor)
      const cssSelectorFor = (el) => {
        if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
          return '#' + CSS.escape(el.id);
        }
        const tag = el.tagName.toLowerCase();
        const parent = el.parentElement;
        if (!parent) return tag;
        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        const index = siblings.indexOf(el) + 1;
        const parentSelector = parent === document.body ? '' : cssSelectorFor(parent);
        return parentSelector ? parentSelector + ' > ' + tag + ':nth-of-type(' + index + ')' : tag + ':nth-of-type(' + index + ')';
      };

      return elements.map(el => cssSelectorFor(el));
    })()
  `);
}

async function readActiveSignature(page: PageDriver): Promise<ActiveSig | null> {
  // Inline everything to avoid tsx __name helper injection
  return page.evaluate(/* js */`
    (() => {
      // Helper to find deepest activeElement (recurses shadow roots + iframes)
      const getDeepestActive = (doc, depth = 0) => {
        let current = doc.activeElement;
        if (!current) return { el: null, depth };
        while (current.shadowRoot?.activeElement) {
          current = current.shadowRoot.activeElement;
        }
        if (current instanceof HTMLIFrameElement) {
          try {
            const iframeDoc = current.contentDocument;
            if (iframeDoc) return getDeepestActive(iframeDoc, depth + 1);
          } catch {}
        }
        return { el: current, depth };
      };

      // Build deterministic CSS selector
      const cssSelectorFor = (el) => {
        if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
          return '#' + CSS.escape(el.id);
        }
        const tag = el.tagName.toLowerCase();
        const parent = el.parentElement;
        if (!parent) return tag;
        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        const index = siblings.indexOf(el) + 1;
        const parentSelector = parent === document.body ? '' : cssSelectorFor(parent);
        return parentSelector ? parentSelector + ' > ' + tag + ':nth-of-type(' + index + ')' : tag + ':nth-of-type(' + index + ')';
      };

      // Check if element is in a modal
      const regionContext = (el) => {
        let current = el;
        while (current) {
          if (
            current.getAttribute('role') === 'dialog' ||
            current.getAttribute('aria-modal') === 'true' ||
            (current instanceof HTMLDialogElement && current.open)
          ) {
            return { inModal: true, modalSelector: cssSelectorFor(current) };
          }
          current = current.parentElement;
        }
        return { inModal: false, modalSelector: null };
      };

      // Best-effort role: explicit role attr, else derived from tag/type.
      const roleFor = (el) => {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a' && el.hasAttribute('href')) return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input') return 'input[' + (el.getAttribute('type') || 'text') + ']';
        return tag;
      };

      // Accessible name approximation (not full ARIA algorithm, but close
      // enough to make the cycle human-readable): aria-label > aria-labelledby
      // text > associated <label> > title > value/placeholder > trimmed text.
      const nameFor = (el) => {
        const aria = el.getAttribute('aria-label');
        if (aria && aria.trim()) return aria.trim();
        const labelledby = el.getAttribute('aria-labelledby');
        if (labelledby) {
          const ref = document.getElementById(labelledby);
          if (ref && ref.textContent && ref.textContent.trim()) return ref.textContent.trim();
        }
        if (el.id) {
          const label = document.querySelector('label[for="' + (window.CSS ? CSS.escape(el.id) : el.id) + '"]');
          if (label && label.textContent && label.textContent.trim()) return label.textContent.trim();
        }
        const title = el.getAttribute('title');
        if (title && title.trim()) return title.trim();
        const text = (el.textContent || '').trim();
        if (text) return text.slice(0, 80);
        const val = el.getAttribute('value');
        if (val && val.trim()) return val.trim();
        const ph = el.getAttribute('placeholder');
        if (ph && ph.trim()) return ph.trim();
        return '';
      };

      const { el, depth } = getDeepestActive(document);
      if (!el) return null;

      const isBody = el === document.body || el === document.documentElement;
      const { inModal, modalSelector } = regionContext(el);
      const selector = cssSelectorFor(el);
      const tag = el.tagName.toLowerCase();
      const outerHTML = el.outerHTML.slice(0, 300);

      return {
        selector,
        tag,
        role: roleFor(el),
        name: nameFor(el),
        outerHTML,
        isBody,
        inModal,
        modalSelector,
        hasCloseControlInCycle: false,
        frameDepth: depth,
      };
    })()
  `);
}

/**
 * Per-step probe for the Phase-2 focus checks. Sibling of readActiveSignature;
 * runs ONE page.evaluate per Tab step (only when focusChecks is on) and returns
 * everything Points 1/2/3 need: visibility geometry, computed-style subset, and
 * the nearest open modal/dialog context.
 *
 * STRING-SERIALIZED on purpose — matching readActiveSignature/enumerateFocusables/
 * findCommonAncestor. tsx injects a `__name` helper around nested *named*
 * functions which is undefined in the page context ("ReferenceError: __name is
 * not defined"); inline arrow consts inside a template-literal evaluate dodge it.
 */
async function readFocusContext(page: PageDriver): Promise<FocusContext | null> {
  return page.evaluate(/* js */ `
    (() => {
      const getDeepestActive = (doc, depth = 0) => {
        let current = doc.activeElement;
        if (!current) return { el: null, depth };
        while (current.shadowRoot?.activeElement) {
          current = current.shadowRoot.activeElement;
        }
        if (current instanceof HTMLIFrameElement) {
          try {
            const iframeDoc = current.contentDocument;
            if (iframeDoc) return getDeepestActive(iframeDoc, depth + 1);
          } catch {}
        }
        return { el: current, depth };
      };

      const cssSelectorFor = (el) => {
        if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
          return '#' + CSS.escape(el.id);
        }
        const tag = el.tagName.toLowerCase();
        const parent = el.parentElement;
        if (!parent) return tag;
        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        const index = siblings.indexOf(el) + 1;
        const parentSelector = parent === document.body ? '' : cssSelectorFor(parent);
        return parentSelector ? parentSelector + ' > ' + tag + ':nth-of-type(' + index + ')' : tag + ':nth-of-type(' + index + ')';
      };

      const FOCUSABLE_SEL = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
      const domRankFor = (el) => {
        const all = Array.from(document.querySelectorAll(FOCUSABLE_SEL));
        const idx = all.indexOf(el);
        return idx < 0 ? -1 : idx + 1; // 1-based; -1 if not in the focusable set
      };

      // Nearest open dialog/modal ancestor + how it was opened. Classification:
      //   :modal matches  → 'dialog-modal' (top layer, showModal()/fullscreen)
      //   aria-modal=true → 'modal-true'   (author declared modality)
      //   role=dialog     → 'role-dialog'  (bare; modality unknown)
      const modalCtx = (el) => {
        let cur = el;
        while (cur && cur !== document.body) {
          const isOpenDialog = cur instanceof HTMLDialogElement && cur.open;
          const ariaModal = cur.getAttribute && cur.getAttribute('aria-modal') === 'true';
          const roleDialog = cur.getAttribute && cur.getAttribute('role') === 'dialog';
          if (isOpenDialog || ariaModal || roleDialog) {
            let top = false;
            try { top = cur.matches(':modal'); } catch (e) { top = false; }
            const kind = top ? 'dialog-modal' : (ariaModal ? 'modal-true' : 'role-dialog');
            return { selector: cssSelectorFor(cur), kind, isTopLayerModal: top };
          }
          cur = cur.parentElement;
        }
        return null;
      };

      const roleFor = (el) => {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a' && el.hasAttribute('href')) return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input') return 'input[' + (el.getAttribute('type') || 'text') + ']';
        return tag;
      };

      const nameFor = (el) => {
        const aria = el.getAttribute('aria-label');
        if (aria && aria.trim()) return aria.trim();
        const txt = (el.textContent || '').trim();
        if (txt) return txt.slice(0, 80);
        const val = el.getAttribute('value');
        if (val && val.trim()) return val.trim();
        return '';
      };

      const { el } = getDeepestActive(document);
      if (!el) return null;
      const isBody = el === document.body || el === document.documentElement;

      const emptyStyle = { outlineStyle:'',outlineWidth:'',outlineColor:'',boxShadow:'',
        borderTopColor:'',borderTopWidth:'',borderBottomColor:'',borderLeftColor:'',
        borderRightColor:'',backgroundColor:'',color:'' };

      if (isBody) {
        return { selector: 'body', role: 'body', name: '', isBody: true,
          rect: {x:0,y:0,width:0,height:0}, viewport: {width: window.innerWidth, height: window.innerHeight},
          inViewport: true, display: '', visibility: '', opacity: 1, isSkipLinkLike: false,
          style: emptyStyle, modal: null, insideModalSubtree: false, domRank: -1 };
      }

      const cs = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const inViewport = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
      const m = modalCtx(el);
      const href = (el.getAttribute && el.getAttribute('href')) || '';
      const skipLinkLike = href.charAt(0) === '#' && roleFor(el) === 'link';

      return {
        selector: cssSelectorFor(el),
        role: roleFor(el),
        name: nameFor(el),
        isBody: false,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        viewport: { width: vw, height: vh },
        inViewport,
        display: cs.display,
        visibility: cs.visibility,
        opacity: parseFloat(cs.opacity || '1'),
        isSkipLinkLike: skipLinkLike,
        style: {
          outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor,
          boxShadow: cs.boxShadow,
          borderTopColor: cs.borderTopColor, borderTopWidth: cs.borderTopWidth,
          borderBottomColor: cs.borderBottomColor, borderLeftColor: cs.borderLeftColor,
          borderRightColor: cs.borderRightColor,
          backgroundColor: cs.backgroundColor, color: cs.color,
        },
        modal: m,
        insideModalSubtree: !!m,
        domRank: domRankFor(el),
      };
    })()
  `);
}

/** Point 5: read focus obstruction evidence (2.4.11 / 2.4.12). Returns null if
 * no fixed/sticky overlay obscures the focused element. Uses the same string-
 * serialized evaluate pattern as readFocusContext to avoid tsx __name injection. */
async function readFocusObstruction(page: PageDriver): Promise<{
  selector: string;
  obstructorSelector: string;
  obstructorPosition: "fixed" | "sticky";
  focusedRect: { x: number; y: number; width: number; height: number };
  obstructorRect: { x: number; y: number; width: number; height: number };
  coveredCorners: number;
  coveredSamplePoints: number;
} | null> {
  return page.evaluate(/* js */ `
    (() => {
      const cssSelectorFor = (el) => {
        if (!el || el.nodeType !== 1) return "";
        if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
          return "#" + CSS.escape(el.id);
        }
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
          let s = cur.tagName.toLowerCase();
          if (cur.parentElement) {
            const sibs = Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName);
            if (sibs.length > 1) s += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
          }
          parts.unshift(s);
          cur = cur.parentElement;
        }
        return parts.join(" > ");
      };
      const getDeepestActive = (doc) => {
        let el = doc.activeElement;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
        return el;
      };
      const el = getDeepestActive(document);
      if (!el || el === document.body || el === document.documentElement) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return null;

      const samples = [
        { x: r.left + 1, y: r.top + 1 },
        { x: r.right - 1, y: r.top + 1 },
        { x: r.left + 1, y: r.bottom - 1 },
        { x: r.right - 1, y: r.bottom - 1 },
        { x: (r.left + r.right) / 2, y: r.top + 1 },
        { x: (r.left + r.right) / 2, y: r.bottom - 1 },
        { x: r.left + 1, y: (r.top + r.bottom) / 2 },
        { x: r.right - 1, y: (r.top + r.bottom) / 2 },
      ];
      const MODAL_SEL = 'dialog[open],[aria-modal="true"],[role="dialog"]';
      const findObstructorAt = (pt) => {
        if (pt.x < 0 || pt.y < 0) return null;
        const stack = document.elementsFromPoint(pt.x, pt.y);
        for (const cand of stack) {
          if (cand === el) return null;
          if (cand.contains && cand.contains(el)) {
            // Ancestor cannot visually obscure its descendant — skip it.
            continue;
          }
          const cs = window.getComputedStyle(cand);
          if (cs.position !== "fixed" && cs.position !== "sticky") continue;
          return cand;
        }
        return null;
      };
      let coveredCorners = 0, coveredSamplePoints = 0;
      let obstructor = null;
      for (let i = 0; i < samples.length; i++) {
        const o = findObstructorAt(samples[i]);
        if (o) {
          coveredSamplePoints++;
          if (i < 4) coveredCorners++;
          if (!obstructor) obstructor = o;
        }
      }
      if (!obstructor) return null;
      const cs = window.getComputedStyle(obstructor);
      const or = obstructor.getBoundingClientRect();
      return {
        selector: cssSelectorFor(el),
        obstructorSelector: cssSelectorFor(obstructor),
        obstructorPosition: cs.position,
        focusedRect: { x: r.x, y: r.y, width: r.width, height: r.height },
        obstructorRect: { x: or.x, y: or.y, width: or.width, height: or.height },
        coveredCorners,
        coveredSamplePoints,
      };
    })()
  `);
}

/** Read a computed-style subset for an arbitrary selector (the now-UNFOCUSED
 * baseline for the focus-indicator diff). Flat single-arg evaluate — no nested
 * named function, so no tsx `__name` risk. */
async function readStyleSubset(
  page: PageDriver,
  selector: string,
): Promise<Record<string, string> | null> {
  return page.evaluate((sel: string) => {
    let el: Element | null = null;
    try {
      el = document.querySelector(sel);
    } catch {
      el = null;
    }
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    return {
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      outlineColor: cs.outlineColor,
      boxShadow: cs.boxShadow,
      borderTopColor: cs.borderTopColor,
      borderTopWidth: cs.borderTopWidth,
      borderBottomColor: cs.borderBottomColor,
      borderLeftColor: cs.borderLeftColor,
      borderRightColor: cs.borderRightColor,
      backgroundColor: cs.backgroundColor,
      color: cs.color,
    };
  }, selector);
}

/** True if `descSel` element is contained within `ancestorSel` element. Used by
 * the modal-leak nested-dialog guard. Flat two-arg evaluate. */
async function isDescendantSelector(
  page: PageDriver,
  ancestorSel: string,
  descSel: string,
): Promise<boolean> {
  return page.evaluate(
    ({ a, b }: { a: string; b: string }) => {
      try {
        const anc = document.querySelector(a);
        const desc = document.querySelector(b);
        return !!(anc && desc && anc !== desc && anc.contains(desc));
      } catch {
        return false;
      }
    },
    { a: ancestorSel, b: descSel },
  );
}

/** Scroll the current activeElement into view and re-measure. The browser already
 * focus-scrolls; this explicit pass is the false-positive guard for Point 1 — we
 * only flag "offscreen" if the element is STILL out of view afterward. */
async function scrollActiveIntoViewAndRemeasure(
  page: PageDriver,
): Promise<{ inViewport: boolean } | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    try {
      (el as HTMLElement).scrollIntoView({ block: "center", inline: "center" });
    } catch {
      /* ignore */
    }
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const inViewport =
      r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    return { inViewport };
  });
}

/**
 * Walk one direction with a resumable algorithm that detects ALL keyboard traps on the page.
 * After detecting a trap, programmatically jumps focus to the first focusable element not yet
 * visited, then continues the real-key Tab walk from there. This detection aid allows us to
 * discover traps PAST the first one (a real keyboard user could not bypass a trap).
 */
async function walkOneDirection(
  page: PageDriver,
  key: "Tab" | "Shift+Tab",
  cap: number,
  settleMs: number,
  focusableList: string[],
  obs: WalkObservations,
  ctx: WalkContext,
): Promise<void> {
  // Phase-1 traps accumulate into the shared observations object.
  const traps = obs.traps;
  const direction: "forward" | "backward" =
    key === "Tab" ? "forward" : "backward";

  // Track element state: cleared (visited then left), trapped (in a confirmed cycle), unknown (never visited)
  const clearedSelectors = new Set<string>();
  const trappedSelectors = new Set<string>();

  // Track full sigs (not just selectors) for the current walk segment
  let visitedSigs: ActiveSig[] = [];
  let counts = new Map<string, number>();
  let totalKeyPresses = 0;

  // === Phase-2 per-step state (only used when ctx.focusChecks) ===
  // The modal subtree focus was in on the PREVIOUS step (for leak detection).
  let lastInModal: FocusContext["modal"] = null;
  // The previously focused element + its focused-style snapshot (for the
  // focus-indicator tier-1 delta — read its unfocused style once focus leaves).
  let pendingPrev: {
    selector: string;
    role: string;
    name: string;
    focusedStyle: Record<string, string>;
    rect: { x: number; y: number; width: number; height: number };
  } | null = null;

  // Run all Phase-2 observations for one natural focus landing. Called only on
  // the top-of-loop read after a REAL key press (never on programmatic jumps).
  const observeFocusStep = async (): Promise<void> => {
    if (!ctx.focusChecks) return;
    const fc = await readFocusContext(page);

    // --- Point 3: modal focus leak ---
    if (lastInModal && fc && !fc.isBody) {
      const stillInSameModal =
        fc.insideModalSubtree && fc.modal?.selector === lastInModal.selector;
      if (!stillInSameModal) {
        const stillOpen = await modalStillOpen(page, lastInModal.selector);
        // Focus is still contained inside the previous modal's subtree (e.g. a
        // wrapper around a nested dialog): not a leak.
        const stillInsideSubtree = await isDescendantSelector(
          page,
          lastInModal.selector,
          fc.selector,
        );
        // Focus moved INTO a deeper dialog that is a descendant of the previous
        // modal — not a leak (nested-dialog guard).
        const movedIntoNested =
          fc.modal != null &&
          fc.modal.selector !== lastInModal.selector &&
          (await isDescendantSelector(
            page,
            lastInModal.selector,
            fc.modal.selector,
          ));
        // Focus moved OUT to an ancestor dialog that still contains the previous
        // modal — focus never reached the background, so not a leak.
        const movedIntoAncestor =
          fc.modal != null &&
          fc.modal.selector !== lastInModal.selector &&
          (await isDescendantSelector(
            page,
            fc.modal.selector,
            lastInModal.selector,
          ));
        if (
          stillOpen &&
          !stillInsideSubtree &&
          !movedIntoNested &&
          !movedIntoAncestor
        ) {
          obs.leaks.push({
            modalSelector: lastInModal.selector,
            modalKind: lastInModal.kind,
            isTopLayerModal: lastInModal.isTopLayerModal,
            leakedTo: { selector: fc.selector, role: fc.role, name: fc.name },
            direction,
          });
        }
      }
    }
    lastInModal = fc && fc.insideModalSubtree && fc.modal ? fc.modal : null;

    if (!fc || fc.isBody) {
      // Focus left to body/chrome: no offscreen/indicator observation, and the
      // indicator-delta chain is broken — reset it.
      pendingPrev = null;
      return;
    }

    // --- Point 4: capture tab-order step (FORWARD walk only) ---
    // Only the forward walk feeds the ordering analysis: a single clean
    // Tab-direction sequence is the cleanest reading-order signal, and avoids
    // double-counting / direction-reversal artifacts. Dedupe by selector so a
    // brief revisit doesn't distort the sequence. Off-screen/invisible elements
    // are still recorded here (their geometry still has a reading-order slot);
    // Point 1 handles the visibility violation separately.
    if (direction === "forward" && fc.domRank > 0) {
      const already = obs.focusOrder.some((s) => s.selector === fc.selector);
      if (!already) {
        obs.focusOrder.push({
          selector: fc.selector,
          role: fc.role,
          name: fc.name,
          rect: fc.rect,
          domRank: fc.domRank,
        });
      }
    }

    // --- Point 1: off-screen / invisible focus ---
    let reason: FocusVisibilityInfo["reason"] | null = null;
    if (fc.display === "none") reason = "display-none";
    else if (fc.visibility === "hidden") reason = "visibility-hidden";
    else if (fc.opacity === 0) reason = "opacity-zero";
    else if (fc.rect.width === 0 || fc.rect.height === 0) reason = "zero-area";

    let scrolledIntoViewFailed = false;
    if (!reason && !fc.inViewport && !fc.isSkipLinkLike) {
      // GUARD: the browser already focus-scrolled. Do an EXPLICIT scrollIntoView
      // re-measure; only a violation if STILL off-screen (sticky/fixed/lazy
      // content that is genuinely reachable passes).
      const after = await scrollActiveIntoViewAndRemeasure(page);
      if (after && !after.inViewport) {
        reason = "offscreen";
        scrolledIntoViewFailed = true;
      }
    }
    if (reason) {
      obs.offscreen.push({
        selector: fc.selector,
        reason,
        rect: fc.rect,
        viewport: fc.viewport,
        scrolledIntoViewFailed,
        tabIndex: totalKeyPresses,
      });
    }

    // --- Point 2 tier-1: focus-indicator style delta (AA only) ---
    // The element receives focus via a REAL key press above, so :focus-visible
    // fires and mouse-only :focus styles correctly don't count.
    if (ctx.level !== "A") {
      if (pendingPrev && pendingPrev.selector !== fc.selector) {
        const unfocused = await readStyleSubset(page, pendingPrev.selector);
        if (unfocused) {
          const noDelta = FOCUS_INDICATOR_PROPS.every(
            (p) => unfocused[p] === pendingPrev!.focusedStyle[p],
          );
          if (noDelta) {
            obs.indicatorCandidates.push({
              selector: pendingPrev.selector,
              role: pendingPrev.role,
              name: pendingPrev.name,
              focusedStyle: pendingPrev.focusedStyle,
              rect: pendingPrev.rect,
            });
          }
        }
      }
      pendingPrev = {
        selector: fc.selector,
        role: fc.role,
        name: fc.name,
        focusedStyle: fc.style,
        rect: fc.rect,
      };
    }

    // --- Point 5: 2.4.11 / 2.4.12 — focus obscured by fixed/sticky overlay ---
    // Skip body, skip-link-revealed elements, and zero-area cases (handled by Point 1).
    if (
      !fc.isBody &&
      !fc.isSkipLinkLike &&
      fc.rect.width > 0 &&
      fc.rect.height > 0
    ) {
      const obstr = await readFocusObstruction(page);
      if (obstr) {
        const fullyCovered = obstr.coveredCorners >= 4;
        obs.obscured.push({
          selector: obstr.selector,
          level: fullyCovered ? "min" : "enhanced",
          obstructorSelector: obstr.obstructorSelector,
          obstructorPosition: obstr.obstructorPosition,
          focusedRect: obstr.focusedRect,
          obstructorRect: obstr.obstructorRect,
          coveredCorners: obstr.coveredCorners,
          coveredSamplePoints: obstr.coveredSamplePoints,
          tabIndex: totalKeyPresses,
        });
      }
    }
  };

  // Helper to find the first unknown element in the focusable list
  const findFirstUnknown = (): string | null => {
    for (const sel of focusableList) {
      if (!clearedSelectors.has(sel) && !trappedSelectors.has(sel)) {
        return sel;
      }
    }
    return null;
  };

  // Helper to mark an element as cleared (focus landed and then moved on)
  const markCleared = (selector: string) => {
    if (!trappedSelectors.has(selector)) {
      clearedSelectors.add(selector);
    }
  };

  // Main resumable walk loop
  while (totalKeyPresses < cap) {
    // Press Tab/Shift+Tab and read where we landed
    await page.pressKey(key);
    await page.waitForTimeout(settleMs);
    totalKeyPresses++;

    // Phase-2 observations for this natural focus landing (real key press only).
    await observeFocusStep();

    const sig = await readActiveSignature(page);
    if (!sig || sig.isBody) {
      // Focus exited to body/chrome - mark the previous element (if any) as cleared
      if (visitedSigs.length > 0) {
        const last = visitedSigs[visitedSigs.length - 1]!;
        markCleared(last.selector);
      }

      // Try to resume at the next unknown element
      const nextUnknown = findFirstUnknown();
      if (!nextUnknown) {
        // No more unknown elements - done with this direction
        break;
      }

      // Programmatically jump focus to the next unknown element (detection aid, not a user action)
      const landed = await jumpFocusTo(page, nextUnknown, settleMs);
      if (!landed) {
        // Jump failed - mark as cleared and try next
        clearedSelectors.add(nextUnknown);
        continue;
      }

      // Verify where we actually landed (might have been redirected by a trap's focus handler)
      const afterJump = await readActiveSignature(page);
      if (!afterJump || afterJump.isBody) {
        continue;
      }

      // If we landed back in an already-trapped region, advance to the next unknown
      if (trappedSelectors.has(afterJump.selector)) {
        clearedSelectors.add(nextUnknown);
        continue;
      }

      // Successfully landed on a new element - reset walk state and continue.
      // Programmatic jump, not a natural transition: break the Phase-2 chains so
      // a jump can't fabricate a modal leak or an indicator candidate.
      visitedSigs = [afterJump];
      counts = new Map([[afterJump.selector, 1]]);
      lastInModal = null;
      pendingPrev = null;
      // Point 4: a programmatic jump corrupts the keyboard sequence — only the
      // forward walk feeds Point 4, so invalidate it there.
      if (direction === "forward") obs.focusOrderReliable = false;
      continue;
    }

    // Mark the PREVIOUS focused element as cleared (we successfully moved away from it)
    if (visitedSigs.length > 0) {
      const prev = visitedSigs[visitedSigs.length - 1]!;
      if (prev.selector !== sig.selector) {
        markCleared(prev.selector);
      }
    }

    // Track this visit
    visitedSigs.push(sig);
    const count = (counts.get(sig.selector) ?? 0) + 1;
    counts.set(sig.selector, count);

    // Potential cycle detected (selector seen 3+ times)
    if (count >= 3) {
      const selectors = visitedSigs.map((s) => s.selector);

      // Confirm it's a closed loop
      if (await isClosedLoop(page, selectors, key, settleMs)) {
        totalKeyPresses += new Set(selectors).size + 1; // Account for the isClosedLoop verification presses

        // Classify the cycle
        const trapInfo = await classifyCycle(page, visitedSigs, sig, key, settleMs);

        if (trapInfo) {
          traps.push(trapInfo);

          // Mark all cycle members as trapped
          const cycle = extractCycle(visitedSigs, sig.selector);
          for (const c of cycle) {
            trappedSelectors.add(c.selector);
          }
        }

        // Resume: find the first unknown element and jump to it
        const nextUnknown = findFirstUnknown();
        if (!nextUnknown) {
          // No more unknown elements - done
          break;
        }

        // Programmatically jump focus to the next unknown element (detection aid)
        const landed = await jumpFocusTo(page, nextUnknown, settleMs);
        if (!landed) {
          clearedSelectors.add(nextUnknown);
          continue;
        }

        // Verify landing
        const afterJump = await readActiveSignature(page);
        if (!afterJump || afterJump.isBody) {
          continue;
        }

        // If redirected back into a trapped region, mark and advance
        if (trappedSelectors.has(afterJump.selector)) {
          clearedSelectors.add(nextUnknown);
          continue;
        }

        // Successfully landed - reset walk state and continue. Break the
        // Phase-2 chains (see above) since this is a programmatic jump.
        visitedSigs = [afterJump];
        counts = new Map([[afterJump.selector, 1]]);
        lastInModal = null;
        pendingPrev = null;
        // Point 4: programmatic jump corrupts the keyboard sequence (forward only).
        if (direction === "forward") obs.focusOrderReliable = false;
      }
    }
  }
}

/**
 * Programmatically set focus to the given selector. This is a DETECTION AID to step over
 * already-confirmed traps - NOT a claim that a keyboard user could bypass the trap.
 * Returns true if the element was successfully focused (focus landed somewhere other than body).
 */
async function jumpFocusTo(
  page: PageDriver,
  selector: string,
  settleMs: number,
): Promise<boolean> {
  try {
    const success = await page.evaluate((sel: string) => {
      try {
        const el = document.querySelector(sel);
        if (el && 'focus' in el && typeof el.focus === 'function') {
          (el as HTMLElement).focus();
          return true;
        }
      } catch {
        return false;
      }
      return false;
    }, selector);

    if (success) {
      await page.waitForTimeout(settleMs);
    }

    return success;
  } catch {
    return false;
  }
}

async function isClosedLoop(
  page: PageDriver,
  visited: string[],
  key: "Tab" | "Shift+Tab",
  settleMs: number,
): Promise<boolean> {
  // Extract the cycle set (all unique selectors that appeared)
  const cycleSet = new Set(visited);

  // Press key |cycleSet| + 1 more times and confirm every landing ∈ cycleSet and never hits body/null
  for (let i = 0; i <= cycleSet.size; i++) {
    await page.pressKey(key);
    await page.waitForTimeout(settleMs);
    const sig = await readActiveSignature(page);
    if (!sig || sig.isBody) return false;
    if (!cycleSet.has(sig.selector)) return false;
  }
  return true;
}

/**
 * Extract the minimal repeating loop (distinct elements in tab order) from the
 * visited sequence. The repeated element marks the loop boundary; we take the
 * elements between its first and second occurrence — one full lap of the cycle.
 */
function extractCycle(visitedSigs: ActiveSig[], repeatSelector: string): ActiveSig[] {
  const indices: number[] = [];
  for (let i = 0; i < visitedSigs.length; i++) {
    if (visitedSigs[i]!.selector === repeatSelector) indices.push(i);
  }
  if (indices.length < 2) {
    // Fallback: distinct elements across the whole walk, in first-seen order.
    return dedupeSigs(visitedSigs);
  }
  const lap = visitedSigs.slice(indices[0]!, indices[1]!);
  return dedupeSigs(lap.length > 0 ? lap : visitedSigs);
}

function dedupeSigs(sigs: ActiveSig[]): ActiveSig[] {
  const seen = new Set<string>();
  const out: ActiveSig[] = [];
  for (const s of sigs) {
    if (seen.has(s.selector)) continue;
    seen.add(s.selector);
    out.push(s);
  }
  return out;
}

/**
 * Find the smallest common ancestor container for all elements in the cycle.
 * This provides a stable region identifier for non-modal traps, ensuring that
 * multiple detections within the same trap region are properly deduplicated.
 */
async function findCommonAncestor(
  page: PageDriver,
  selectors: string[],
): Promise<string> {
  // String-serialized to avoid tsx's `__name` helper injection on the nested
  // named/recursive `cssSelectorFor` function (which is undefined in the page
  // context and throws "ReferenceError: __name is not defined"). Mirrors the
  // pattern used by readActiveSignature/enumerateFocusables. Input selectors are
  // JSON-injected rather than passed as an evaluate arg.
  const selectorsJson = JSON.stringify(selectors);
  return page.evaluate(/* js */ `
    (() => {
      const sels = ${selectorsJson};

      const cssSelectorFor = (el) => {
        if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
          return '#' + CSS.escape(el.id);
        }
        const tag = el.tagName.toLowerCase();
        const parent = el.parentElement;
        if (!parent) return tag;
        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        const index = siblings.indexOf(el) + 1;
        const parentSelector = parent === document.body ? '' : cssSelectorFor(parent);
        return parentSelector ? parentSelector + ' > ' + tag + ':nth-of-type(' + index + ')' : tag + ':nth-of-type(' + index + ')';
      };

      const elements = sels.map((sel) => {
        try { return document.querySelector(sel); } catch { return null; }
      }).filter((el) => el !== null);

      if (elements.length === 0) return sels[0] || 'body';
      const firstElement = elements[0];
      if (!firstElement) return 'body';
      if (elements.length === 1) return cssSelectorFor(firstElement);

      let ancestor = firstElement;
      while (ancestor) {
        const isCommon = elements.every((el) => ancestor.contains(el));
        if (isCommon) return cssSelectorFor(ancestor);
        ancestor = ancestor.parentElement;
      }
      return 'body';
    })()
  `);
}

async function classifyCycle(
  page: PageDriver,
  visitedSigs: ActiveSig[],
  sig: ActiveSig,
  key: "Tab" | "Shift+Tab",
  settleMs: number,
): Promise<TrapInfo | null> {
  const cycle = extractCycle(visitedSigs, sig.selector);
  const cycleSelectors = cycle.map((c) => c.selector);

  // Find a close control within the cycle (selector + accessible name) so we
  // can both classify (review vs blocker) and surface it as evidence.
  const closeControl = await page.evaluate((selectors: string[]) => {
    const closeSelectors = [
      '[aria-label*="close" i]',
      '[aria-label*="dismiss" i]',
      "button.close",
      "[data-dismiss]",
      'button[title*="close" i]',
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        for (const closeSel of closeSelectors) {
          if (el.matches(closeSel)) {
            const name =
              el.getAttribute("aria-label") ||
              el.getAttribute("title") ||
              (el.textContent || "").trim() ||
              "Close";
            return { selector: sel, name: name.slice(0, 80) };
          }
        }
      } catch {
        // Invalid selector
      }
    }
    return null;
  }, cycleSelectors);

  const hasCloseControl = closeControl !== null;
  sig.hasCloseControlInCycle = hasCloseControl;

  const cycleSet = new Set(cycleSelectors);
  const directionLabel = key === "Tab" ? "Tab" : "Shift+Tab";

  // Press Escape and check if focus escaped the trapped region.
  await page.pressKey("Escape");
  await page.waitForTimeout(settleMs);
  const after = await readActiveSignature(page);

  // "Escaped" means focus left the document/body, OR left the cycle, OR (for a
  // modal) the dialog closed / focus left the modal container. This works for
  // BOTH modal and non-modal traps — the previous `!after.inModal` test was
  // always true for non-modal traps and wrongly suppressed every region trap.
  const escaped =
    !after ||
    after.isBody ||
    !cycleSet.has(after.selector) ||
    (sig.inModal &&
      (after.modalSelector !== sig.modalSelector ||
        !(await modalStillOpen(page, sig.modalSelector ?? ""))));

  if (escaped) {
    // Focus can leave by keyboard → correct, suppress.
    return null;
  }

  const evidence: TrapEvidence = {
    direction: key === "Tab" ? "forward" : "backward",
    cycle: cycle.map((c) => ({ selector: c.selector, role: c.role, name: c.name })),
    keysAttempted: [
      { key: directionLabel, result: "looped back into the region without reaching the page body" },
      { key: "Escape", result: "no effect — focus stayed inside the region" },
    ],
    modal: sig.inModal
      ? { selector: sig.modalSelector ?? sig.selector, closeControl }
      : null,
  };

  // Focus is still stuck after Escape.
  if (sig.inModal) {
    return {
      region: sig.modalSelector ?? sig.selector,
      trapped: sig,
      // A focusable Close in the cycle that we cannot safely activate → review.
      // No close control at all → hard blocker.
      kind: hasCloseControl ? "modal-review" : "modal-blocker",
      evidence,
    };
  }
  // Non-modal stuck region: find the common ancestor of all cycle elements to provide
  // a stable region identifier that allows proper deduplication across multiple detections.
  const region = await findCommonAncestor(page, cycleSelectors);
  return { region, trapped: sig, kind: "region", evidence };
}

async function modalStillOpen(
  page: PageDriver,
  modalSelector: string,
): Promise<boolean> {
  return page.evaluate((sel: string) => {
    try {
      const el = document.querySelector(sel);
      if (!el) return false;
      // Check if dialog is still open
      if (el instanceof HTMLDialogElement) {
        return el.open;
      }
      // Check if modal is still visible
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    } catch {
      return false;
    }
  }, modalSelector);
}

/**
 * Take one viewport screenshot with the trapped region outlined, returned as a
 * base64 PNG data-URI. Self-contained so the scanner needn't know the report
 * output directory. Any failure is non-fatal (returns undefined) — evidence is
 * best-effort and must never break a scan.
 */
async function captureTrapScreenshot(
  page: PageDriver,
  regionSelector: string,
): Promise<string | undefined> {
  try {
    // Outline the trapped region so the screenshot points at the problem.
    const cleanup = await page.evaluate((sel: string) => {
      let el: Element | null = null;
      try {
        el = document.querySelector(sel);
      } catch {
        el = null;
      }
      if (!(el instanceof HTMLElement)) return false;
      el.scrollIntoView({ block: "center", inline: "center" });
      const prevOutline = el.style.outline;
      const prevOffset = el.style.outlineOffset;
      el.style.outline = "3px solid #e11d48";
      el.style.outlineOffset = "2px";
      el.setAttribute("data-a11y-trap-outline", "1");
      // Stash previous values so we can restore them.
      (el as HTMLElement & { __a11yPrev?: [string, string] }).__a11yPrev = [
        prevOutline,
        prevOffset,
      ];
      return true;
    }, regionSelector);

    if (!cleanup) return undefined;

    const buf = await page.screenshot({ type: "png" });

    // Restore the element's original styles.
    await page.evaluate(() => {
      const el = document.querySelector('[data-a11y-trap-outline="1"]');
      if (el instanceof HTMLElement) {
        const prev = (el as HTMLElement & { __a11yPrev?: [string, string] })
          .__a11yPrev;
        el.style.outline = prev?.[0] ?? "";
        el.style.outlineOffset = prev?.[1] ?? "";
        el.removeAttribute("data-a11y-trap-outline");
      }
    });

    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

function dedupeByRegion(traps: TrapInfo[]): TrapInfo[] {
  const seen = new Map<string, TrapInfo>();
  for (const trap of traps) {
    const existing = seen.get(trap.region);
    if (!existing) {
      seen.set(trap.region, trap);
      continue;
    }
    // Same region trapped in both walk directions → mark direction "both" and
    // merge the keys-attempted notes so the evidence reflects both passes.
    if (existing.evidence.direction !== trap.evidence.direction) {
      existing.evidence.direction = "both";
      const seenKeys = new Set(existing.evidence.keysAttempted.map((k) => k.key));
      for (const k of trap.evidence.keysAttempted) {
        if (!seenKeys.has(k.key)) existing.evidence.keysAttempted.push(k);
      }
    }
  }
  return Array.from(seen.values());
}

function buildFinding(trap: TrapInfo, url: string): Finding {
  const criterion = getCriterion("2.1.2");
  const wcagLevel: "A" | "AA" | "AAA" = criterion?.level ?? "A";
  const baseSeverity = severityForSc("2.1.2", wcagLevel);
  const isReview = trap.kind === "modal-review";

  return {
    id: uuidv4(),
    wcagSc: "2.1.2",
    wcagLevel,
    severity: isReview ? "review" : baseSeverity,
    source: "keyboard",
    ruleId: KEYBOARD_TRAP_RULE_ID,
    title: criterion?.title ?? "No Keyboard Trap",
    description: isReview
      ? "Focus appears trapped in this modal: Escape did not move focus out. A Close control " +
        "is present in the tab cycle but could not be verified automatically — confirm a " +
        "keyboard user can exit this region."
      : "Keyboard focus entered this region and could not be moved out using Tab, Shift+Tab, " +
        "or Escape. Keyboard-only users become trapped.",
    helpUrl: criterion?.url,
    selector: trap.region,
    htmlSnippet: trap.trapped.outerHTML,
    remediation:
      "Ensure focus can leave this region via keyboard. For modals, implement Escape " +
      "to close and return focus to the trigger, or provide a focusable, keyboard-activatable " +
      "Close control within the tab cycle. See " +
      (criterion?.url ?? ""),
    aiGenerated: false,
    requiresHumanReview: isReview,
    keyboardEvidence: {
      direction: trap.evidence.direction,
      cycle: trap.evidence.cycle,
      keysAttempted: trap.evidence.keysAttempted,
      modal: trap.evidence.modal,
      screenshotDataUri: trap.evidence.screenshotDataUri,
    },
    tags: ["keyboard", "wcag2a", "wcag212", "cat.keyboard"],
    relatedRuleIds: [],
    relatedNodes: [],
    pageUrl: url,
  };
}

// ===========================================================================
// Point 3 — modal focus leak
// ===========================================================================

/** Dedupe leaks by modal: one finding per modal even if both Tab and Shift+Tab
 * leak. Forward direction wins; a leak in both directions is noted as "both" via
 * keeping the first. */
function dedupeLeaksByModal(leaks: ModalLeakInfo[]): ModalLeakInfo[] {
  const seen = new Map<string, ModalLeakInfo>();
  for (const leak of leaks) {
    if (!seen.has(leak.modalSelector)) {
      seen.set(leak.modalSelector, leak);
    }
  }
  return Array.from(seen.values());
}

function buildModalLeakFinding(
  leak: ModalLeakInfo,
  url: string,
  screenshotDataUri: string | undefined,
): Finding {
  // LOCKED DECISION: top-layer (:modal) OR aria-modal=true → the author declared
  // modality, so a focus leak defeats it → treated as a hard finding (not
  // requiresHumanReview). A bare role="dialog" (no aria-modal, not top-layer)
  // may legitimately be non-modal → requiresHumanReview. `isBlocker` now only
  // drives the description + review flag; SEVERITY is catalog-driven (2.4.3 → severe).
  const isBlocker = leak.isTopLayerModal || leak.modalKind === "modal-true";
  const criterion = getCriterion("2.4.3");
  return {
    id: uuidv4(),
    wcagSc: "2.4.3",
    wcagLevel: "A",
    // Catalog severity for 2.4.3 (→ "severe") for all modal leaks. Previously
    // forced "blocker"/"review"; now consistent with off-screen-focus (also 2.4.3).
    severity: severityForSc("2.4.3", "A"),
    source: "keyboard",
    ruleId: MODAL_FOCUS_LEAK_RULE_ID,
    title: "Focus moved outside an open modal dialog",
    description: isBlocker
      ? "While a modal dialog was open, keyboard focus moved to content behind it. " +
        "Keyboard and screen-reader users lose their place and can reach content that " +
        "should be inert while the dialog is open."
      : 'While a dialog (role="dialog") was open, focus moved to content outside it. ' +
        "If this dialog is intended to be modal, focus must be contained — verify the " +
        "intended behavior.",
    helpUrl: criterion?.url,
    selector: leak.modalSelector,
    aiGenerated: false,
    requiresHumanReview: !isBlocker,
    modalLeakEvidence: {
      modalSelector: leak.modalSelector,
      modalKind: leak.modalKind,
      isTopLayerModal: leak.isTopLayerModal,
      leakedToSelector: leak.leakedTo.selector,
      leakedToRole: leak.leakedTo.role,
      leakedToName: leak.leakedTo.name,
      direction: leak.direction,
      screenshotDataUri,
    },
    remediation:
      "Trap focus within the dialog while it is open (loop Tab/Shift+Tab across the " +
      "dialog's focusable elements), or use <dialog>.showModal() which provides this for " +
      "free. Restore focus to the trigger on close. See " + (criterion?.url ?? ""),
    tags: ["keyboard", "wcag2a", "wcag243", "wcag212", "cat.keyboard"],
    relatedRuleIds: [],
    relatedNodes: [],
    pageUrl: url,
  };
}

// ===========================================================================
// Point 1 — off-screen / invisible focus
// ===========================================================================

function dedupeOffscreenBySelector(
  infos: FocusVisibilityInfo[],
): FocusVisibilityInfo[] {
  const seen = new Map<string, FocusVisibilityInfo>();
  for (const info of infos) {
    if (!seen.has(info.selector)) seen.set(info.selector, info);
  }
  return Array.from(seen.values());
}

function buildFocusVisibilityFinding(
  info: FocusVisibilityInfo,
  url: string,
): Finding {
  const criterion = getCriterion("2.4.3");
  const reasonText: Record<FocusVisibilityInfo["reason"], string> = {
    offscreen:
      "scrolled outside the viewport and could not be brought into view",
    "display-none": "is display:none yet receives keyboard focus",
    "visibility-hidden": "is visibility:hidden yet receives keyboard focus",
    "opacity-zero": "is fully transparent (opacity:0) yet receives keyboard focus",
    "zero-area": "has zero width or height yet receives keyboard focus",
  };
  return {
    id: uuidv4(),
    wcagSc: "2.4.3",
    wcagLevel: "A",
    // 2.4.3 is not in blockerScIds → "severe". Deterministic, so not review.
    severity: severityForSc("2.4.3", "A"),
    source: "keyboard",
    ruleId: FOCUS_OFFSCREEN_RULE_ID,
    title: "Focus lands on an off-screen or invisible element",
    description:
      `Tab step ${info.tabIndex} moved focus to an element that ${reasonText[info.reason]}. ` +
      "Sighted keyboard users cannot see where focus is.",
    helpUrl: criterion?.url,
    selector: info.selector,
    aiGenerated: false,
    requiresHumanReview: false,
    focusVisibilityEvidence: {
      reason: info.reason,
      rect: info.rect,
      viewport: info.viewport,
      scrolledIntoViewFailed: info.scrolledIntoViewFailed,
      tabIndex: info.tabIndex,
      screenshotDataUri: info.screenshotDataUri,
    },
    remediation:
      "Ensure every focusable element is visible and scrolled into view when focused, or " +
      "remove it from the tab order (tabindex=-1 / not focusable) if it is intentionally " +
      "hidden. See " + (criterion?.url ?? ""),
    tags: ["keyboard", "wcag2a", "wcag243", "wcag247", "cat.keyboard"],
    relatedRuleIds: [],
    relatedNodes: [],
    pageUrl: url,
  };
}

// ===========================================================================
// Point 5 — focus obscured (2.4.11 / 2.4.12)
// ===========================================================================

function dedupeObscuredBySelector(infos: FocusObscuredInfo[]): FocusObscuredInfo[] {
  // Keep the highest-severity observation per selector (full > partial).
  const seen = new Map<string, FocusObscuredInfo>();
  for (const i of infos) {
    const prev = seen.get(i.selector);
    if (!prev || (prev.level === "enhanced" && i.level === "min")) {
      seen.set(i.selector, i);
    }
  }
  return Array.from(seen.values());
}

function buildFocusObscuredFinding(
  info: FocusObscuredInfo,
  level: "min" | "enhanced",
  url: string,
): Finding {
  const sc = level === "min" ? "2.4.11" : "2.4.12";
  const wcagLevel = level === "min" ? "AA" : "AAA";
  const ruleId =
    level === "min" ? FOCUS_OBSCURED_MIN_RULE_ID : FOCUS_OBSCURED_ENHANCED_RULE_ID;
  const criterion = getCriterion(sc);
  const severity =
    level === "min" ? severityForSc(sc, wcagLevel) : "severe"; // 2.4.11 → blocker via blockerScIds
  return {
    id: uuidv4(),
    wcagSc: sc,
    wcagLevel,
    severity,
    source: "keyboard",
    ruleId,
    title:
      level === "min"
        ? "Focused element is fully obscured by a fixed or sticky overlay"
        : "Focused element is partially obscured by a fixed or sticky overlay",
    description:
      level === "min"
        ? `Tab step ${info.tabIndex} placed focus on an element entirely covered by ${info.obstructorPosition} ancestor "${info.obstructorSelector}". Sighted keyboard users cannot see where focus is — WCAG 2.4.11 (Focus Not Obscured — Minimum) failure.`
        : `Tab step ${info.tabIndex} placed focus on an element partially covered (${info.coveredSamplePoints}/8 sample points covered) by ${info.obstructorPosition} ancestor "${info.obstructorSelector}". WCAG 2.4.12 (Focus Not Obscured — Enhanced, AAA) requires no part of the focused element to be obscured.`,
    helpUrl: criterion?.url,
    selector: info.selector,
    aiGenerated: false,
    requiresHumanReview: false,
    focusObscuredEvidence: {
      level,
      obstructorSelector: info.obstructorSelector,
      obstructorPosition: info.obstructorPosition,
      focusedRect: info.focusedRect,
      obstructorRect: info.obstructorRect,
      coveredCorners: info.coveredCorners,
      coveredSamplePoints: info.coveredSamplePoints,
      tabIndex: info.tabIndex,
    },
    remediation:
      "Add scroll-margin or scroll-padding so focused elements scroll clear of fixed/sticky overlays, or reduce the overlay's z-index when a focused element is below it. See " +
      (criterion?.url ?? ""),
    tags: [
      "keyboard",
      level === "min" ? "wcag2aa" : "wcag2aaa",
      level === "min" ? "wcag2411" : "wcag2412",
      "cat.keyboard",
    ],
    relatedRuleIds: [],
    relatedNodes: [],
    pageUrl: url,
  };
}

// ===========================================================================
// Point 2 — focus indicator
// ===========================================================================

function dedupeCandidatesBySelector(
  cands: IndicatorCandidate[],
): IndicatorCandidate[] {
  const seen = new Map<string, IndicatorCandidate>();
  for (const c of cands) {
    if (!seen.has(c.selector)) seen.set(c.selector, c);
  }
  return Array.from(seen.values());
}

/**
 * Tier-2 confirmation: screenshot the candidate's bounding box unfocused vs
 * focused and pixel-diff them. Confirms the EXISTENCE of a visible focus
 * indicator (outline / box-shadow / pseudo-element / SVG) that tier-1's six
 * computed-style properties missed — it does NOT measure contrast or quality.
 */
async function verifyIndicatorByScreenshot(
  page: PageDriver,
  cand: IndicatorCandidate,
  settleMs: number,
): Promise<{ hasIndicator: boolean; changedRatio: number; focusedShot?: string }> {
  try {
    // 1. MEASUREMENT AID, not a user action: programmatically focus this single
    //    element FIRST so any focus-triggered scroll settles before we choose
    //    the clip box. This does NOT claim a keyboard user reached it (the walk
    //    already did, via a real Tab press). It confirms only the EXISTENCE of a
    //    visual focus indicator (outline / box-shadow / pseudo-element / SVG) —
    //    NEVER contrast/quality. The finding always carries requiresHumanReview.
    const focused = await jumpFocusTo(page, cand.selector, settleMs);
    if (!focused) {
      // Could not focus to measure → don't assert a miss; treat as indicator
      // present to stay on the low-false-positive side.
      return { hasIndicator: true, changedRatio: 0 };
    }

    // Compute the clip from the element's LIVE rect at the now-settled scroll
    // position (the walk-time rect may be stale after the focus scroll). Pad a
    // few px so an outline drawn OUTSIDE the border box is captured.
    const liveRect = await page.evaluate((sel: string) => {
      let el: Element | null = null;
      try {
        el = document.querySelector(sel);
      } catch {
        el = null;
      }
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    }, cand.selector);
    if (!liveRect || liveRect.width === 0 || liveRect.height === 0) {
      return { hasIndicator: true, changedRatio: 0 };
    }
    const pad = 6;
    const clip = {
      x: Math.max(0, Math.floor(liveRect.x - pad)),
      y: Math.max(0, Math.floor(liveRect.y - pad)),
      width: Math.max(
        1,
        Math.min(
          Math.ceil(liveRect.width + pad * 2),
          liveRect.vw - Math.max(0, Math.floor(liveRect.x - pad)),
        ),
      ),
      height: Math.max(
        1,
        Math.min(
          Math.ceil(liveRect.height + pad * 2),
          liveRect.vh - Math.max(0, Math.floor(liveRect.y - pad)),
        ),
      ),
    };

    // 2. Focused screenshot at this clip.
    const focusedBuf = await page.screenshot({ type: "png", clip });

    // 3. Blur WITHOUT scrolling (resetFocusToBody only blurs + focuses body, no
    //    scroll), then screenshot the SAME clip for the unfocused baseline. The
    //    scroll position is unchanged, so any pixel delta is the focus indicator
    //    itself — not a scroll shift.
    await resetFocusToBody(page);
    await page.waitForTimeout(settleMs);
    const unfocusedBuf = await page.screenshot({ type: "png", clip });

    const changedRatio = changedPixelRatio(unfocusedBuf, focusedBuf);
    const focusedShot = `data:image/png;base64,${focusedBuf.toString("base64")}`;
    return {
      hasIndicator: changedRatio >= FOCUS_INDICATOR_CHANGED_PIXEL_THRESHOLD,
      changedRatio,
      focusedShot,
    };
  } catch {
    // Any failure → don't flag (evidence is best-effort, never blocks a scan).
    return { hasIndicator: true, changedRatio: 0 };
  }
}

/**
 * Dependency-free PNG diff: decode the two identically-clipped PNG buffers and
 * return the fraction of pixels whose RGBA differs beyond a small per-channel
 * tolerance. Hand-rolled rather than adding pixelmatch/pngjs (minimize deps).
 * If the buffers differ in dimensions or can't be parsed, returns 1 (treat as
 * changed → indicator present → no false-positive flag).
 */
function changedPixelRatio(a: Buffer, b: Buffer): number {
  const imgA = decodePng(a);
  const imgB = decodePng(b);
  if (!imgA || !imgB) return 1;
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) return 1;
  const pa = imgA.data;
  const pb = imgB.data;
  if (pa.length !== pb.length || pa.length === 0) return 1;
  const tolerance = 12; // per-channel 0-255 noise tolerance
  let changed = 0;
  const totalPixels = pa.length / 4;
  for (let i = 0; i < pa.length; i += 4) {
    if (
      Math.abs(pa[i]! - pb[i]!) > tolerance ||
      Math.abs(pa[i + 1]! - pb[i + 1]!) > tolerance ||
      Math.abs(pa[i + 2]! - pb[i + 2]!) > tolerance ||
      Math.abs(pa[i + 3]! - pb[i + 3]!) > tolerance
    ) {
      changed++;
    }
  }
  return totalPixels === 0 ? 1 : changed / totalPixels;
}

/**
 * Minimal PNG decoder supporting the format Playwright emits: 8-bit RGBA/RGB,
 * non-interlaced, with zlib-deflated IDAT and the standard scanline filters.
 * Returns null on anything it can't handle (caller treats that as "changed").
 */
function decodePng(
  buf: Buffer,
): { width: number; height: number; data: Buffer } | null {
  try {
    // PNG signature check.
    if (
      buf.length < 8 ||
      buf[0] !== 0x89 ||
      buf[1] !== 0x50 ||
      buf[2] !== 0x4e ||
      buf[3] !== 0x47
    ) {
      return null;
    }
    let pos = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idatChunks: Buffer[] = [];
    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString("ascii", pos + 4, pos + 8);
      const dataStart = pos + 8;
      const dataEnd = dataStart + len;
      if (dataEnd > buf.length) break;
      if (type === "IHDR") {
        width = buf.readUInt32BE(dataStart);
        height = buf.readUInt32BE(dataStart + 4);
        bitDepth = buf[dataStart + 8]!;
        colorType = buf[dataStart + 9]!;
        const interlace = buf[dataStart + 12]!;
        if (bitDepth !== 8 || interlace !== 0) return null;
        if (colorType !== 6 && colorType !== 2) return null; // RGBA or RGB only
      } else if (type === "IDAT") {
        idatChunks.push(buf.subarray(dataStart, dataEnd));
      } else if (type === "IEND") {
        break;
      }
      pos = dataEnd + 4; // skip CRC
    }
    if (width === 0 || height === 0 || idatChunks.length === 0) return null;

    const raw = zlib.inflateSync(Buffer.concat(idatChunks));

    const channels = colorType === 6 ? 4 : 3;
    const stride = width * channels;
    const out = Buffer.alloc(width * height * 4);
    let rawPos = 0;
    const prevLine = Buffer.alloc(stride);
    const curLine = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
      const filter = raw[rawPos++]!;
      for (let x = 0; x < stride; x++) {
        const rawByte = raw[rawPos++]!;
        const a = x >= channels ? curLine[x - channels]! : 0;
        const b = prevLine[x]!;
        const c = x >= channels ? prevLine[x - channels]! : 0;
        let val: number;
        switch (filter) {
          case 0:
            val = rawByte;
            break;
          case 1:
            val = rawByte + a;
            break;
          case 2:
            val = rawByte + b;
            break;
          case 3:
            val = rawByte + ((a + b) >> 1);
            break;
          case 4: {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            val = rawByte + pred;
            break;
          }
          default:
            return null;
        }
        curLine[x] = val & 0xff;
      }
      // Expand the scanline into RGBA output.
      for (let x = 0; x < width; x++) {
        const srcIdx = x * channels;
        const dstIdx = (y * width + x) * 4;
        out[dstIdx] = curLine[srcIdx]!;
        out[dstIdx + 1] = curLine[srcIdx + 1]!;
        out[dstIdx + 2] = curLine[srcIdx + 2]!;
        out[dstIdx + 3] = channels === 4 ? curLine[srcIdx + 3]! : 255;
      }
      curLine.copy(prevLine);
    }
    return { width, height, data: out };
  } catch {
    return null;
  }
}

function buildIndicatorFinding(
  cand: IndicatorCandidate,
  url: string,
  changedPixelRatio: number,
  screenshotDataUri: string | undefined,
): Finding {
  const criterion = getCriterion("2.4.7");
  return {
    id: uuidv4(),
    wcagSc: "2.4.7",
    wcagLevel: "AA",
    // Always review — we confirm indicator existence, never contrast/quality.
    severity: "review",
    source: "keyboard",
    ruleId: FOCUS_INDICATOR_RULE_ID,
    title: "No visible focus indicator detected",
    description:
      `This element (${cand.role}${cand.name ? ` "${cand.name}"` : ""}) showed no ` +
      "computed-style change when keyboard-focused, and a screenshot comparison detected " +
      "no visible focus indicator. Verify a clearly visible focus indicator is present.",
    helpUrl: criterion?.url,
    selector: cand.selector,
    aiGenerated: false,
    requiresHumanReview: true,
    focusIndicatorEvidence: {
      verification: "screenshot-verified",
      comparedProperties: [...FOCUS_INDICATOR_PROPS],
      changedPixelRatio,
      screenshotDataUri,
    },
    remediation:
      "Provide a clearly visible :focus-visible indicator (e.g. a 2px outline or box-shadow " +
      "with sufficient contrast) on all interactive elements. See " + (criterion?.url ?? ""),
    tags: ["keyboard", "wcag2aa", "wcag247", "cat.keyboard"],
    relatedRuleIds: [],
    relatedNodes: [],
    pageUrl: url,
  };
}

/** ONE per-page summary review finding when tier-2 screenshot verification was
 * not run. `skipReason` distinguishes the two cases that hit this path:
 *   - "crawl"        — tier-2 auto-disabled under crawl to bound cost.
 *   - "user-opt-out" — user passed --no-focus-indicator-screenshots. */
function buildIndicatorCrawlSummary(
  count: number,
  url: string,
  skipReason: "crawl" | "user-opt-out",
): Finding {
  const criterion = getCriterion("2.4.7");
  const title =
    skipReason === "crawl"
      ? "Possible missing focus indicators (screenshot verification skipped under crawl)"
      : "Possible missing focus indicators (screenshot verification disabled)";
  const rescanHint =
    skipReason === "crawl"
      ? "Screenshot verification was skipped under crawl to bound cost. " +
        "Rescan this URL outside the crawl (run a single-page scan) to confirm."
      : "Screenshot verification was disabled by --no-focus-indicator-screenshots. " +
        "Rerun without that flag to confirm.";
  return {
    id: uuidv4(),
    wcagSc: "2.4.7",
    wcagLevel: "AA",
    severity: "review",
    source: "keyboard",
    ruleId: FOCUS_INDICATOR_RULE_ID,
    title,
    description:
      `${count} focusable element${count === 1 ? "" : "s"} showed no computed-style focus ` +
      `indicator on this page. ${rescanHint}`,
    helpUrl: criterion?.url,
    selector: undefined,
    aiGenerated: false,
    requiresHumanReview: true,
    focusIndicatorEvidence: {
      verification: "style-delta-only",
      comparedProperties: [...FOCUS_INDICATOR_PROPS],
      candidateCount: count,
      skipReason,
    },
    remediation:
      "Provide a clearly visible :focus-visible indicator (outline / box-shadow) on all " +
      "interactive elements. See " + (criterion?.url ?? ""),
    tags: ["keyboard", "wcag2aa", "wcag247", "cat.keyboard"],
    relatedRuleIds: [],
    relatedNodes: [],
    pageUrl: url,
  };
}

// ===========================================================================
// Point 4 — geometric tab-order divergence (2.4.3). Pure helpers below.
// ===========================================================================

/** A focusable element reduced to what the ordering math needs. */
interface OrderElement {
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  domRank: number;
}

/**
 * Build the DOM-order sequence of selectors: the captured elements sorted by
 * their document-order focusable rank (ascending). Stable + deterministic.
 */
function buildDomOrder(elements: OrderElement[]): string[] {
  return [...elements]
    .sort((a, b) => a.domRank - b.domRank)
    .map((e) => e.selector);
}

/**
 * Build the visual reading-order sequence via ROW-BANDING:
 *  1. Sort elements by rect.y (top edge), tie-break by x.
 *  2. Greedily group into horizontal bands: an element joins the current band
 *     if its vertical overlap with the band's representative rect is >= the
 *     shorter rect's height * FOCUS_ORDER_CONFIG.bandOverlapRatio; else it starts
 *     a new band.
 *  3. Within each band, sort left→right (ascending x) for LTR, or right→left
 *     (descending x) for RTL.
 *  4. Concatenate bands top→bottom.
 * Returns BOTH the ordered selectors and the largest single band's size (the
 * caller uses the latter for the degeneracy guard).
 */
function buildVisualOrder(
  elements: OrderElement[],
  writingDirection: "ltr" | "rtl",
): { order: string[]; largestBandSize: number } {
  if (elements.length === 0) return { order: [], largestBandSize: 0 };

  const sorted = [...elements].sort((a, b) => {
    if (a.rect.y !== b.rect.y) return a.rect.y - b.rect.y;
    return a.rect.x - b.rect.x;
  });

  const bands: OrderElement[][] = [];
  for (const el of sorted) {
    const band = bands[bands.length - 1];
    if (!band) {
      bands.push([el]);
      continue;
    }
    // Representative rect of the band: its first (topmost) element.
    const rep = band[0]!;
    const overlap = verticalOverlap(rep.rect, el.rect);
    const shorter = Math.min(rep.rect.height, el.rect.height) || 1;
    if (overlap >= shorter * FOCUS_ORDER_CONFIG.bandOverlapRatio) {
      band.push(el);
    } else {
      bands.push([el]);
    }
  }

  const order: string[] = [];
  let largestBandSize = 0;
  for (const band of bands) {
    largestBandSize = Math.max(largestBandSize, band.length);
    const withinBand = [...band].sort((a, b) =>
      writingDirection === "rtl" ? b.rect.x - a.rect.x : a.rect.x - b.rect.x,
    );
    for (const el of withinBand) order.push(el.selector);
  }
  return { order, largestBandSize };
}

/** Vertical overlap (px) between two rects; 0 if they don't overlap vertically. */
function verticalOverlap(
  a: { y: number; height: number },
  b: { y: number; height: number },
): number {
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, bottom - top);
}

/**
 * Normalized Kendall-tau distance between two orderings of the SAME set of
 * items, identified by string key. Returns the fraction of discordant pairs in
 * [0,1]: 0 == identical order, 1 == fully reversed. O(n^2) is fine — n is capped
 * at 60. `reference` defines the index of each key; we then count, over all
 * pairs in `candidate`, how many are out of order relative to `reference`.
 */
function normalizedKendallTau(reference: string[], candidate: string[]): number {
  const refIndex = new Map<string, number>();
  reference.forEach((k, i) => refIndex.set(k, i));
  // Map the candidate to reference-index positions, dropping any key not in the
  // reference (shouldn't happen — both lists are the same set — but defensive).
  const seq: number[] = [];
  for (const k of candidate) {
    const idx = refIndex.get(k);
    if (idx !== undefined) seq.push(idx);
  }
  const n = seq.length;
  if (n < 2) return 0;
  let discordant = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // In `reference` order, seq[i] should come before seq[j]. A discordance is
      // an inversion: an earlier candidate position holding a later reference idx.
      if (seq[i]! > seq[j]!) discordant++;
    }
  }
  const totalPairs = (n * (n - 1)) / 2;
  return totalPairs === 0 ? 0 : discordant / totalPairs;
}

/**
 * Identify the worst adjacent "jumps" in the tab order relative to visual
 * reading order, for human-readable evidence. For each adjacent pair in
 * tabOrder, compute the delta of their visual ranks; a large |delta| means focus
 * jumped far across the reading order in one Tab press. Returns the top few by
 * absolute delta. Deterministic (stable sort, then slice).
 */
function computeFocusJumps(
  tabOrder: string[],
  visualOrder: string[],
  limit: number,
): { fromSelector: string; toSelector: string; visualRankDelta: number }[] {
  const visualRank = new Map<string, number>();
  visualOrder.forEach((k, i) => visualRank.set(k, i));
  const jumps: {
    fromSelector: string;
    toSelector: string;
    visualRankDelta: number;
  }[] = [];
  for (let i = 0; i < tabOrder.length - 1; i++) {
    const from = tabOrder[i]!;
    const to = tabOrder[i + 1]!;
    const rf = visualRank.get(from);
    const rt = visualRank.get(to);
    if (rf === undefined || rt === undefined) continue;
    // Expected forward step in reading order is +1; anything far from that (esp.
    // negative = jumping back up the page) is a "jump".
    const delta = rt - rf;
    jumps.push({ fromSelector: from, toSelector: to, visualRankDelta: delta });
  }
  return jumps
    .filter((j) => Math.abs(j.visualRankDelta) >= 2) // ignore +1/0/-1 normal steps
    .sort((a, b) => Math.abs(b.visualRankDelta) - Math.abs(a.visualRankDelta))
    .slice(0, limit);
}

/** The conjunctive-gate decision. Returns the computed evidence ONLY if all
 * conditions pass; otherwise null (stay silent). Pure & deterministic. */
function decideFocusOrderFinding(args: {
  steps: FocusOrderStep[];
  reliable: boolean;
  writingDirection: "ltr" | "rtl";
}): {
  tabOrder: FocusOrderStep[];
  domOrderSelectors: string[];
  visualOrderSelectors: string[];
  tauTabVsVisual: number;
  tauTabVsDom: number;
  elementCount: number;
  jumps: { fromSelector: string; toSelector: string; visualRankDelta: number }[];
} | null {
  const { steps, reliable, writingDirection } = args;

  // Gate 0: a programmatic jump corrupted the keyboard sequence → never fire.
  if (!reliable) return null;
  // Gate 1: enough elements for ordering noise to settle, and not so many that we
  // exceed the schema cap (a partial analysis on a huge page would mislead — §8).
  if (
    steps.length < FOCUS_ORDER_CONFIG.minElements ||
    steps.length > FOCUS_ORDER_CONFIG.maxElements
  ) {
    return null;
  }

  const elements: OrderElement[] = steps.map((s) => ({
    selector: s.selector,
    rect: s.rect,
    domRank: s.domRank,
  }));
  const tabSelectors = steps.map((s) => s.selector);
  const domOrderSelectors = buildDomOrder(elements);
  const { order: visualOrderSelectors, largestBandSize } = buildVisualOrder(
    elements,
    writingDirection,
  );

  // Gate 2: geometry degeneracy. If almost everything is one band, visual order
  // is not meaningfully reconstructable (e.g. a single toolbar row) → silent.
  if (
    largestBandSize >=
    steps.length * FOCUS_ORDER_CONFIG.maxBandFraction
  ) {
    return null;
  }

  // Reference = the "expected" order; candidate = the actual keyboard order.
  const tauTabVsVisual = normalizedKendallTau(visualOrderSelectors, tabSelectors);
  const tauTabVsDom = normalizedKendallTau(domOrderSelectors, tabSelectors);

  // Gate 3 (the conjunctive gate): keyboard order must diverge from BOTH visual
  // AND dom. Divergence from visual alone (with tab==dom) is the acceptable
  // CSS-reorder case (flex/grid/float/absolute) → stay silent.
  if (
    tauTabVsVisual <= FOCUS_ORDER_CONFIG.tauVsVisual ||
    tauTabVsDom <= FOCUS_ORDER_CONFIG.tauVsDom
  ) {
    return null;
  }

  const jumps = computeFocusJumps(tabSelectors, visualOrderSelectors, 10);

  return {
    tabOrder: steps,
    domOrderSelectors,
    visualOrderSelectors,
    tauTabVsVisual,
    tauTabVsDom,
    elementCount: steps.length,
    jumps,
  };
}

/** Read the document's effective writing direction for Point 4 visual ordering.
 * Reads <html dir>/computed direction; defaults to ltr. */
async function readWritingDirection(page: PageDriver): Promise<"ltr" | "rtl"> {
  return page.evaluate(() => {
    const html = document.documentElement;
    const dirAttr = (html.getAttribute("dir") || "").toLowerCase();
    if (dirAttr === "rtl") return "rtl";
    if (dirAttr === "ltr") return "ltr";
    const cs = window.getComputedStyle(html);
    return cs.direction === "rtl" ? "rtl" : "ltr";
  });
}

/** Build the one-per-page focus-order divergence review finding. */
function buildFocusOrderFinding(
  decision: NonNullable<ReturnType<typeof decideFocusOrderFinding>>,
  writingDirection: "ltr" | "rtl",
  url: string,
): Finding {
  const criterion = getCriterion("2.4.3");
  // selector = the first off-reading-order element if we found jumps, else the
  // first tab element — gives the report a concrete anchor.
  const anchorSelector =
    decision.jumps[0]?.toSelector ?? decision.tabOrder[0]?.selector;
  return {
    id: uuidv4(),
    wcagSc: "2.4.3",
    wcagLevel: "A",
    // Always review — reading order is subjective; never auto-fail.
    severity: "review",
    source: "keyboard",
    ruleId: FOCUS_ORDER_RULE_ID,
    title: "Keyboard focus order may not match the visual reading order",
    description:
      `The keyboard tab order on this page diverges from both the source order and the ` +
      `on-screen reading order (top-to-bottom, ${writingDirection === "rtl" ? "right-to-left" : "left-to-right"}). ` +
      `Sighted keyboard users may find that focus jumps around unpredictably. ` +
      `Verify the tab order follows a logical, meaningful sequence.`,
    helpUrl: criterion?.url,
    selector: anchorSelector,
    aiGenerated: false,
    requiresHumanReview: true,
    focusOrderEvidence: {
      tabOrder: decision.tabOrder,
      domOrderSelectors: decision.domOrderSelectors,
      visualOrderSelectors: decision.visualOrderSelectors,
      tauTabVsVisual: decision.tauTabVsVisual,
      tauTabVsDom: decision.tauTabVsDom,
      writingDirection,
      elementCount: decision.elementCount,
      reliable: true,
      jumps: decision.jumps,
    },
    remediation:
      "Ensure the DOM order (and any positive tabindex usage) produces a tab sequence that " +
      "matches the visual reading order. Prefer source order that already matches layout; " +
      "avoid using CSS (flex/grid order, absolute positioning) to reorder content in a way " +
      "that desyncs keyboard focus from what the eye expects. See " + (criterion?.url ?? ""),
    tags: ["keyboard", "wcag2a", "wcag243", "cat.keyboard"],
    relatedRuleIds: [],
    relatedNodes: [],
    pageUrl: url,
  };
}

// Exported for unit testing. Not part of the public scanner API.
export const __focusOrderInternals = {
  buildDomOrder,
  buildVisualOrder,
  normalizedKendallTau,
  computeFocusJumps,
  decideFocusOrderFinding,
};
