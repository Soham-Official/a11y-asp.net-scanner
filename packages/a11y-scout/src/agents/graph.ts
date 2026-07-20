import { v4 as uuidv4 } from "uuid";
import { createLlmProvider } from "../llm/index.js";
import type { LlmProvider } from "../llm/provider.js";
import { scanRepoStatic } from "../scanners/static.js";
import { scanUrlRuntime } from "../scanners/runtime.js";
import { crawlAndScan } from "../scanners/crawler.js";
import { captureAuthState } from "../scanners/login.js";
import type { ScanPlan, ScanState } from "../types.js";
import { plan as makePlan, type PlannerInput } from "./planner.js";
import { validate } from "./validator.js";
import { VERSION } from "../version.js";

export interface RunScanOptions extends PlannerInput {
  /** LLM provider for AAA semantic analysis. Auto-detected if omitted. */
  llm?: LlmProvider;
  /** Progress callback for static repo scanning phases. */
  onStaticProgress?: (event: {
    phase: "detect-stack" | "aspnet:js-a11y" | "aspnet:template-files" | "aspnet:html-lint" | "aspnet:dom-injection" | "aspnet:css-patterns" | "aspnet:code-behind" | "react:eslint" | "angular:eslint";
    state: "start" | "done" | "failed" | "progress" | "skipped";
    totalFiles?: number;
    processedFiles?: number;
    currentPath?: string;
    durationMs?: number;
    message?: string;
  }) => void;
  /**
   * Per-page progress callback for crawl mode. Ignored when crawl is off.
   */
  onCrawlProgress?: (info: {
    url: string;
    pagesDone: number;
    pagesTotal: number;
    findingsThisPage: number;
  }) => void;
}

/**
 * V1 orchestrator. Linear flow that mirrors the LangGraph topology described
 * in AGENTS.md: Planner -> {Static | Runtime} -> Validator -> AAASemantic
 * -> Reporter (the Reporter step happens outside this function so the CLI
 * can reuse the same ScanState across multiple report formats).
 *
 * V2 will swap this for a real LangGraph StateGraph with checkpointing,
 * conditional edges, and HITL approval nodes for AAA findings.
 */
