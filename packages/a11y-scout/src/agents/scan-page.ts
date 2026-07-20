import { v4 as uuidv4 } from "uuid";
import type { CheckResult } from "axe-core";
import type {
  Finding,
  InapplicableRule,
  PageEvidence,
  PassedRule,
  ScanLevel,
} from "../types.js";
import type { LlmProvider } from "../llm/provider.js";
import type { PageDriver } from "../driver/interfaces.js";
import { buildAxeConfig } from "../scanners/axe-config.js";
import { collectPageEvidence } from "../scanners/runtime.js";
import { runKeyboardTrapChecks } from "../scanners/keyboard.js";
import { runReflowCheck } from "../scanners/reflow.js";
import {
  enrichFindings,
  getCriterion,
  scIdsForAxeRule,
  severityForScList,
} from "../wcag.js";
import { validate } from "./validator.js";
import { runAaaSemantic } from "./aaa-semantic.js";
import { runContentQuality } from "./content-quality.js";
import { runFixHtml } from "./fix-html.js";

/**
 * Single source of truth for "Playwright `page` → per-page scan result".
 *
 * Both the CLI runtime scanner (which owns its own browser/context) and the
 * `@a11y-scout/playwright` fixture (which reuses Playwright's page) call this
 * function. Anything they need to do *differently* (browser launch, page.goto,
 * report writing, test failure on blockers) lives outside this module — this
 * function is the engine.
 *
 * Caller responsibility:
 *   - `page` is already *navigated* to `url`. Post-navigation **readiness** —
 *     a best-effort `networkidle` wait + optional fixed delay — is owned here
 *     so every surface (CLI, crawler, fixture) sees the same DOM at scan
 *     time. Disable via `waitForNetworkIdle: false` if your test already
 *     handles readiness explicitly.
 *   - `llm` is provided so cost accumulates on a single shared provider across
 *     a multi-page crawl. We never construct a provider here.
 */

const NETWORK_IDLE_TIMEOUT_MS = 15_000;

export interface ScanPageOptions {
  page: PageDriver;
  url: string;
  level: ScanLevel;
  llm: LlmProvider;
  /** Cumulative LLM cost ceiling (USD). Honored by content-quality + fix-html. */
  maxCostUsd?: number;
  /** Disable all keyboard checks (incl. reflow). Default: keyboard on. */
  keyboard?: boolean;
  /** Disable Phase-2 focus checks (off-screen, indicator, modal leak). Default: on. */
  focusChecks?: boolean;
  /** Disable tier-2 focus-indicator screenshots on single-page scans (no-op under crawl — crawl auto-disables tier-2 for cost). */
  noFocusIndicatorScreenshots?: boolean;
  /** Set by the crawler so the keyboard scanner disables the screenshot tier. */
  inCrawl?: boolean;
  /** Optional axe include selector. */
  include?: string;
  /** Optional axe exclude selectors. */
  exclude?: string[];
  /** Suppress fix-html LLM calls even when a real provider is available. */
  aiFix?: boolean;
  /**
   * Best-effort wait for `networkidle` (15s ceiling, swallowed on timeout)
   * before scanning. Default true — gives lazy 3rd-party widgets time to
   * inject DOM so CLI and fixture see the same page state. Sites that hold
   * long-poll connections open will hit the ceiling and fall through cleanly.
   */
  waitForNetworkIdle?: boolean;
  /** Fixed delay applied after readiness, before scanning. */
  extraWaitMs?: number;
}

export interface ScanPageResult {
  findings: Finding[];
  evidence: PageEvidence;
  passes: PassedRule[];
  inapplicable: InapplicableRule[];
}

