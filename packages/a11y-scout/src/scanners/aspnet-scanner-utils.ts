/**
 * Shared types, constants, and utility functions used across all ASP.NET
 * static scanner rule files (css-rules, js-rules, codebehind-rules,
 * template-rules). Extracted from static.ts to keep each concern in one place.
 */
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

// ─── Shared internal types ────────────────────────────────────────────────────

export interface AspxScanIssue {
  ruleId: string;
  title: string;
  description: string;
  wcagSc: string;
  filePath: string;
  line: number;
  column: number;
  htmlSnippet: string;
}

export interface A11yScopeConfig {
  public?: string[];
  admin?: string[];
  internal?: string[];
  tiers?: {
    public?: string[];
    admin?: string[];
    internal?: string[];
  };
}

export interface RoslynScanIssue {
  RuleId: string;
  Title: string;
  Description: string;
  WcagSc: string;
  FilePath: string;
  Line: number;
  Column: number;
  HtmlSnippet: string;
}

export interface RoslynScanResultShape {
  FilesScanned: number;
  ScannedFiles: string[];
  Issues: RoslynScanIssue[];
}

export interface CreateElementFlowState {
  insertedIntoDom: boolean;
  hasAltText: boolean;
  hasAccessibleName: boolean;
  hasAssociatedLabelByFor: boolean;
  isAriaHidden: boolean;
  inferredInputType?: string;
  idValues: Set<string>;
}

// ─── Public progress event types (re-exported from static.ts) ─────────────────

export type StaticScanPhase =
  | "detect-stack"
  | "aspnet:js-a11y"
  | "aspnet:template-files"
  | "aspnet:html-lint"
  | "aspnet:dom-injection"
  | "aspnet:css-patterns"
  | "aspnet:code-behind"
  | "react:eslint"
  | "angular:eslint";

export interface StaticScanProgressEvent {
  phase: StaticScanPhase;
  state: "start" | "done" | "failed" | "progress" | "skipped";
  totalFiles?: number;
  processedFiles?: number;
  currentPath?: string;
  durationMs?: number;
  message?: string;
}

// ─── Shared constants ─────────────────────────────────────────────────────────

export const SCANNER_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".angular",
  ".cache",
  ".vs",
  "obj",
  "bin",
  "coverage",
  "artifacts",
  "generated",
  "out",
  "target",
  "tmp",
  "temp",
]);

export const SCANNER_SKIP_FILE_PATTERNS: RegExp[] = [
  /\.(?:min|bundle)\.(?:js|css)$/i,
  /-bundle\.js$/i,
  /jquery(?:-[\d.]+)?(?:\.min)?\.js$/i,
  /jquery-ui(?:-[\d.]+)?(?:\.min)?\.js$/i,
  /spectrum(?:\.min)?\.js$/i,
  /colorpicker(?:\.min)?\.js$/i,
  /\.g\.cs$/i,
  /\.designer\.cs$/i,
  /AssemblyInfo\.cs$/i,
  /\.generated\.[a-z0-9]+$/i,
  // Build/tool config scripts — not app UI code, and often huge bundled files
  /^rollup\.config\./i,
  /^webpack\.config\./i,
  /^vite\.config\./i,
  /^gulpfile\./i,
  /^gruntfile\./i,
  /^babel\.config\./i,
  /^jest\.config\./i,
  /^karma\.config\./i,
  /^postcss\.config\./i,
  // Known large bundled/generated runtime files in this codebase
  /^live\.js$/i,
  /^OnBaseAppsMessenger\.js$/i,
  /^BrowserFeatureTest\.js$/i,
  /^NewForm\.js$/i,
];

export const SCANNER_SKIP_PATH_PATTERNS: RegExp[] = [
  /\/Scripts\/jQuery\//i,
  /\/Scripts\/jQueryUI\//i,
  /\/Scripts\/ColorPicker\//i,
  /\/Scripts\/spectrum(?:\.min)?\.js$/i,
  /\/Scripts\/GIS\/gis-bundle(?:\.[^/]+)?$/i,
  /\/DataChart\/DataChart\.js$/i,
  /\/Scripts\/DataChart\//i,
  // Vendor-owned viewer stylesheets — font/sizing choices are not ours.
  /\/Styles\/GIS\//i,
  /\/ReportingDashboards\/Styles\//i,
];

