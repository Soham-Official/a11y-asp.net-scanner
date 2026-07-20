import type {
  CrawlOptions,
  ScanLevel,
  ScanMode,
  ScanPlan,
  WaitUntil,
} from "../types.js";

export interface PlannerInput {
  mode: ScanMode;
  target: string;
  level: ScanLevel;
  authStatePath?: string;
  captureAuth?: boolean;
  headed?: boolean;
  ignoreHttpsErrors?: boolean;
  maxCostUsd?: number;
  waitUntil?: WaitUntil;
  extraWaitMs?: number;
  keyboard?: boolean;
  focusChecks?: boolean;
  noFocusIndicatorScreenshots?: boolean;
  aiFix?: boolean;
  crawl?: Partial<CrawlOptions>;
}

const DEFAULT_CRAWL: CrawlOptions = {
  enabled: false,
  maxPages: 10,
  maxDepth: 2,
};

export function plan(input: PlannerInput): ScanPlan {
  const scanners: ScanPlan["scanners"] = [];

  if (input.mode === "url" || input.mode === "fixture") {
    scanners.push("runtime");
    // Content-quality LLM checks for A & AA SCs that need semantic judgement
    // (alt text quality, page title descriptiveness, link purpose, error
    // messages, form labels, etc). Gated again at graph level on
    // `!llm.isMock` so mock-only environments stay deterministic.
    scanners.push("content-quality");
  }
  if (input.mode === "repo") {
    scanners.push("static");
  }
  // AAA semantic checks are expensive (LLM calls) and only relevant
  // when the user explicitly requests AAA-level conformance analysis.
  if (input.level === "AAA") {
    scanners.push("aaa-semantic");
  }

  return {
    mode: input.mode,
    target: input.target,
    level: input.level,
    scanners,
    authStatePath: input.authStatePath,
    captureAuth: Boolean(input.captureAuth),
    headed: Boolean(input.headed),
    ignoreHttpsErrors: Boolean(input.ignoreHttpsErrors),
    maxCostUsd: input.maxCostUsd ?? 1.0,
    waitUntil: input.waitUntil ?? "load",
    extraWaitMs: input.extraWaitMs ?? 0,
    keyboard: input.keyboard ?? true,
    focusChecks: input.focusChecks ?? true,
    noFocusIndicatorScreenshots: Boolean(input.noFocusIndicatorScreenshots),
    aiFix: input.aiFix ?? true,
    crawl: { ...DEFAULT_CRAWL, ...(input.crawl ?? {}) },
  };
}