export async function scanPage(opts: ScanPageOptions): Promise<ScanPageResult> {
  const {
    page,
    url,
    level,
    llm,
    maxCostUsd,
    keyboard,
    focusChecks,
    noFocusIndicatorScreenshots,
    inCrawl = false,
    include,
    exclude,
    aiFix = true,
    waitForNetworkIdle = true,
    extraWaitMs,
  } = opts;

  // 0. Page readiness. Best-effort `networkidle` so lazy widgets (chat,
  //    consent, late XHRs) have a chance to render before axe snapshots the
  //    DOM. Long-poll connections hit the timeout and fall through.
  if (waitForNetworkIdle) {
    await page
      .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS })
      .catch(() => {});
  }
  if (extraWaitMs && extraWaitMs > 0) {
    await page.waitForTimeout(extraWaitMs);
  }

  // 1. axe-core analysis. Same buildAxeConfig() the CLI uses, so rule selection
  //    + opt-ins (target-size, css-orientation-lock, label-content-name-mismatch,
  //    color-contrast-enhanced at AAA) are identical across surfaces. The
  //    driver owns axe-core injection so this code is framework-agnostic.
  const results = await page.runAxe(buildAxeConfig(level, { include, exclude }));

  const findings: Finding[] = [];

  // 2. Confirmed violations → Findings via the WCAG catalog (curated SC + severity).
  for (const violation of results.violations) {
    const scIds = scIdsForAxeRule(violation.id, violation.tags);
    const primarySc = scIds[0];
    const criterion = primarySc ? getCriterion(primarySc) : undefined;
    const wcagLevel = criterion?.level ?? "AA";
    // Severity is the MAX across all mapped SCs — never derive it from
    // scIds[0], or a lower-severity SC listed first silently downgrades a
    // blocker (the historical `label` bug).
    const severity =
      severityForScList(scIds) ?? axeImpactToSeverity(violation.impact);

    for (const node of violation.nodes) {
      findings.push({
        id: uuidv4(),
        wcagSc: primarySc ?? "n/a",
        wcagLevel,
        severity,
        source: "axe",
        ruleId: violation.id,
        title: violation.help,
        description: violation.description,
        impact: violation.impact ?? undefined,
        // helpUrl (W3C canonical) is stamped by enrichFindings before return;
        // the deque deep-link is preserved as the secondary docUrl.
        docUrl: violation.helpUrl,
        selector: node.target.join(", "),
        xpath: node.xpath?.join(" > ") ?? undefined,
        htmlSnippet: node.html,
        remediation:
          node.failureSummary ??
          `Review the axe-core docs at ${violation.helpUrl}`,
        aiGenerated: false,
        requiresHumanReview: false,
        tags: violation.tags,
        relatedRuleIds: [],
        relatedNodes: extractRelatedNodes(node),
        pageUrl: url,
      });
    }
  }

  // 3. axe `incomplete` results (cases axe couldn't decide automatically —
  //    color-contrast over images, dynamic content, etc) → Findings flagged
  //    `requiresHumanReview: true`. The fixture used to drop these; now both
  //    surfaces emit them.
  for (const incomplete of results.incomplete) {
    const scIds = scIdsForAxeRule(incomplete.id, incomplete.tags);
    const primarySc = scIds[0];
    const criterion = primarySc ? getCriterion(primarySc) : undefined;
    const wcagLevel = criterion?.level ?? "AA";
    // Max severity across all mapped SCs (see the violations loop above).
    const severity = severityForScList(scIds) ?? "major";

    for (const node of incomplete.nodes) {
      const primaryCheck = node.any?.[0] ?? node.all?.[0] ?? null;

      findings.push({
        id: uuidv4(),
        wcagSc: primarySc ?? "n/a",
        wcagLevel,
        severity,
        source: "axe",
        ruleId: incomplete.id,
        title: `${incomplete.help} (Needs Review)`,
        description: `${incomplete.description} — axe-core could not determine compliance automatically due to complex backgrounds, images, or dynamic content.`,
        impact: node.impact ?? undefined,
        // See violations loop: W3C helpUrl stamped by enrichFindings; deque
        // deep-link kept as secondary docUrl.
        docUrl: incomplete.helpUrl,
        selector: node.target.join(", "),
        xpath: node.xpath?.join(" > ") ?? undefined,
        htmlSnippet: node.html,
        remediation:
          primaryCheck?.message ??
          `Manually verify this element meets WCAG requirements. See ${incomplete.helpUrl}`,
        aiGenerated: false,
        requiresHumanReview: true,
        tags: incomplete.tags,
        relatedRuleIds: [],
        relatedNodes: extractRelatedNodes(node),
        pageUrl: url,
        incompleteData: primaryCheck
          ? {
              checkId: primaryCheck.id,
              message: primaryCheck.message,
              data: primaryCheck.data != null ? primaryCheck.data : null,
              relatedNodes: (primaryCheck.relatedNodes ?? [])
                .slice(0, 5)
                .map(
                  (rn): { html: string; target: string[] } => ({
                    html: rn.html,
                    target: rn.target
                      .flatMap((selector) =>
                        typeof selector === "string" ? selector : selector,
                      )
                      .filter((s): s is string => typeof s === "string"),
                  }),
                ),
            }
          : undefined,
      });
    }
  }

  // 4. Passes + inapplicable summaries.
  const passes: PassedRule[] = results.passes.map((rule) => {
    const scIds = scIdsForAxeRule(rule.id, rule.tags);
    const primarySc = scIds[0];
    const criterion = primarySc ? getCriterion(primarySc) : undefined;
    return {
      ruleId: rule.id,
      description: rule.description,
      helpUrl: rule.helpUrl,
      wcagSc: primarySc ?? "n/a",
      wcagLevel: criterion?.level ?? "AA",
      tags: rule.tags,
      nodeCount: rule.nodes.length,
      sampleSelectors: rule.nodes.slice(0, 5).map((n) => n.target.join(", ")),
      pageUrls: [url],
    };
  });

  const inapplicable: InapplicableRule[] = results.inapplicable.map((rule) => {
    const scIds = scIdsForAxeRule(rule.id, rule.tags);
    const primarySc = scIds[0];
    const criterion = primarySc ? getCriterion(primarySc) : undefined;
    return {
      ruleId: rule.id,
      description: rule.description,
      helpUrl: rule.helpUrl,
      wcagSc: primarySc ?? "n/a",
      wcagLevel: criterion?.level ?? "AA",
      tags: rule.tags,
      pageUrls: [url],
    };
  });

  // 5. Page evidence for the LLM agents (and report rendering).
  const evidence = await collectPageEvidence(page, url);

  // 6. Reflow (1.4.10) — runs BEFORE keyboard so the viewport restore happens
  //    before the keyboard scanner reads geometry. Rides the `keyboard` toggle.
  if (keyboard !== false) {
    const reflow = await runReflowCheck({ page, url });
    findings.push(...reflow.findings);
    passes.push(...reflow.passes);
  }

  // 7. Keyboard trap + Phase-2 focus checks. Runs AFTER axe so DOM perturbations
  //    don't leak into the axe snapshot.
  if (keyboard !== false) {
    const kb = await runKeyboardTrapChecks({
      page,
      url,
      level,
      focusChecks,
      noFocusIndicatorScreenshots,
      inCrawl,
    });
    findings.push(...kb.findings);
    passes.push(...kb.passes);
  }

  // 8. Validator dedup (idempotent — graph.ts may also call validate() on the
  //    merged set across pages; that's safe).
  let validated = validate(findings);

  // 9. AAA semantic agent (only at level AAA). Per-page invocation; agent
  //    iterates `evidence` internally so single-page is functionally identical.
  if (level === "AAA") {
    const aaa = await runAaaSemantic({ evidence: [evidence], llm });
    validated = validate([...validated, ...aaa.findings]);
  }

  // 10. Content-quality (A/AA) agent. Skipped under mock providers so CI runs
  //     stay deterministic. Cost ceiling enforced via the shared `llm`.
  if (!llm.isMock) {
    const cq = await runContentQuality({
      evidence: [evidence],
      llm,
      maxCostUsd,
    });
    validated = validate([...validated, ...cq.findings]);
  }

  // 11. fix-html: per-finding LLM-suggested corrected HTML, written onto
  //     `finding.aiFixedHtml` for report rendering. Gated on a real provider
  //     and the explicit `aiFix` opt (CLI `--no-ai-fix` and the fixture both
  //     thread through here).
  if (aiFix !== false && !llm.isMock && validated.length > 0) {
    await runFixHtml({
      findings: validated,
      llm,
      maxCostUsd,
    });
  }

  // Enrichment chokepoint (covers CLI, crawler, AND the Playwright fixture,
  // which calls scanPage directly and never touches graph.ts). Stamps the
  // catalog-canonical helpUrl + wcagLevel; severity/docUrl are untouched.
  return {
    findings: enrichFindings(validated),
    evidence,
    passes,
    inapplicable,
  };
}

