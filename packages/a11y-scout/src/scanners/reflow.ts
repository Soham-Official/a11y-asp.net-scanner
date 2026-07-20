import { v4 as uuidv4 } from "uuid";
import type { Finding, PassedRule } from "../types.js";
import type { PageDriver } from "../driver/interfaces.js";
import { getCriterion, severityForSc } from "../wcag.js";

/** Stable rule id — used as the validator dedup key AND the PassedRule ruleId. */
export const REFLOW_RULE_ID = "reflow-horizontal-scroll";

/** WCAG 1.4.10 reference width: 320 CSS px. */
export const REFLOW_VIEWPORT_WIDTH = 320;

/** WCAG 1.4.10 reference height: 256 CSS px. */
export const REFLOW_VIEWPORT_HEIGHT = 256;

/** Sub-pixel rounding tolerance — Chromium emits scrollWidth as integer CSS
 * px but the layout engine occasionally over-reports by 1-2 px on responsive
 * pages with vertical scrollbars. 4 px is empirically safe. */
export const REFLOW_TOLERANCE_PX = 4;

/** Selectors whose subtrees are exempt from 1.4.10 per the spec ("content that
 * by usage requires a two-dimensional layout"). Tables, code blocks, SVG
 * graphics, images-as-applications (maps), and explicit `role=img` graphics
 * are the canonical examples. Overflow CONTAINED to these subtrees does not
 * fire the rule. */
const EXEMPT_SELECTORS = [
  "table",
  "pre",
  "svg",
  '[role="img"]',
  '[role="application"]',
];

export interface ReflowOptions {
  page: PageDriver;
  url: string;
}

export interface ReflowResult {
  findings: Finding[];
  passes: PassedRule[];
}

/**
 * WCAG 1.4.10 Reflow check. Resizes the viewport to 320×256 CSS px, reads
 * documentElement.scrollWidth, and flags pages whose horizontal overflow
 * cannot be attributed to an exempt subtree (table/pre/svg/etc.).
 *
 * Restores the original viewport on every exit path (try/finally). Does not
 * call .analyze() on axe; this is a pure geometric probe. No LLM, no network.
 */
export async function runReflowCheck(opts: ReflowOptions): Promise<ReflowResult> {
  const { page, url } = opts;
  const original = page.viewportSize();

  let measurement: {
    scrollWidth: number;
    overflowExempt: boolean;
    offendingSelector?: string;
  };
  try {
    await page.setViewportSize({
      width: REFLOW_VIEWPORT_WIDTH,
      height: REFLOW_VIEWPORT_HEIGHT,
    });
    // Suppress animations during the probe so transient transform-based widths
    // don't create false positives. Idempotent if the keyboard scanner's
    // determinism shim already ran.
    await page.addStyleTag({
      content: `*, *::before, *::after { transition: none !important; animation: none !important; }`,
    });

    measurement = await page.evaluate(
      ({ width, exempt, tol }) => {
        const root = document.documentElement;
        const sw = root.scrollWidth;
        if (sw <= width + tol) {
          return { scrollWidth: sw, overflowExempt: false };
        }
        const exemptSel = exempt.join(",");
        const all = root.querySelectorAll("*");
        let firstOffender: string | undefined;
        for (const el of Array.from(all)) {
          const r = el.getBoundingClientRect();
          if (r.right <= width + tol) continue;
          if (el.closest(exemptSel)) continue;
          // Build a short selector for evidence (id > tag.class > tag).
          if (el.id) {
            firstOffender = `#${el.id}`;
          } else {
            const cls = (el.getAttribute("class") || "")
              .split(/\s+/)
              .filter(Boolean)[0];
            firstOffender = cls
              ? `${el.tagName.toLowerCase()}.${cls}`
              : el.tagName.toLowerCase();
          }
          break;
        }
        return {
          scrollWidth: sw,
          overflowExempt: firstOffender === undefined,
          offendingSelector: firstOffender,
        };
      },
      {
        width: REFLOW_VIEWPORT_WIDTH,
        exempt: EXEMPT_SELECTORS,
        tol: REFLOW_TOLERANCE_PX,
      },
    );
  } finally {
    if (original) {
      await page.setViewportSize(original).catch(() => {});
    }
  }

  const criterion = getCriterion("1.4.10");
  const isViolation =
    measurement.scrollWidth > REFLOW_VIEWPORT_WIDTH + REFLOW_TOLERANCE_PX &&
    !measurement.overflowExempt;

  if (!isViolation) {
    return {
      findings: [],
      passes: [
        {
          ruleId: REFLOW_RULE_ID,
          description: criterion?.title ?? "Reflow",
          helpUrl: criterion?.url,
          wcagSc: "1.4.10",
          wcagLevel: "AA",
          tags: ["wcag2aa", "wcag1410", "cat.reflow"],
          nodeCount: 1,
          sampleSelectors: [],
          pageUrls: [url],
        },
      ],
    };
  }

  return {
    findings: [
      {
        id: uuidv4(),
        wcagSc: "1.4.10",
        wcagLevel: "AA",
        severity: severityForSc("1.4.10", "AA"),
        source: "reflow",
        ruleId: REFLOW_RULE_ID,
        title: "Content does not reflow at 320 CSS px",
        description:
          `At a 320×256 CSS-pixel viewport the page reports ` +
          `document.documentElement.scrollWidth = ${measurement.scrollWidth}px, ` +
          `requiring horizontal scrolling. WCAG 1.4.10 requires content to ` +
          `reflow without two-dimensional scrolling (except for content that by ` +
          `usage requires 2-D layout — tables, code blocks, maps).`,
        helpUrl: criterion?.url,
        selector: measurement.offendingSelector,
        aiGenerated: false,
        requiresHumanReview: false,
        tags: ["wcag2aa", "wcag1410", "cat.reflow"],
        relatedRuleIds: [],
        relatedNodes: [],
        pageUrl: url,
        remediation:
          "Use a responsive layout (max-width:100%, fluid grids, media queries). " +
          "Avoid fixed pixel widths on top-level containers. The 1.4.10 exception " +
          "only covers content that requires 2-D layout (tables, code blocks, " +
          "maps, complex images).",
      },
    ],
    passes: [],
  };
}
