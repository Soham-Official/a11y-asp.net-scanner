import { createRequire } from "node:module";
import {
  aggregatePages,
  buildReportDir,
  createLlmProvider,
  emitReports,
  makeScanPlan,
  scanPage as coreScanPage,
  summarizeFindings,
  type Finding,
  type InapplicableRule,
  type LlmProvider,
  type PageEvidence,
  type PassedRule,
  type PerPageSlice,
  type ScanLevel,
  type ScanState,
} from "a11y-scout";
import { createWebdriverioPageDriver } from "./webdriverio-page-driver.js";

export {
  WebdriverioPageDriver,
  createWebdriverioPageDriver,
} from "./webdriverio-page-driver.js";

/** WebdriverIO's browser object — the input to every entry point here. */
type WdioBrowser = WebdriverIO.Browser;

// Read from the package's own package.json so the version is never hardcoded.
const require = createRequire(import.meta.url);
const VERSION: string = (require("../package.json") as { version: string })
  .version;

const DEFAULT_OUT_DIR = "./a11y-reports";

/**
 * Options for a single `scanPage()` call. The first call in a worker locks
 * `level`, `maxCostUsd`, `aiFix`, and the LLM provider; later calls inherit
 * those settings and warn if a conflicting value is passed.
 *
 * This is the WebdriverIO analog of `@a11y-scout/playwright`'s `ScanPageOptions`
 * — the option surface is intentionally identical so the two integrations stay
 * interchangeable. See the shared option reference in the README.
 */
export interface ScanPageOptions {
  level?: ScanLevel;
  include?: string;
  exclude?: string[];
  /** Throw if this page introduces any blocker. Default true. */
  failOnBlockers?: boolean;
  maxCostUsd?: number;
  keyboard?: boolean;
  focusChecks?: boolean;
  /**
   * Tier-2 focus-indicator screenshots. Default OFF under WebdriverIO —
   * WebDriver has no region-clipped screenshot, and a full-frame fallback would
   * produce false "no indicator" findings. Set true only if you accept that
   * limitation (the adapter will throw on the clip and the check degrades to
   * "indicator present").
   */
  noFocusIndicatorScreenshots?: boolean;
  aiFix?: boolean;
  waitForNetworkIdle?: boolean;
  extraWaitMs?: number;
  /** Custom LLM provider. Honored only on the FIRST scanPage call in a worker. */
  llm?: LlmProvider;
}

export interface ScanPageSliceResult {
  /** Findings produced by this page only. */
  findings: Finding[];
  evidence: PageEvidence;
  passes: PassedRule[];
  inapplicable: InapplicableRule[];
  pageUrl: string;
  /** Running total of accumulated findings in this worker. */
  accumulatedCount: number;
}

export interface GenerateReportOptions {
  /** Reports go under this directory. Default ./a11y-reports. */
  outDir?: string;
  /** Override the slug used by `buildReportDir`. Default: first URL scanned. */
  reportName?: string;
  /** Throw if the accumulated state has any blocker. Default true. */
  failOnBlockers?: boolean;
}

export interface GenerateReportResult {
  state: ScanState;
  reportPaths: { html: string; md: string; json: string };
}

type WorkerSlice = PerPageSlice & { title: string | null };

interface Accumulator {
  pageScans: WorkerSlice[];
  level: ScanLevel | null;
  llm: LlmProvider | null;
  maxCostUsd: number | undefined;
  aiFix: boolean | undefined;
  outDir: string;
  reportEmitted: boolean;
  startedAt: string;
}

// One accumulator per process. WebdriverIO runs each worker in its own process,
// so a module-level singleton is worker-scoped exactly like the Playwright
// fixture's worker-scoped accumulator.
const accumulator: Accumulator = {
  pageScans: [],
  level: null,
  llm: null,
  maxCostUsd: undefined,
  aiFix: undefined,
  outDir: DEFAULT_OUT_DIR,
  reportEmitted: false,
  startedAt: new Date().toISOString(),
};

/**
 * Scan the page `browser` is currently on and accumulate its findings into the
 * worker-scoped report. Call multiple times across one or more tests to cover
 * several pages of an app; call `generateReport()` once at the end to produce a
 * single consolidated HTML/Markdown/JSON report.
 *
 * Unlike the Playwright fixture (which receives `page` by injection), the
 * WebdriverIO `browser` is passed explicitly — this works in both the
 * testrunner and standalone (`remote()`) modes and needs no global.
 */
