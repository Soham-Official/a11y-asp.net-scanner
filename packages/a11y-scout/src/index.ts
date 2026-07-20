export { runScan, summarizeFindings } from "./agents/graph.js";
export type { RunScanOptions } from "./agents/graph.js";
export { runAaaSemantic } from "./agents/aaa-semantic.js";
export { runContentQuality } from "./agents/content-quality.js";
export { scanPage } from "./agents/scan-page.js";
export type { ScanPageOptions, ScanPageResult } from "./agents/scan-page.js";
export { plan as makeScanPlan } from "./agents/planner.js";
export type { PlannerInput } from "./agents/planner.js";
export { validate } from "./agents/validator.js";
export { aggregatePages } from "./agents/aggregate-pages.js";
export type {
  PerPageSlice,
  AggregatedPages,
} from "./agents/aggregate-pages.js";
export {
  collectPageEvidence,
  analyzeLoadedPage,
  TAGS_FOR_LEVEL,
} from "./scanners/runtime.js";
export type { RuntimeScanResult } from "./scanners/runtime.js";
export { buildAxeConfig } from "./scanners/axe-config.js";
export type { BuildAxeOptions } from "./scanners/axe-config.js";
export {
  createPlaywrightPageDriver,
  launchPlaywrightBrowser,
  AXE_SOURCE,
  buildAxeRunArgs,
  injectAxeInPage,
} from "./driver/index.js";
export type {
  PageDriver,
  BrowserDriver,
  BrowserContextDriver,
  AxeRunConfig,
  AxeRunArgs,
  // PageDriver method-option types — needed by anyone implementing a driver.
  ViewportSize,
  Rect,
  ScreenshotOptions,
  GotoOptions,
  WaitForLoadStateOptions,
  WaitUntilLoadState,
  LoadStateWait,
  AddStyleTagOptions,
  EmulateMediaOptions,
  FocusKey,
  NewContextOptions,
  BrowserLaunchOptions,
} from "./driver/index.js";
export {
  runKeyboardTrapChecks,
  KEYBOARD_TRAP_RULE_ID,
  FOCUS_OBSCURED_MIN_RULE_ID,
  FOCUS_OBSCURED_ENHANCED_RULE_ID,
} from "./scanners/keyboard.js";
export { runReflowCheck, REFLOW_RULE_ID } from "./scanners/reflow.js";
export { writeJsonReport } from "./reports/json.js";
export { writeMarkdownReport, renderMarkdown } from "./reports/markdown.js";
export { writeHtmlReport, renderHtml } from "./reports/html.js";
export { buildReportDir, buildReportSlug } from "./reports/output-dir.js";
export { emitReports } from "./reports/emit.js";
export type { EmitReportsResult } from "./reports/emit.js";
export { runFixer } from "./fixer/index.js";
export type { FixOptions, FixOutput } from "./fixer/index.js";
export {
  createLlmProvider,
  getActiveProvider,
  detectProvider,
  BaseLlmProvider,
  BedrockProvider,
  HaipProvider,
  MockProvider,
  BudgetExceededError,
} from "./llm/index.js";
export type {
  LlmProvider,
  LlmProviderType,
  LlmChatRequest,
  LlmChatResponse,
  BaseProviderOptions,
  BedrockProviderOptions,
  HaipProviderOptions,
} from "./llm/index.js";
export type {
  Finding,
  ScanLevel,
  ScanMode,
  ScanPlan,
  ScanState,
  ScanSummary,
  Severity,
  WcagLevel,
  Confidence,
  Source,
  PageEvidence,
  CostEntry,
  FixAction,
  FixResult,
  FixSummary,
  FixCategory,
  FixConfidence,
  PassedRule,
  InapplicableRule,
} from "./types.js";
export {
  WCAG_CATALOG,
  getCriterion,
  severityForSc,
  understandingUrlForSc,
  enrichFindings,
} from "./wcag.js";
