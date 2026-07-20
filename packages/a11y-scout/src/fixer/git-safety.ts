/**
 * Git safety checks before applying fixes.
 */

import { execSync } from "node:child_process";
import { basename } from "node:path";

export interface GitStatus {
  isClean: boolean;
  branch: string;
  /** Working-tree changes inside the requested scope (or repo-wide). */
  uncommittedChanges: string[];
  /**
   * Changes outside the fixer's scope (or matching the always-ignored
   * skiplist). Returned for transparency, never blocks the fixer.
   */
  ignoredChanges: string[];
}

/**
 * Files that routinely show up dirty during normal a11y-scout use and
 * never overlap with the fixer's targets:
 *   - `.env*`         — local config the user just created
 *   - lockfiles       — touched by `npm install <a11y-scout>` itself
 * Treating them as in-scope makes the fixer impossible to run on a fresh
 * install, so they are always excluded from the cleanliness check.
 */
const ALWAYS_IGNORED_PATTERNS = [
  /^\.env(\..+)?$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
];

function isAlwaysIgnored(path: string): boolean {
  const name = basename(path);
  return ALWAYS_IGNORED_PATTERNS.some((rx) => rx.test(name));
}

export interface GitStatusOptions {
  /**
   * If provided, the cleanliness check ignores any change outside this set.
   * Each entry is a relative path (file or directory). Used to scope the
   * check to files the fixer will actually modify.
   */
  scopePaths?: string[];
}

/**
 * Check git working tree status. Honors a scope (so fix-repo only blocks on
 * dirty files it intends to touch) and an always-ignored skiplist (so a
 * pristine `.env` or lockfile churn from `npm install` never blocks a run).
 */
export function checkGitStatus(
  cwd: string = process.cwd(),
  opts: GitStatusOptions = {},
): GitStatus {
  try {
    execSync("git rev-parse --git-dir", { cwd, stdio: "pipe" });
  } catch {
    throw new Error(
      "Not a git repository. The fixer requires git for safety tracking.",
    );
  }

  const branch = execSync("git rev-parse --abbrev-ref HEAD", {
    cwd,
    encoding: "utf-8",
  }).trim();

  const statusOutput = execSync("git status --porcelain", {
    cwd,
    encoding: "utf-8",
  });

  const inScope: string[] = [];
  const ignored: string[] = [];

  for (const line of statusOutput.split("\n")) {
    if (line.trim().length === 0) continue;
    const path = parsePorcelainPath(line);
    if (!path) continue;
    if (isAlwaysIgnored(path)) {
      ignored.push(line);
      continue;
    }
    if (opts.scopePaths && opts.scopePaths.length > 0) {
      if (!isInScope(path, opts.scopePaths)) {
        ignored.push(line);
        continue;
      }
    }
    inScope.push(line);
  }

  return {
    isClean: inScope.length === 0,
    branch,
    uncommittedChanges: inScope,
    ignoredChanges: ignored,
  };
}

function parsePorcelainPath(line: string): string | null {
  // `git status --porcelain` lines are `XY <path>` where XY are status
  // codes; rename lines are `R  old -> new` and we want `new`.
  const trimmed = line.slice(3);
  if (!trimmed) return null;
  const arrow = trimmed.indexOf(" -> ");
  return arrow >= 0 ? trimmed.slice(arrow + 4) : trimmed;
}

function isInScope(path: string, scopePaths: string[]): boolean {
  return scopePaths.some(
    (s) => path === s || path.startsWith(`${s}/`) || s.startsWith(`${path}/`),
  );
}

/**
 * Create a new feature branch for fixes.
 */
export function createFixBranch(
  baseName: string = "a11y-auto-fixes",
  cwd: string = process.cwd(),
): string {
  const timestamp = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const branchName = `${baseName}-${timestamp}`;

  try {
    execSync(`git checkout -b ${branchName}`, { cwd, stdio: "pipe" });
    return branchName;
  } catch (error) {
    throw new Error(
      `Failed to create branch ${branchName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Stage files for commit.
 */
export function stageFiles(
  files: string[],
  cwd: string = process.cwd(),
): void {
  if (files.length === 0) return;

  try {
    const fileList = files.map((f) => `"${f}"`).join(" ");
    execSync(`git add ${fileList}`, { cwd });
  } catch (error) {
    throw new Error(
      `Failed to stage files: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Create a commit for fixes.
 */
export function commitFixes(
  message: string,
  cwd: string = process.cwd(),
): void {
  try {
    execSync(`git commit -m "${message}"`, { cwd });
  } catch (error) {
    throw new Error(
      `Failed to commit: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
