/**
 * Fix orchestrator - coordinates the entire fix workflow.
 */

import { createLlmProvider, type LlmProvider } from "../llm/index.js";
import type {
  Finding,
  FixAction,
  FixResult,
  FixSummary,
  ScanState,
} from "../types.js";
import { applyFixes, groupResultsByCategory } from "./fix-applier.js";
import { generateFixes } from "./fix-agent.js";
import {
  checkGitStatus,
  commitFixes,
  createFixBranch,
  stageFiles,
} from "./git-safety.js";
import { loadReport, partitionFixableFindings } from "./report-loader.js";

export interface FixOptions {
  /** Path to report file or directory */
  reportPath?: string;
  /** Reports directory (default: ./a11y-reports) */
  reportsDir?: string;
  /** Repository root (default: cwd) */
  repoRoot?: string;
  /** Filter by confidence levels */
  confidence?: Array<"high" | "medium" | "low">;
  /** Filter by severity levels */
  severity?: Array<"blocker" | "severe" | "major" | "minor" | "review">;
  /** Filter by rule IDs/categories */
  categories?: string[];
  /** Create new git branch (default: false). Pass true or use --branch flag. */
  createBranch?: boolean;
  /** Branch name prefix (default: a11y-auto-fixes) */
  branchPrefix?: string;
  /** Commit fixes by category (default: false). Pass true or use --commit flag. */
  autoCommit?: boolean;
  /** Max cost in USD (default: 1.0) */
  maxCostUsd?: number;
  /** Dry run - generate but don't apply fixes (default: false) */
  dryRun?: boolean;
  /**
   * If true, run even when the working tree has uncommitted changes inside
   * the fixer's scope. We still log a warning. Useful when a user has
   * intentional in-flight edits to source files the fixer will touch.
   */
  allowDirty?: boolean;
}

export interface FixOutput {
  report: ScanState;
  fixableFindings: Finding[];
  /**
   * Findings the fixer can't handle (rule isn't in SUPPORTED_FIX_CATEGORIES).
   * Surfaced in CLI output so users see why "fixable" < total.
   */
  unsupportedFindings: Finding[];
  /**
   * Fixable findings the LLM returned no action for. Distinct from
   * `results` failures (where an action was produced but the applier
   * rejected it). Lets the CLI tell the user which layer dropped work.
   */
  declinedFindings: Finding[];
  fixes: FixAction[];
  results: FixResult[];
  summary: FixSummary;
  llmProvider: LlmProvider;
}

/**
 * Run the complete fix workflow.
 */
