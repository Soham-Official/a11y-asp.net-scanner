/**
 * Load and parse accessibility reports for fixing.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { ScanStateSchema, type Finding, type ScanState } from "../types.js";
import { isFixable } from "./categories.js";

export interface ReportLoadOptions {
  /** Path to specific report file, or directory to auto-detect latest */
  reportPath?: string;
  /** Default reports directory */
  reportsDir?: string;
}

/**
 * Load the latest or specified report file.
 */
export function loadReport(opts: ReportLoadOptions = {}): ScanState {
  const reportsDir = opts.reportsDir ?? "./a11y-reports";
  let reportPath: string;

  if (opts.reportPath) {
    // Explicit path provided
    reportPath = resolve(opts.reportPath);
    if (!existsSync(reportPath)) {
      throw new Error(`Report file not found: ${reportPath}`);
    }
  } else {
    // Auto-detect latest report
    reportPath = findLatestReport(reportsDir);
  }

  const content = readFileSync(reportPath, "utf-8");
  const ext = extname(reportPath);

  let data: unknown;
  if (ext === ".json") {
    data = JSON.parse(content);
  } else {
    throw new Error(
      `Unsupported report format: ${ext}. Only JSON reports are supported for fixing.`,
    );
  }

  // Validate with Zod schema
  const result = ScanStateSchema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `Invalid report format: ${result.error.errors.map((e) => e.message).join(", ")}`,
    );
  }

  return result.data;
}

/**
 * Find the most recent JSON report in the reports directory.
 *
 * Resolution order:
 *   1. `<reportsDir>/latest/report.json`  (written by every successful scan)
 *   2. Newest `<reportsDir>/<run-id>/report.json` by mtime
 *   3. Newest `<reportsDir>/*.json` (legacy flat layout)
 */
function findLatestReport(reportsDir: string): string {
  if (!existsSync(reportsDir)) {
    throw new Error(
      `Reports directory not found: ${reportsDir}. Run a scan first with scan-url or scan-repo.`,
    );
  }

  const latestPointer = join(reportsDir, "latest", "report.json");
  if (existsSync(latestPointer)) {
    return latestPointer;
  }

  const candidates: Array<{ path: string; mtime: number }> = [];

  for (const entry of readdirSync(reportsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Each scan writes its outputs into a timestamped subdirectory whose
      // canonical filename is `report.json`.
      const candidate = join(reportsDir, entry.name, "report.json");
      if (existsSync(candidate)) {
        candidates.push({
          path: candidate,
          mtime: statSync(candidate).mtime.getTime(),
        });
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      const candidate = join(reportsDir, entry.name);
      candidates.push({
        path: candidate,
        mtime: statSync(candidate).mtime.getTime(),
      });
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime);

  if (candidates.length === 0) {
    throw new Error(
      `No JSON reports found in ${reportsDir}. Run a scan first with scan-url or scan-repo.`,
    );
  }

  return candidates[0]!.path;
}

export interface PartitionedFindings {
  /** Findings the Phase-1 fixer can actually resolve. */
  supported: Finding[];
  /**
   * Findings excluded because their rule isn't in SUPPORTED_FIX_CATEGORIES
   * (require manual remediation). Counts here are surfaced in the CLI so
   * users understand why "fixable" is smaller than the report total.
   */
  unsupported: Finding[];
  /**
   * Findings excluded by user-supplied filters (--confidence, --severity,
   * --categories). Kept separate from `unsupported` because these are an
   * explicit user choice, not a tooling limitation.
   */
  filteredOut: Finding[];
}

/**
 * Partition findings into what the fixer will attempt vs. what it must
 * skip. User filters apply before the supported-category check so explicit
 * `--categories alt-text` doesn't silently fall back to the full set.
 */
export function partitionFixableFindings(
  findings: Finding[],
  opts: {
    confidence?: Array<"high" | "medium" | "low">;
    severity?: Array<"blocker" | "severe" | "major" | "minor" | "review">;
    categories?: string[];
  } = {},
): PartitionedFindings {
  const supported: Finding[] = [];
  const unsupported: Finding[] = [];
  const filteredOut: Finding[] = [];

  for (const f of findings) {
    if (!f.filePath) {
      // Runtime-only findings are never fixable in repo mode.
      filteredOut.push(f);
      continue;
    }
    if (
      opts.confidence &&
      opts.confidence.length > 0 &&
      (!f.confidence || !opts.confidence.includes(f.confidence))
    ) {
      filteredOut.push(f);
      continue;
    }
    if (
      opts.severity &&
      opts.severity.length > 0 &&
      !opts.severity.includes(f.severity)
    ) {
      filteredOut.push(f);
      continue;
    }
    if (
      opts.categories &&
      opts.categories.length > 0 &&
      !opts.categories.includes(f.ruleId)
    ) {
      filteredOut.push(f);
      continue;
    }
    if (isFixable(f)) {
      supported.push(f);
    } else {
      unsupported.push(f);
    }
  }

  return { supported, unsupported, filteredOut };
}

/**
 * @deprecated Use partitionFixableFindings to also surface the unsupported
 * count in user-facing output. Kept for any external callers.
 */
export function filterFixableFindings(
  findings: Finding[],
  opts: {
    confidence?: Array<"high" | "medium" | "low">;
    severity?: Array<"blocker" | "severe" | "major" | "minor" | "review">;
    categories?: string[];
  } = {},
): Finding[] {
  return partitionFixableFindings(findings, opts).supported;
}