export async function runScan(opts: RunScanOptions): Promise<ScanState> {
  // Resolve LLM provider: llm option takes precedence, then haip (wrapped), then auto-detect
  const llm: LlmProvider = resolveLlm(opts);
  const scanPlan = makePlan(opts);

  const providerDesc = llm.describe();
  const state: ScanState = {
    scanId: uuidv4(),
    startedAt: new Date().toISOString(),
    plan: scanPlan,
    evidence: [],
    findings: [],
    passes: [],
    inapplicable: [],
    cost: { totalUsd: 0, entries: [] },
    meta: {
      version: VERSION,
      llmMockMode: llm.isMock,
      llmProvider: providerDesc.provider,
      pagesScanned: [],
      pagesSkipped: [],
    },
  };

  // Optional pre-step: capture auth state for SSO/MFA flows on first run.
  if (
    scanPlan.mode === "url" &&
    scanPlan.captureAuth &&
    scanPlan.authStatePath
  ) {
    await captureAuthState({
      url: scanPlan.target,
      authStatePath: scanPlan.authStatePath,
    });
  }

  // Scanner fan-out. Per-page LLM stages (AAA, content-quality, fix-html) now
  // live inside `scanPage` (called by runtime + crawler), so this orchestrator
  // is just a slice merger. The shared `llm` provider is threaded through so
  // cost accumulates across all pages of a crawl.
  if (scanPlan.scanners.includes("runtime")) {
    if (scanPlan.crawl.enabled) {
      const crawled = await crawlAndScan({
        startUrl: scanPlan.target,
        level: scanPlan.level,
        crawl: scanPlan.crawl,
        llm,
        maxCostUsd: scanPlan.maxCostUsd,
        authStatePath: scanPlan.authStatePath,
        waitUntil: scanPlan.waitUntil,
        waitMs: scanPlan.extraWaitMs,
        headed: scanPlan.headed,
        ignoreHttpsErrors: scanPlan.ignoreHttpsErrors,
        keyboard: scanPlan.keyboard,
        focusChecks: scanPlan.focusChecks,
        noFocusIndicatorScreenshots: scanPlan.noFocusIndicatorScreenshots,
        aiFix: scanPlan.aiFix,
        onProgress: opts.onCrawlProgress,
      });
      state.findings.push(...crawled.findings);
      state.evidence.push(...crawled.evidence);
      state.passes.push(...crawled.passes);
      state.inapplicable.push(...crawled.inapplicable);
      state.meta.pagesScanned = crawled.pagesScanned;
      state.meta.pagesSkipped = crawled.pagesSkipped;
    } else {
      const runtime = await scanUrlRuntime({
        url: scanPlan.target,
        level: scanPlan.level,
        llm,
        maxCostUsd: scanPlan.maxCostUsd,
        authStatePath: scanPlan.authStatePath,
        waitUntil: scanPlan.waitUntil,
        waitMs: scanPlan.extraWaitMs,
        headed: scanPlan.headed,
        ignoreHttpsErrors: scanPlan.ignoreHttpsErrors,
        keyboard: scanPlan.keyboard,
        focusChecks: scanPlan.focusChecks,
        noFocusIndicatorScreenshots: scanPlan.noFocusIndicatorScreenshots,
        aiFix: scanPlan.aiFix,
      });
      state.findings.push(...runtime.findings);
      state.evidence.push(runtime.evidence);
      state.passes.push(...runtime.passes);
      state.inapplicable.push(...runtime.inapplicable);
      state.meta.pagesScanned = [scanPlan.target];
    }
  }

  if (scanPlan.scanners.includes("static")) {
    const staticResult = await scanRepoStatic({
      repoPath: scanPlan.target,
      onProgress: opts.onStaticProgress,
    });
    state.findings.push(...staticResult.findings);
  }

  // Final dedup pass across all per-page slices + static findings. Idempotent
  // with the per-page validate() inside scanPage. NOTE: SC-derived enrichment
  // (helpUrl + wcagLevel) already happened at the two scan chokepoints —
  // scanPage (runtime/crawler/fixture) and scanRepoStatic (repo) — so no
  // enrichFindings call is needed here.
  state.findings = validate(state.findings);

  state.cost.entries = llm.costLog;
  state.cost.totalUsd = llm.totalCost;
  state.finishedAt = new Date().toISOString();

  return state;
}

/**
 * Resolve LLM provider from options.
 * Priority: opts.llm > auto-detect from environment
 */
function resolveLlm(opts: RunScanOptions): LlmProvider {
  if (opts.llm) {
    return opts.llm;
  }
  return createLlmProvider({ maxCostUsd: opts.maxCostUsd });
}

export function summarizeFindings(state: ScanState) {
  const counts = {
    blockers: 0,
    severe: 0,
    major: 0,
    minor: 0,
    review: 0,
    total: state.findings.length,
  };
  for (const f of state.findings) {
    switch (f.severity) {
      case "blocker":
        counts.blockers += 1;
        break;
      case "severe":
        counts.severe += 1;
        break;
      case "major":
        counts.major += 1;
        break;
      case "minor":
        counts.minor += 1;
        break;
      case "review":
        counts.review += 1;
        break;
    }
  }
  const start = Date.parse(state.startedAt);
  const end = state.finishedAt
    ? Date.parse(state.finishedAt)
    : Date.now();
  return {
    ...counts,
    durationMs: end - start,
    costUsd: state.cost.totalUsd,
    passes: state.passes.reduce((sum, p) => sum + p.nodeCount, 0),
    inapplicable: state.inapplicable.length,
  };
}

export type { ScanPlan };