export async function runFixer(opts: FixOptions = {}): Promise<FixOutput> {
  const startTime = Date.now();
  const repoRoot = opts.repoRoot ?? process.cwd();

  // Step 1: Load report (cheap, no side effects). We need the findings to
  // scope the git cleanliness check to files the fixer will actually touch.
  const report = loadReport({
    reportPath: opts.reportPath,
    reportsDir: opts.reportsDir ?? "./a11y-reports",
  });

  console.log(
    `Loaded report: ${report.findings.length} total findings from ${report.plan.target}`,
  );

  // Step 2: Git safety check, scoped to the files the fixer will touch.
  // Changes outside that scope (or in the always-ignored skiplist) are
  // logged but don't block the run. `--allow-dirty` downgrades in-scope
  // dirty paths from blocking error to warning.
  const scopePaths = [
    ...new Set(
      report.findings.map((f) => f.filePath).filter((p): p is string => !!p),
    ),
  ];
  const gitStatus = checkGitStatus(repoRoot, { scopePaths });
  if (!gitStatus.isClean && !opts.dryRun) {
    if (opts.allowDirty) {
      console.warn(
        `Warning: working tree has in-scope uncommitted changes; --allow-dirty set, continuing.\n` +
          gitStatus.uncommittedChanges.map((f) => `  ${f}`).join("\n"),
      );
    } else {
      throw new Error(
        `Git working tree has uncommitted changes to files the fixer will touch.\n` +
          `Commit, stash, or rerun with --allow-dirty.\n` +
          `In-scope changes:\n${gitStatus.uncommittedChanges.map((f) => `  ${f}`).join("\n")}`,
      );
    }
  }

  // Step 3: Partition findings into fixable / unsupported / filtered-out
  const partition = partitionFixableFindings(report.findings, {
    confidence: opts.confidence,
    severity: opts.severity,
    categories: opts.categories,
  });
  const fixableFindings = partition.supported;
  const unsupportedFindings = partition.unsupported;

  const total = report.findings.length;
  if (unsupportedFindings.length > 0) {
    const byRule: Record<string, number> = {};
    for (const f of unsupportedFindings) {
      byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
    }
    const breakdown = Object.entries(byRule)
      .sort((a, b) => b[1] - a[1])
      .map(([rule, count]) => `${rule}: ${count}`)
      .join(", ");
    console.log(
      `Fixable: ${fixableFindings.length} / ${total} (${unsupportedFindings.length} require manual remediation: ${breakdown})`,
    );
  } else {
    console.log(`Fixable: ${fixableFindings.length} / ${total}`);
  }

  if (fixableFindings.length === 0) {
    console.log("No fixable findings. Exiting.");
    return {
      report,
      fixableFindings: [],
      unsupportedFindings,
      declinedFindings: [],
      fixes: [],
      results: [],
      summary: createEmptySummary(),
      llmProvider: createLlmProvider({ maxCostUsd: opts.maxCostUsd }),
    };
  }

  // Step 4: Create branch only if explicitly requested
  if (opts.createBranch === true && !opts.dryRun) {
    const branchName = createFixBranch(
      opts.branchPrefix ?? "a11y-auto-fixes",
      repoRoot,
    );
    console.log(`Created branch: ${branchName}`);
  }

  // Step 5: Initialize LLM provider
  const llm = createLlmProvider({ maxCostUsd: opts.maxCostUsd });
  console.log(
    `Using LLM provider: ${llm.describe().provider} (max cost: $${llm.maxCostUsd})`,
  );

  // Step 6: Generate fixes
  console.log("Generating fixes via LLM...");
  const fixes = await generateFixes(fixableFindings, llm, { repoRoot });
  console.log(`Generated ${fixes.length} fixes`);

  // Findings the LLM returned no action for. Reported separately from
  // applier failures so the user can see which layer is dropping work.
  const fixedIds = new Set(fixes.map((x) => x.findingId));
  const declinedFindings = fixableFindings.filter((f) => !fixedIds.has(f.id));
  if (declinedFindings.length > 0) {
    console.log(`Declined by LLM: ${declinedFindings.length}`);
  }

  if (fixes.length === 0) {
    console.log("No fixes generated. Exiting.");
    return {
      report,
      fixableFindings,
      unsupportedFindings,
      declinedFindings,
      fixes: [],
      results: [],
      summary: buildSummary(
        fixableFindings.length,
        [],
        declinedFindings.length,
        llm.totalCost,
        Date.now() - startTime,
      ),
      llmProvider: llm,
    };
  }

  // Step 7: Apply fixes
  let results: FixResult[] = [];
  if (opts.dryRun) {
    console.log("DRY RUN: Skipping application of fixes");
    results = fixes.map((action) => ({ action, applied: false }));
  } else {
    console.log("Applying fixes...");
    results = applyFixes(fixes, repoRoot);
  }

  const applied = results.filter((r) => r.applied);
  const failed = results.filter((r) => !r.applied);

  console.log(`Applied: ${applied.length}, Failed: ${failed.length}`);

  // Step 8: Stage (and optionally commit) applied fixes
  if (applied.length > 0 && !opts.dryRun) {
    if (opts.autoCommit === true) {
      // Commit by category (opt-in behavior)
      console.log("Creating commits...");
      const groups = groupResultsByCategory(applied);

      for (const [category, categoryResults] of groups.entries()) {
        const files = [
          ...new Set(categoryResults.map((r) => r.action.filePath)),
        ];
        stageFiles(files, repoRoot);

        const count = categoryResults.length;
        const message = `fix(a11y): Auto-fix ${count} ${category} issue${count > 1 ? "s" : ""}

Generated by a11y-scout auto-fixer.

Co-Authored-By: a11y-scout <noreply@a11y-scout.dev>`;

        commitFixes(message, repoRoot);
        console.log(
          `  Committed ${count} ${category} fix${count > 1 ? "es" : ""}`,
        );
      }
    } else {
      // Stage only (new default behavior)
      const allFixedFiles = [...new Set(applied.map((r) => r.action.filePath))];
      stageFiles(allFixedFiles, repoRoot);
      console.log(`Staged ${allFixedFiles.length} file(s)`);
    }
  }

  // Step 9: Summary
  const durationMs = Date.now() - startTime;
  const summary = buildSummary(
    fixableFindings.length,
    results,
    declinedFindings.length,
    llm.totalCost,
    durationMs,
  );

  return {
    report,
    fixableFindings,
    unsupportedFindings,
    declinedFindings,
    fixes,
    results,
    summary,
    llmProvider: llm,
  };
}

function createEmptySummary(): FixSummary {
  return {
    totalFindings: 0,
    fixesAttempted: 0,
    fixesApplied: 0,
    fixesFailed: 0,
    fixesDeclined: 0,
    byCategory: {},
    byConfidence: {},
    costUsd: 0,
    durationMs: 0,
  };
}

function buildSummary(
  totalFindings: number,
  results: FixResult[],
  declinedCount: number,
  costUsd: number,
  durationMs: number,
): FixSummary {
  const applied = results.filter((r) => r.applied);
  const failed = results.filter((r) => !r.applied);

  const byCategory: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};

  for (const result of applied) {
    const cat = result.action.category;
    const conf = result.action.confidence;
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    byConfidence[conf] = (byConfidence[conf] ?? 0) + 1;
  }

  return {
    totalFindings,
    fixesAttempted: results.length,
    fixesApplied: applied.length,
    fixesFailed: failed.length,
    fixesDeclined: declinedCount,
    byCategory,
    byConfidence,
    costUsd,
    durationMs,
  };
}