/**
 * Collect related nodes from all check results (any, all, none) on a violation
 * node. Deduplicates by target selector and caps at MAX_RELATED_NODES.
 */
const MAX_RELATED_NODES = 10;

function extractRelatedNodes(
  node: { any: CheckResult[]; all: CheckResult[]; none: CheckResult[] },
): Array<{ html: string; target: string[] }> {
  const seen = new Set<string>();
  const results: Array<{ html: string; target: string[] }> = [];

  for (const check of [...node.any, ...node.all, ...node.none]) {
    if (!check.relatedNodes) continue;
    for (const rn of check.relatedNodes) {
      const target = rn.target
        .flatMap((selector: string | string[]) =>
          typeof selector === "string" ? [selector] : selector,
        )
        .filter((s: unknown): s is string => typeof s === "string");

      const key = target.join(",");
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        html: rn.html.slice(0, 200),
        target,
      });

      if (results.length >= MAX_RELATED_NODES) return results;
    }
  }

  return results;
}

function axeImpactToSeverity(
  impact: string | null | undefined,
): Finding["severity"] {
  switch (impact) {
    case "critical":
      return "blocker";
    case "serious":
      return "severe";
    case "moderate":
      return "major";
    case "minor":
      return "minor";
    default:
      return "major";
  }
}