export async function scanPage(
  browser: WdioBrowser,
  opts: ScanPageOptions = {},
): Promise<ScanPageSliceResult> {
  const acc = accumulator;
  const url = await browser.getUrl();

  // Lock level on first call.
  const requestedLevel = opts.level ?? "AA";
  if (acc.level === null) {
    acc.level = requestedLevel;
    acc.maxCostUsd = opts.maxCostUsd;
    acc.aiFix = opts.aiFix;
  } else if (opts.level && opts.level !== acc.level) {
    // eslint-disable-next-line no-console
    console.warn(
      `[a11y-scout] scanPage ignoring level="${opts.level}" — already locked to "${acc.level}" by the first call in this worker.`,
    );
  }

  // Lazy-init the LLM provider; later calls reuse it so cost accumulates on a
  // single meter. We intentionally ignore `opts.llm` on later calls — swapping
  // providers mid-worker would silently fragment the cost log.
  if (acc.llm === null) {
    acc.llm = opts.llm ?? createLlmProvider({ maxCostUsd: acc.maxCostUsd });
  } else if (opts.llm && opts.llm !== acc.llm) {
    // eslint-disable-next-line no-console
    console.warn(
      `[a11y-scout] scanPage ignoring opts.llm — provider was locked on the first call in this worker.`,
    );
  }

  // Wrap the WebdriverIO browser in the engine's PageDriver abstraction. The
  // engine itself never imports WebdriverIO; this thin adapter is the seam.
  const driver = await createWebdriverioPageDriver(browser);
  const result = await coreScanPage({
    page: driver,
    url,
    level: acc.level,
    llm: acc.llm,
    maxCostUsd: acc.maxCostUsd,
    keyboard: opts.keyboard,
    focusChecks: opts.focusChecks,
    // Default tier-2 focus-indicator screenshots OFF: WebDriver has no clipped
    // screenshot, so a full-frame diff would create false-positive findings.
    noFocusIndicatorScreenshots: opts.noFocusIndicatorScreenshots ?? true,
    aiFix: acc.aiFix,
    include: opts.include,
    exclude: opts.exclude,
    inCrawl: false,
    waitForNetworkIdle: opts.waitForNetworkIdle,
    extraWaitMs: opts.extraWaitMs,
  });

  acc.pageScans.push({
    url,
    title: result.evidence.title ?? null,
    findings: result.findings,
    evidence: result.evidence,
    passes: result.passes,
    inapplicable: result.inapplicable,
  });

  const accumulatedCount = acc.pageScans.reduce(
    (n, s) => n + s.findings.length,
    0,
  );

  if (opts.failOnBlockers ?? true) {
    const blockers = result.findings.filter((f) => f.severity === "blocker");
    if (blockers.length > 0) {
      throw new Error(
        `a11y-scout: ${blockers.length} WCAG blocker(s) on ${url}. ` +
          `Call generateReport() to see the consolidated report.`,
      );
    }
  }

  return {
    findings: result.findings,
    evidence: result.evidence,
    passes: result.passes,
    inapplicable: result.inapplicable,
    pageUrl: url,
    accumulatedCount,
  };
}

/**
 * Emit the consolidated report covering every page scanned in this worker.
 * Throws on accumulated blockers by default. Reports are written to disk under
 * `outDir` (default `./a11y-reports`). Wire this into a WebdriverIO `after`
 * hook in `wdio.conf.ts` to run once per worker, e.g.:
 *
 * ```ts
 * import { generateReport } from "@a11y-scout/webdriverio";
 * export const config = {
 *   after: async () => { await generateReport({ failOnBlockers: false }); },
 * };
 * ```
 */
export async function generateReport(
  opts: GenerateReportOptions = {},
): Promise<GenerateReportResult> {
  const acc = accumulator;
  if (acc.pageScans.length === 0) {
    throw new Error(
      "a11y-scout: generateReport() called before any scanPage() — nothing to report.",
    );
  }

  const outDir = opts.outDir ?? acc.outDir ?? DEFAULT_OUT_DIR;
  acc.outDir = outDir;
  const level = acc.level ?? "AA";
  const llm = acc.llm ?? createLlmProvider({ maxCostUsd: acc.maxCostUsd });

  const aggregated = aggregatePages(
    acc.pageScans.map((s) => ({
      url: s.url,
      findings: s.findings,
      evidence: s.evidence,
      passes: s.passes,
      inapplicable: s.inapplicable,
    })),
  );

  const target = opts.reportName ?? acc.pageScans[0]!.url;

  const providerDesc = llm.describe();
  const state: ScanState = {
    scanId: `webdriverio-${acc.startedAt}`,
    startedAt: acc.startedAt,
    finishedAt: new Date().toISOString(),
    plan: makeScanPlan({
      mode: "fixture",
      target,
      level,
      maxCostUsd: acc.maxCostUsd,
      aiFix: acc.aiFix,
    }),
    evidence: aggregated.evidence,
    findings: aggregated.findings,
    passes: aggregated.passes,
    inapplicable: aggregated.inapplicable,
    cost: { totalUsd: llm.totalCost, entries: llm.costLog },
    meta: {
      version: VERSION,
      llmMockMode: llm.isMock,
      llmProvider: providerDesc.provider,
      pagesScanned: aggregated.pagesScanned,
      pagesSkipped: [],
    },
  };

  const reportDir = buildReportDir(outDir, target, "fixture");
  const { jsonPath, mdPath, htmlPath } = await emitReports(state, reportDir);

  acc.reportEmitted = true;

  if (opts.failOnBlockers ?? true) {
    const summary = summarizeFindings(state);
    if (summary.blockers > 0) {
      throw new Error(
        `a11y-scout: ${summary.blockers} WCAG blocker(s) across ${aggregated.pagesScanned.length} page(s). See ${htmlPath}.`,
      );
    }
  }

  return {
    state,
    reportPaths: { html: htmlPath, md: mdPath, json: jsonPath },
  };
}

/**
 * Reset the worker accumulator. Primarily for tests that exercise multiple
 * independent scan sessions in one process.
 */
export function resetA11yAccumulator(): void {
  accumulator.pageScans = [];
  accumulator.level = null;
  accumulator.llm = null;
  accumulator.maxCostUsd = undefined;
  accumulator.aiFix = undefined;
  accumulator.outDir = DEFAULT_OUT_DIR;
  accumulator.reportEmitted = false;
  accumulator.startedAt = new Date().toISOString();
}
