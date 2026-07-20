/**
 * Auto-fixer module for applying LLM-generated accessibility fixes.
 */

export { runFixer, type FixOptions, type FixOutput } from "./orchestrator.js";
export { loadReport, filterFixableFindings } from "./report-loader.js";
export type { ReportLoadOptions } from "./report-loader.js";
export { generateFixes } from "./fix-agent.js";
export { applyFix, applyFixes, groupResultsByCategory } from "./fix-applier.js";
export {
  checkGitStatus,
  createFixBranch,
  stageFiles,
  commitFixes,
} from "./git-safety.js";
export type { GitStatus } from "./git-safety.js";
