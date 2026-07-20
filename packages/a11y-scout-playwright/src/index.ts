import { createRequire } from "node:module";
import { test as base, type Page, type TestInfo } from "@playwright/test";
import {
  aggregatePages,
  buildReportDir,
  createLlmProvider,
  createPlaywrightPageDriver,
  emitReports,
  makeScanPlan,
  scanPage,
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

// Read from the package's own package.json so the version is never hardcoded.
const require = createRequire(import.meta.url);
const VERSION: string = (require("../package.json") as { version: string })
  .version;

const DEFAULT_OUT_DIR = "./a11y-reports";

/**
 * Options for a single `scanPage()` call. The first call in a worker locks
 * `level`, `maxCostUsd`, `aiFix`, and the LLM provider; later calls inherit
 * those settings and warn if a conflicting value is passed.
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
  /** Override the slug used by `buildReportDir`. Default: test project name or first URL. */
  reportName?: string;
  /** Throw if the accumulated state has any blocker. Default true. */
  failOnBlockers?: boolean;
  /** Attach the HTML report to the currently-running test. Default true. */
  attach?: boolean;
}

export interface GenerateReportResult {
  state: ScanState;
  reportPaths: { html: string; md: string; json: string };
}

export interface A11yFixture {
  /**
   * Scan the page the test has navigated to and accumulate its findings into
   * the worker-scoped report. Call multiple times across one or more tests
   * to cover several pages of an app; call `generateReport()` once at the
   * end (or let the worker teardown auto-finalize) to produce a single
   * consolidated HTML/Markdown/JSON report.
   */
  scanPage(opts?: ScanPageOptions): Promise<ScanPageSliceResult>;
  /**
   * Emit the consolidated report covering every page scanned in this worker.
   * Throws on accumulated blockers by default. Safe to call from any test;
   * if you forget, the worker teardown finalizes automatically (without
   * attaching to a Playwright test since there is no `TestInfo` at that point).
   */
  generateReport(opts?: GenerateReportOptions): Promise<GenerateReportResult>;
}

type WorkerSlice = PerPageSlice & { title: string | null };

interface WorkerAccumulator {
  pageScans: WorkerSlice[];
  level: ScanLevel | null;
  llm: LlmProvider | null;
  maxCostUsd: number | undefined;
  aiFix: boolean | undefined;
  outDir: string;
  projectName: string | null;
  reportEmitted: boolean;
  startedAt: string;
}

export const test = base.extend<
  { a11y: A11yFixture },
  { a11yAccumulator: WorkerAccumulator }
>({
  a11yAccumulator: [
    async ({}, use) => {
      const accumulator: WorkerAccumulator = {
        pageScans: [],
        level: null,
        llm: null,
        maxCostUsd: undefined,
        aiFix: undefined,
        outDir: DEFAULT_OUT_DIR,
        projectName: null,
        reportEmitted: false,
        startedAt: new Date().toISOString(),
      };
      await use(accumulator);
      // Worker teardown — auto-emit if user never called generateReport().
      // We have no TestInfo here, so we cannot attach to a test report.
      if (!accumulator.reportEmitted && accumulator.pageScans.length > 0) {
        try {
          await finalizeAndEmit(accumulator, null, {
            outDir: accumulator.outDir,
            failOnBlockers: false,
            attach: false,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[a11y-scout] auto-finalize failed: ${(err as Error).message}`,
          );
        }
      }
    },
    { scope: "worker" },
  ],

  a11y: async ({ page, a11yAccumulator }, use, testInfo) => {
    if (!a11yAccumulator.projectName) {
      a11yAccumulator.projectName = testInfo.project.name || null;
    }
    await use({
      scanPage: (opts = {}) => doScanPage(page, testInfo, a11yAccumulator, opts),
      generateReport: (opts = {}) =>
        finalizeAndEmit(a11yAccumulator, testInfo, opts),
    });
  },
});

export { expect } from "@playwright/test";

async function doScanPage(
  page: Page,
  testInfo: TestInfo,
  acc: WorkerAccumulator,
  opts: ScanPageOptions,
): Promise<ScanPageSliceResult> {
  const url = page.url();

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

  // Wrap the Playwright Page in the engine's PageDriver abstraction. The
  // engine itself never imports Playwright; this thin adapter is the seam.
  const driver = createPlaywrightPageDriver(page);
  const result = await scanPage({
    page: driver,
    url,
    level: acc.level,
    llm: acc.llm,
    maxCostUsd: acc.maxCostUsd,
    keyboard: opts.keyboard,
    focusChecks: opts.focusChecks,
    noFocusIndicatorScreenshots: opts.noFocusIndicatorScreenshots,
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
          `Call generateReport() (or let worker teardown finalize) to see the consolidated report.`,
      );
    }
  }

  void testInfo;
  return {
    findings: result.findings,
    evidence: result.evidence,
    passes: result.passes,
    inapplicable: result.inapplicable,
    pageUrl: url,
    accumulatedCount,
  };
}

async function finalizeAndEmit(
  acc: WorkerAccumulator,
  testInfo: TestInfo | null,
  opts: GenerateReportOptions,
): Promise<GenerateReportResult> {
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

  const target =
    opts.reportName ?? acc.projectName ?? acc.pageScans[0]!.url;

  const providerDesc = llm.describe();
  const state: ScanState = {
    scanId: `${acc.projectName ?? "fixture"}-${acc.startedAt}`,
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

  if (testInfo && opts.attach !== false) {
    await testInfo.attach("a11y-report", {
      path: htmlPath,
      contentType: "text/html",
    });
  }

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