export const PER_FILE_RULE_LIMITS: Record<string, number> = {
  "aspnet/svg-focusable-false-no-aria-hidden": 8,
  "aspnet/css-outline-none": 10,
  "aspnet/css-pointer-events-none": 10,
  "aspnet/disabled-on-non-form-element": 10,
  "aspnet/anchor-has-content": 20,
  "aspnet/button-has-content": 20,
};

// ─── Shared utility functions ─────────────────────────────────────────────────

export function stripTagsAndServerBlocks(value: string): string {
  return value
    .replace(/<%[\s\S]*?%>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .trim();
}

export function hasServerExpressionContent(value: string): boolean {
  return /<%[\s\S]*?%>/.test(value);
}

export function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/");
}

export function getAppOwnedJsAllowlistPatterns(): RegExp[] {
  const raw = process.env.A11Y_APP_OWNED_JS_PATHS?.trim() ?? "";
  if (!raw) return [];

  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      try {
        return [new RegExp(part, "i")];
      } catch {
        return [];
      }
    });
}

export function shouldSkipScannerDirectory(dirName: string): boolean {
  if (SCANNER_SKIP_DIRS.has(dirName)) return true;
  if (dirName.startsWith("~")) return true;
  if (dirName.endsWith("~")) return true;
  return false;
}

export function shouldSkipStaticFile(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  const normalizedWithRoot = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const segments = normalized.split("/").filter(Boolean);

  for (const segment of segments.slice(0, -1)) {
    if (shouldSkipScannerDirectory(segment)) {
      return true;
    }
  }

  const fileName = segments[segments.length - 1] ?? normalized;
  if (fileName.startsWith("~")) return true;

  if (SCANNER_SKIP_PATH_PATTERNS.some((pattern) => pattern.test(normalizedWithRoot))) {
    return true;
  }

  const isJsFile = /\.(?:js|jsx|ts|tsx)$/i.test(fileName);
  if (isJsFile) {
    const allowlist = getAppOwnedJsAllowlistPatterns();
    if (allowlist.length > 0 && !allowlist.some((pattern) => pattern.test(normalized))) {
      return true;
    }
  }

  return SCANNER_SKIP_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getLineColumn(content: string, index: number): { line: number; column: number } {
  const before = content.slice(0, index);
  const lines = before.split("\n");
  const line = lines.length;
  const lastLine = lines[lines.length - 1] ?? "";
  return { line, column: lastLine.length + 1 };
}

export function logStaticPhaseWorkload(phaseName: string, total: number): void {
  console.error(`[static-scanner] ${phaseName} files=${total}`);
}

export function logStaticPhaseProgress(
  phaseName: string,
  processed: number,
  total: number,
  currentPath: string,
  onProgress?: (event: StaticScanProgressEvent) => void,
): void {
  onProgress?.({
    phase: phaseName as StaticScanPhase,
    state: "progress",
    processedFiles: processed,
    totalFiles: total,
    currentPath,
  });

  if (processed === 1 || processed === total || processed % 25 === 0) {
    console.error(
      `[static-scanner] ${phaseName} progress ${processed}/${total} ${currentPath}`,
    );
  }
}

export async function listFilesWithExtensions(
  repoPath: string,
  extensions: string[],
): Promise<string[]> {
  const queue = [repoPath];
  const found: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!shouldSkipScannerDirectory(entry.name)) {
          queue.push(join(current, entry.name));
        }
        continue;
      }

      const lowered = entry.name.toLowerCase();
      if (extensions.some((ext) => lowered.endsWith(ext))) {
        const absPath = join(current, entry.name);
        const relPath = normalizePath(relative(repoPath, absPath));
        if (shouldSkipStaticFile(relPath)) {
          continue;
        }
        found.push(absPath);
      }
    }
  }

  return found;
}
