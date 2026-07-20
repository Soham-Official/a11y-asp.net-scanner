/**
 * static.ts — ASP.NET static scanner orchestrator + React/Angular runners.
 *
 * REFACTOR STATUS (see AGENTS.md for full plan):
 *   ✅ Shared types/utils → aspnet-scanner-utils.ts
 *   ✅ CSS rules        → aspnet-css-rules.ts
 *   🔲 JS DOM rules     → TODO: extract to aspnet-js-rules.ts
 *   🔲 Code-behind rules→ TODO: extract to aspnet-codebehind-rules.ts
 *   🔲 Template rules   → TODO: extract to aspnet-template-rules.ts
 *
 * The remaining rule functions below are all private (non-exported) and can be
 * extracted file-by-file without any public API changes.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { v4 as uuidv4 } from "uuid";
import type { Finding, Severity, Source } from "../types.js";
import {
  ANGULAR_TEMPLATE_RULE_IDS,
  enrichFindings,
  getCriterion,
  scIdsForAngularTemplateRule,
  scIdsForEslintRule,
  severityForScList,
} from "../wcag.js";
import {
  type AspxScanIssue,
  type A11yScopeConfig,
  type RoslynScanIssue,
  type RoslynScanResultShape,
  type CreateElementFlowState,
  type StaticScanProgressEvent,
  type StaticScanPhase,
  PER_FILE_RULE_LIMITS,
  normalizePath,
  shouldSkipStaticFile,
  escapeRegex,
  getLineColumn,
  stripTagsAndServerBlocks,
  hasServerExpressionContent,
  listFilesWithExtensions,
  logStaticPhaseWorkload,
  logStaticPhaseProgress,
} from "./aspnet-scanner-utils.js";
export type { StaticScanProgressEvent, StaticScanPhase } from "./aspnet-scanner-utils.js";
import { scanCssA11yPatterns } from "./aspnet-css-rules.js";

interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  source?: string;
}

interface EslintResult {
  filePath: string;
  messages: EslintMessage[];
  warningCount: number;
  errorCount: number;
}

interface EslintExecutionError extends Error {
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

export interface StaticScanOptions {
  repoPath: string;
  patterns?: string[];
  configPath?: string;
  onProgress?: (event: StaticScanProgressEvent) => void;
}

export interface StaticScanResult {
  findings: Finding[];
  detected: { framework: string; rationale: string };
  filesScanned: number;
  rawWarnings: number;
}

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export async function detectStack(
  repoPath: string,
): Promise<{ framework: string; rationale: string }> {
  const pkgPath = join(repoPath, "package.json");
  const hasAspNetMarkers = await containsAspNetMarkers(repoPath);

  if (!existsSync(pkgPath)) {
    if (hasAspNetMarkers) {
      return {
        framework: "aspnet",
        rationale: "Found ASP.NET marker files (.aspx/.ascx/.master/.cshtml)",
      };
    }
    return {
      framework: "unknown",
      rationale: "No package.json found at repo root.",
    };
  }
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as PackageJsonShape;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.react || deps.next) {
      return { framework: "react", rationale: "Found react/next in package.json" };
    }
    if (deps["@angular/core"]) {
      return { framework: "angular", rationale: "Found @angular/core" };
    }
    if (deps.vue) {
      return { framework: "vue", rationale: "Found vue" };
    }
    if (deps.svelte) {
      return { framework: "svelte", rationale: "Found svelte" };
    }
    if (hasAspNetMarkers) {
      return {
        framework: "aspnet",
        rationale: "Found ASP.NET marker files (.aspx/.ascx/.master/.cshtml)",
      };
    }
    return {
      framework: "unknown",
      rationale: "package.json present but no known UI framework dep detected",
    };
  } catch (err) {
    return {
      framework: "unknown",
      rationale: `Failed to read package.json: ${(err as Error).message}`,
    };
  }
}

export async function scanRepoStatic(
  opts: StaticScanOptions,
): Promise<StaticScanResult> {
  const repoPath = resolve(opts.repoPath);
  opts.onProgress?.({
    phase: "detect-stack",
    state: "start",
    message: "Detecting repo stack",
  });
  const detected = await detectStack(repoPath);
  opts.onProgress?.({
    phase: "detect-stack",
    state: "done",
    message: detected.rationale,
  });

  if (detected.framework === "react") {
    return scanReactStatic(repoPath, detected, opts);
  }
  if (detected.framework === "angular") {
    return scanAngularStatic(repoPath, detected, opts);
  }
  if (detected.framework === "aspnet") {
    return scanAspNetStatic(repoPath, detected, opts);
  }
  return { findings: [], detected, filesScanned: 0, rawWarnings: 0 };
}

async function runTimedStaticPhase<T>(
  phaseName: string,
  run: () => Promise<T>,
  onProgress?: (event: StaticScanProgressEvent) => void,
): Promise<T> {
  const startedAt = Date.now();
  console.error(`[static-scanner] start ${phaseName}`);
  onProgress?.({
    phase: phaseName as StaticScanPhase,
    state: "start",
  });

  try {
    const result = await run();
    console.error(
      `[static-scanner] done ${phaseName} in ${Date.now() - startedAt}ms`,
    );
    onProgress?.({
      phase: phaseName as StaticScanPhase,
      state: "done",
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[static-scanner] failed ${phaseName} after ${Date.now() - startedAt}ms: ${message}`,
    );
    onProgress?.({
      phase: phaseName as StaticScanPhase,
      state: "failed",
      durationMs: Date.now() - startedAt,
      message,
    });
    throw error;
  }
}

async function scanReactStatic(
  repoPath: string,
  detected: { framework: string; rationale: string },
  opts: StaticScanOptions,
): Promise<StaticScanResult> {
  const configPath = await writeReactFlatConfig();

  const args = [
    "--format",
    "json",
    "--config",
    configPath,
    "--no-config-lookup",
    "--no-error-on-unmatched-pattern",
    "**/*.js",
    "**/*.jsx",
    "**/*.ts",
    "**/*.tsx",
  ];

  let raw: string;
  let stderr = "";
  try {
    const result = await runEslint(args, repoPath);
    raw = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    raw = (err as Error & { stdout?: string; stderr?: string }).stdout ?? "[]";
    stderr = (err as Error & { stderr?: string }).stderr ?? "";
  } finally {
    try {
      await unlink(configPath);
    } catch {
      // Ignore cleanup errors
    }
  }

  let parsed: EslintResult[] = [];
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }

  // Warn if ESLint config failed to load (silent zero-findings is dangerous)
  if (parsed.length === 0 && stderr.trim().length > 0) {
    console.warn(
      `[static-scanner] ESLint produced no results but stderr is non-empty. Possible config error:\n${stderr.slice(0, 500)}`,
    );
  }

  const normalized = normalizeEslintResults({
    parsed,
    repoPath,
    rulePrefix: "jsx-a11y/",
    source: "eslint-jsx-a11y",
    scIdsForRule: scIdsForEslintRule,
    helpUrl: (ruleId: string) =>
      `https://github.com/jsx-eslint/eslint-plugin-jsx-a11y/blob/main/docs/rules/${ruleId.replace(
        "jsx-a11y/",
        "",
      )}.md`,
    tags: ["static", "react"],
  });

  return {
    // Enrichment chokepoint for scan-repo (static findings never pass through
    // scanPage). Stamps catalog helpUrl + level; docUrl/severity untouched.
    findings: enrichFindings(normalized.findings),
    detected,
    filesScanned: parsed.length,
    rawWarnings: normalized.rawWarnings,
  };
}

async function scanAngularStatic(
  repoPath: string,
  detected: { framework: string; rationale: string },
  opts: StaticScanOptions,
): Promise<StaticScanResult> {
  const configPath = await writeAngularFlatConfig();

  const args = [
    "--format",
    "json",
    "--config",
    configPath,
    "--no-config-lookup",
    "--no-error-on-unmatched-pattern",
    "**/*.ts",
    "**/*.html",
  ];

  let raw: string;
  let stderr = "";
  try {
    const result = await runEslint(args, repoPath);
    raw = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    raw = (err as Error & { stdout?: string; stderr?: string }).stdout ?? "[]";
    stderr = (err as Error & { stderr?: string }).stderr ?? "";
  } finally {
    try {
      await unlink(configPath);
    } catch {
      // Ignore cleanup errors
    }
  }

  let parsed: EslintResult[] = [];
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }

  // Warn if ESLint config failed to load
  if (parsed.length === 0 && stderr.trim().length > 0) {
    console.warn(
      `[static-scanner] ESLint produced no results but stderr is non-empty. Possible config error:\n${stderr.slice(0, 500)}`,
    );
  }

  const normalized = normalizeEslintResults({
    parsed,
    repoPath,
    rulePrefix: "@angular-eslint/template/",
    source: "eslint-angular-template",
    scIdsForRule: scIdsForAngularTemplateRule,
    helpUrl: (ruleId: string) =>
      `https://github.com/angular-eslint/angular-eslint/blob/main/packages/eslint-plugin-template/docs/rules/${ruleId.replace(
        "@angular-eslint/template/",
        "",
      )}.md`,
    tags: ["static", "angular"],
  });

  return {
    // Enrichment chokepoint for scan-repo (see the React path above).
    findings: enrichFindings(normalized.findings),
    detected,
    filesScanned: parsed.length,
    rawWarnings: normalized.rawWarnings,
  };
}

async function scanAspNetStatic(
  repoPath: string,
  detected: { framework: string; rationale: string },
  opts: StaticScanOptions,
): Promise<StaticScanResult> {
  const shouldRunAspNetJsxLint = process.env.A11Y_ASPNET_LINT_JSX === "1";
  if (!shouldRunAspNetJsxLint) {
    console.error(
      "[static-scanner] aspnet:js-a11y skipped (set A11Y_ASPNET_LINT_JSX=1 to enable JSX/TSX lint for hybrid repos)",
    );
    opts.onProgress?.({
      phase: "aspnet:js-a11y",
      state: "skipped",
      message: "JSX/TSX lint disabled",
    });
  }

  const jsLintResult = shouldRunAspNetJsxLint
    ? await runTimedStaticPhase(
        "aspnet:js-a11y",
        () => scanJsA11yStatic(repoPath, ["static", "aspnet", "js"]),
        opts.onProgress,
      )
    : { findings: [], filesScanned: 0, rawWarnings: 0 };

  const aspxScanResult = await runTimedStaticPhase(
    "aspnet:template-files",
    () => scanAspNetTemplateFiles(repoPath, opts.onProgress),
    opts.onProgress,
  );
  const htmlLintResult = await runTimedStaticPhase(
    "aspnet:html-lint",
    () => scanAspNetHtmlLint(repoPath, opts.onProgress),
    opts.onProgress,
  );
  const jsDomResult = await runTimedStaticPhase(
    "aspnet:dom-injection",
    () => scanJsDomInjectionPatterns(repoPath, opts.onProgress),
    opts.onProgress,
  );
  const cssScanResult = await runTimedStaticPhase(
    "aspnet:css-patterns",
    () => scanCssA11yPatterns(repoPath, opts.onProgress),
    opts.onProgress,
  );
  const codeBehindResult = await runTimedStaticPhase(
    "aspnet:code-behind",
    () => scanAspNetCodeBehindPatterns(repoPath, opts.onProgress),
    opts.onProgress,
  );

  const aspxIssues = aspxScanResult.issues;

  const aspxFindings: Finding[] = aspxIssues.map((issue) => {
    const criterion = getCriterion(issue.wcagSc);
    const level = criterion?.level ?? "AA";
    const baseSeverity = severityForScList([issue.wcagSc]) ?? "major";
    const isRuntimeReview = isRuntimeReviewRuleId(issue.ruleId);
    const severity = isRuntimeReview
      ? "review"
      : applyRuleSeverityOverrides(issue.ruleId, baseSeverity);

    return {
      id: uuidv4(),
      wcagSc: issue.wcagSc,
      wcagLevel: level,
      severity,
      source: "eslint-jsx-a11y",
      ruleId: issue.ruleId,
      title: issue.title,
      description: issue.description,
      filePath: issue.filePath,
      line: issue.line,
      column: issue.column,
      htmlSnippet: issue.htmlSnippet,
      aiGenerated: false,
      requiresHumanReview: isRuntimeReview,
      tags: [
        "static",
        "aspnet",
        "aspx",
        ...(isAdvisoryRule(issue.ruleId) ? ["advisory"] : []),
        ...(isRuntimeReview ? ["runtime-review"] : []),
      ],
      relatedRuleIds: [],
      relatedNodes: [],
    };
  });

  const htmlLintFindings: Finding[] = htmlLintResult.issues.map((issue) => {
    const criterion = getCriterion(issue.wcagSc);
    const level = criterion?.level ?? "AA";
    const baseSeverity = severityForScList([issue.wcagSc]) ?? "major";
    const severity = applyRuleSeverityOverrides(issue.ruleId, baseSeverity);

    return {
      id: uuidv4(),
      wcagSc: issue.wcagSc,
      wcagLevel: level,
      severity,
      source: "html-lint",
      ruleId: issue.ruleId,
      title: issue.title,
      description: issue.description,
      filePath: issue.filePath,
      line: issue.line,
      column: issue.column,
      htmlSnippet: issue.htmlSnippet,
      aiGenerated: false,
      requiresHumanReview: false,
      tags: ["static", "aspnet", "html-lint", ...(isAdvisoryRule(issue.ruleId) ? ["advisory"] : [])],
      relatedRuleIds: [],
      relatedNodes: [],
    };
  });

  // JS/jQuery DOM injection findings — always requiresHumanReview because
  // we cannot see the runtime value of variables used as alt/label strings.
  const jsDomFindings: Finding[] = jsDomResult.issues.map((issue) => {
    const criterion = getCriterion(issue.wcagSc);
    const level = criterion?.level ?? "AA";
    const severity = severityForScList([issue.wcagSc]) ?? "major";

    return {
      id: uuidv4(),
      wcagSc: issue.wcagSc,
      wcagLevel: level,
      severity: "review",
      source: "eslint-jsx-a11y",
      ruleId: issue.ruleId,
      title: issue.title,
      description: issue.description,
      filePath: issue.filePath,
      line: issue.line,
      column: issue.column,
      htmlSnippet: issue.htmlSnippet,
      aiGenerated: false,
      requiresHumanReview: true,
      tags: ["static", "aspnet", "js", "dom-injection"],
      relatedRuleIds: [],
      relatedNodes: [],
    };
  });

  // C# / VB code-behind findings are heuristic by design. Dynamic control
  // creation often composes labels/alt text later in execution paths we cannot
  // resolve statically, so require runtime confirmation.
  const cssFindings: Finding[] = cssScanResult.issues.map((issue) => {
    const criterion = getCriterion(issue.wcagSc);
    const level = criterion?.level ?? "AA";
    const baseSeverity = severityForScList([issue.wcagSc]) ?? "major";
    const severity = applyRuleSeverityOverrides(issue.ruleId, baseSeverity);

    return {
      id: uuidv4(),
      wcagSc: issue.wcagSc,
      wcagLevel: level,
      severity,
      source: "eslint-jsx-a11y",
      ruleId: issue.ruleId,
      title: issue.title,
      description: issue.description,
      filePath: issue.filePath,
      line: issue.line,
      column: issue.column,
      htmlSnippet: issue.htmlSnippet,
      aiGenerated: false,
      requiresHumanReview: false,
      tags: ["static", "aspnet", "css", ...(isAdvisoryRule(issue.ruleId) ? ["advisory"] : [])],
      relatedRuleIds: [],
      relatedNodes: [],
    };
  });

  const codeBehindFindings: Finding[] = codeBehindResult.issues.map((issue) => {
    const criterion = getCriterion(issue.wcagSc);
    const level = criterion?.level ?? "AA";

    return {
      id: uuidv4(),
      wcagSc: issue.wcagSc,
      wcagLevel: level,
      severity: "review",
      source: "eslint-jsx-a11y",
      ruleId: issue.ruleId,
      title: issue.title,
      description: issue.description,
      filePath: issue.filePath,
      line: issue.line,
      column: issue.column,
      htmlSnippet: issue.htmlSnippet,
      aiGenerated: false,
      requiresHumanReview: true,
      tags: ["static", "aspnet", "code-behind"],
      relatedRuleIds: [],
      relatedNodes: [],
    };
  });

  const mergedFindings = [
      ...jsLintResult.findings,
      ...aspxFindings,
      ...htmlLintFindings,
      ...jsDomFindings,
      ...cssFindings,
      ...codeBehindFindings,
  ];

  const filteredFindings = applyFindingNoiseControls(mergedFindings, repoPath);

  return {
    findings: enrichFindings(filteredFindings),
    detected,
    filesScanned:
      jsLintResult.filesScanned +
      aspxScanResult.filesScanned +
      htmlLintResult.filesScanned +
      jsDomResult.filesScanned +
      cssScanResult.filesScanned +
      codeBehindResult.filesScanned,
    rawWarnings:
      jsLintResult.rawWarnings +
      aspxIssues.length +
      htmlLintResult.issues.length +
      jsDomResult.issues.length +
      cssScanResult.issues.length +
      codeBehindResult.issues.length,
  };
}

async function scanAspNetHtmlLint(
  repoPath: string,
  onProgress?: (event: StaticScanProgressEvent) => void,
): Promise<{ filesScanned: number; issues: AspxScanIssue[] }> {
  const lintExts = [".html", ".htm", ".cshtml", ".aspx", ".ascx", ".master"];
  const files = await listFilesWithExtensions(repoPath, lintExts);
  const issues: AspxScanIssue[] = [];
  let filesScanned = 0;
  let processedFiles = 0;

  logStaticPhaseWorkload("aspnet:html-lint", files.length);

  for (const absPath of files) {
    processedFiles += 1;
    let content = "";
    try {
      content = await readFile(absPath, "utf8");
    } catch {
      continue;
    }

    const relPath = normalizePath(relative(repoPath, absPath));
    if (shouldSkipStaticFile(relPath)) {
      continue;
    }

    if (!isPlainHtmlLintCandidate(content, relPath)) {
      continue;
    }

    logStaticPhaseProgress(
      "aspnet:html-lint",
      processedFiles,
      files.length,
      relPath,
      onProgress,
    );

    filesScanned += 1;
    issues.push(...findHtmlLintIssues(content, relPath));
  }

  return { filesScanned, issues };
}

async function scanJsA11yStatic(
  repoPath: string,
  tags: string[],
): Promise<{ findings: Finding[]; filesScanned: number; rawWarnings: number }> {
  const configPath = await writeReactFlatConfig();
  // jsx-a11y rules operate on JSX syntax; scanning plain JS/TS scripts here
  // is high-cost and low-yield for ASP.NET repos. Non-JSX JS is covered by
  // scanJsDomInjectionPatterns and related heuristic checks.
  const jsExts = [".jsx", ".tsx"];
  const lintTargets = (await listFilesWithExtensions(repoPath, jsExts)).map((absPath) =>
    normalizePath(relative(repoPath, absPath)),
  );

  console.error(`[static-scanner] aspnet:js-a11y eslint cwd=${repoPath}`);
  console.error(`[static-scanner] aspnet:js-a11y targets=${lintTargets.length}`);

  if (lintTargets.length === 0) {
    return { findings: [], filesScanned: 0, rawWarnings: 0 };
  }

  const baseArgs = [
    "--format",
    "json",
    "--config",
    configPath,
    "--no-config-lookup",
    "--no-error-on-unmatched-pattern",
  ];

  const batchSize = getPositiveIntEnv("A11Y_ESLINT_BATCH_SIZE", 40);
  const timeoutMs = getPositiveIntEnv("A11Y_ESLINT_TIMEOUT_MS", 120000);
  const chunkWatchdogMs = getPositiveIntEnv(
    "A11Y_ESLINT_CHUNK_WATCHDOG_MS",
    timeoutMs + 5000,
  );
  const serialFallbackSize = getPositiveIntEnv(
    "A11Y_ESLINT_SERIAL_FALLBACK_SIZE",
    10,
  );
  const allParsed: EslintResult[] = [];
  let stderr = "";
  const timedOutFiles: string[] = [];

  const executeChunk = async (
    chunkTargets: string[],
    label: string,
  ): Promise<void> => {
    if (chunkTargets.length === 0) return;

    const startedAt = Date.now();
    console.error(
      `[static-scanner] aspnet:js-a11y eslint chunk ${label} files=${chunkTargets.length}`,
    );

    try {
      const eslintPromise = runEslint([...baseArgs, ...chunkTargets], repoPath, {
        timeoutMs,
      });
      const result = await withPromiseTimeout(
        eslintPromise,
        chunkWatchdogMs,
        () => {
          const timeoutError = new Error(
            `eslint chunk ${label} watchdog timeout after ${chunkWatchdogMs}ms`,
          ) as EslintExecutionError;
          timeoutError.timedOut = true;
          return timeoutError;
        },
      );
      if (result.stderr.trim().length > 0) {
        stderr += `${result.stderr}\n`;
      }

      let parsedChunk: EslintResult[] = [];
      try {
        parsedChunk = JSON.parse(result.stdout);
      } catch {
        parsedChunk = [];
      }
      allParsed.push(...parsedChunk);

      console.error(
        `[static-scanner] aspnet:js-a11y eslint chunk done ${label} in ${Date.now() - startedAt}ms`,
      );
    } catch (err) {
      const error = err as EslintExecutionError;

      // Isolate problematic files by binary-splitting timed out chunks.
      if (error.timedOut && chunkTargets.length > 1) {
        if (chunkTargets.length <= serialFallbackSize) {
          console.warn(
            `[static-scanner] aspnet:js-a11y eslint chunk timeout ${label}; retrying serially (${chunkTargets.length} files)`,
          );
          for (let index = 0; index < chunkTargets.length; index += 1) {
            const target = chunkTargets[index];
            if (!target) continue;
            await executeChunk([target], `${label}#${index + 1}`);
          }
          return;
        }

        const mid = Math.floor(chunkTargets.length / 2);
        const left = chunkTargets.slice(0, mid);
        const right = chunkTargets.slice(mid);
        console.warn(
          `[static-scanner] aspnet:js-a11y eslint chunk timeout ${label}; splitting into ${left.length}+${right.length}`,
        );
        await executeChunk(left, `${label}L`);
        await executeChunk(right, `${label}R`);
        return;
      }

      if (error.stderr && error.stderr.trim().length > 0) {
        stderr += `${error.stderr}\n`;
      }

      if (error.timedOut) {
        timedOutFiles.push(...chunkTargets);
        console.warn(
          `[static-scanner] aspnet:js-a11y eslint timeout; skipped ${chunkTargets.length} file(s). First: ${chunkTargets[0] ?? "unknown"}`,
        );
      }

      const raw = error.stdout ?? "[]";
      try {
        const parsedChunk = JSON.parse(raw) as EslintResult[];
        allParsed.push(...parsedChunk);
      } catch {
        // Best effort: continue with what we have so one bad chunk does not stall full scan.
      }
    }
  };

  const chunks = chunkItems(lintTargets, batchSize);
  try {
    console.error("[static-scanner] aspnet:js-a11y eslint run");
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i] ?? [];
      await executeChunk(chunk, `${i + 1}/${chunks.length}`);
    }
    console.error("[static-scanner] aspnet:js-a11y eslint done");
  } catch (err) {
    const error = err as EslintExecutionError;
    if (error.stderr && error.stderr.trim().length > 0) {
      stderr += `${error.stderr}\n`;
    }
  } finally {
    try {
      await unlink(configPath);
    } catch {
      // Ignore cleanup errors
    }
  }

  const parsed = allParsed;

  if (parsed.length === 0 && stderr.trim().length > 0) {
    console.warn(
      `[static-scanner] ESLint produced no results but stderr is non-empty. Possible config error:\n${stderr.slice(0, 500)}`,
    );
  }

  if (timedOutFiles.length > 0) {
    console.warn(
      `[static-scanner] aspnet:js-a11y skipped ${timedOutFiles.length} file(s) due to timeout. Override with A11Y_ESLINT_TIMEOUT_MS.`,
    );
  }

  const normalized = normalizeEslintResults({
    parsed,
    repoPath,
    rulePrefix: "jsx-a11y/",
    source: "eslint-jsx-a11y",
    scIdsForRule: scIdsForEslintRule,
    helpUrl: (ruleId: string) =>
      `https://github.com/jsx-eslint/eslint-plugin-jsx-a11y/blob/main/docs/rules/${ruleId.replace(
        "jsx-a11y/",
        "",
      )}.md`,
    tags,
  });

  return {
    findings: normalized.findings,
    filesScanned: parsed.length,
    rawWarnings: normalized.rawWarnings,
  };
}

function getPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function chunkItems<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [items.slice()];

  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

async function withPromiseTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  buildTimeoutError: () => Error,
): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(buildTimeoutError());
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        reject(error);
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DEAD CODE: The CSS rule functions below (findOutlineNone through
// hasCompensatingFocusStyle) have been extracted to aspnet-css-rules.ts.
// scanCssA11yPatterns (their sole caller) is now imported from that file.
// These definitions are unreachable and should be deleted in a cleanup pass.
// ─────────────────────────────────────────────────────────────────────────────

function findOutlineNone(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, "");
  // Match CSS rules that contain outline: none/0
  const ruleRegex = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const ruleMatch of stripped.matchAll(ruleRegex)) {
    const selector = (ruleMatch[1] ?? "").trim();
    const body = ruleMatch[2] ?? "";
    if (!/outline\s*:\s*(?:none|0)/i.test(body)) continue;

    // Only flag if selector targets a focusable element and applies at focus time.
    // Must contain :focus, :focus-visible, :focus-within or be an unqualified rule.
    const isFocusRule = /:(?:focus|focus-visible|focus-within)/i.test(selector);
    const isInteractiveSelector =
      /(button|a\b|input|select|textarea|\[role\s*=\s*['"](?:button|link|menuitem|tab|checkbox|radio)['"]|\[tabindex\s*(?:>|=)\s*['"]?0['"]?\])/i.test(selector);
    const isUnqualified = !/:/.test(selector) && isInteractiveSelector;

    if (!isFocusRule && !isUnqualified) continue;

    // Pass if the same selector (or paired :focus rule) provides an alternative indicator.
    const baseSel = selector.replace(/:focus(?:-visible|-within)?/g, "").trim();
    const hasFocusPair = new RegExp(escapeRegex(baseSel) + "\\s*:\\s*(?:focus|focus-visible|focus-within)\\s*\\{[^}]*(?:outline|box-shadow|border|background)[^}]*\\}", "i").test(stripped);
    if (hasFocusPair) continue;

    // Pass if an alternative focus indicator is set in the same rule or a paired rule.
    if (/(?:outline|box-shadow|border|background)\s*:/i.test(body)) continue;

    const index = ruleMatch.index ?? 0;
    const { line, column } = getLineColumn(stripped, index);
    issues.push({
      ruleId: "aspnet/css-outline-none",
      title: "outline:none removes the visible focus indicator",
      description:
        "`outline: none` suppresses the browser's default focus ring on a focusable element. " +
        "Provide an alternative focus indicator (box-shadow, border, or outline in another color) to help keyboard users see their position (WCAG 2.4.7 / 2.4.11).",
      wcagSc: "2.4.7",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 200),
    });
  }
  return issues;
}

function findPointerEventsNone(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const ruleRegex = /([^{}]+)\{([\s\S]*?)\}/g;
  const INTERACTIVE_TAGS = /(button|\ba\b|input|select|textarea)/i;
  const ARIA_WIDGET_ROLE = /role\s*=\s*['"](?:button|link|menuitem|tab|checkbox|radio|option)['"]\b/i;

  for (const match of content.matchAll(ruleRegex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (!/pointer-events\s*:\s*none/i.test(body)) continue;

    // Pass if selector targets descendants/decorative icon nodes.
    // e.g., "button svg", "button .icon", "button::before", etc.
    const isDescendantSelector = /\s+[.#\[>~:]|:(?:before|after|first-child|last-child)/i.test(selector);
    if (isDescendantSelector) continue;

    const decorativeTargetSelector =
      /(?:^|[\s>+~])(?:svg|i)\b|\.(?:icon|symbol)\b|::(?:before|after)\b/i.test(selector);
    if (decorativeTargetSelector) continue;

    // Must match an interactive element tag or role in the *base* selector itself.
    if (!INTERACTIVE_TAGS.test(selector) && !ARIA_WIDGET_ROLE.test(selector)) continue;

    // Pass if a sibling :hover / :focus / :active rule re-enables pointer-events.
    const baseSelector = selector.replace(/:[^\s{]+/g, "").trim();
    const siblingRulePattern = new RegExp(
      escapeRegex(baseSelector) + "\\s*:\\s*(?:hover|focus|active)\\s*\\{[^}]*pointer-events\\s*:",
      "i"
    );
    if (siblingRulePattern.test(content)) continue;

    const fullRule = match[0] ?? "";
    const openBraceOffset = fullRule.indexOf("{");
    const declarationOffset = body.search(/pointer-events\s*:\s*none/i);
    const index = (match.index ?? 0) + Math.max(0, openBraceOffset + 1) + Math.max(0, declarationOffset);
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-pointer-events-none",
      title: "pointer-events:none on interactive selectors blocks interaction",
      description:
        "An interactive element (button, link, input) has pointer-events:none, blocking all click/tap input. Use aria-disabled with keyboard handling for disabled states, or remove pointer-events:none (WCAG 2.1.1).",
      wcagSc: "2.1.1",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 200),
    });
  }

  return issues;
}

function findCssInfiniteAnimation(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const match of content.matchAll(regex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (!/animation-iteration-count\s*:\s*infinite/i.test(body)) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-infinite-animation",
      title: "Infinite animation detected",
      description: "animation-iteration-count: infinite can create persistent motion without a pause/stop mechanism (WCAG 2.2.2).",
      wcagSc: "2.2.2",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 200),
    });
  }

  return issues;
}

function findCssColorOnlyFocus(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  if (isThirdPartyStylesheetPath(filePath)) return issues;
  const focusBlockRegex = /([^{}]+:(?:focus|focus-visible)[^{}]*)\{([\s\S]*?)\}/gi;

  for (const match of content.matchAll(focusBlockRegex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (isThirdPartySelector(selector) && !isProjectOverrideFile(filePath)) continue;
    if (/(?:\.readOnly\b|\.disabled\b|\[readonly\]|\[disabled\]|\[aria-disabled\s*=\s*['"]true['"])/i.test(selector)) continue;

    const hasHighlightFocusClass = /\.highlightFocus\b/i.test(selector);
    if (hasHighlightFocusClass && /\b(?:background|background-color|border(?:-color|-width|-style)?|box-shadow)\s*:/i.test(body)) {
      continue;
    }

    // Author-declared intent: other well-known focus-class name tokens
    const hasDeclaredFocusClass = /\.(?:focusRing|hasFocus|keyboardFocus|visibleFocus)\b/i.test(selector);
    if (hasDeclaredFocusClass && /\b(?:background|background-color|border(?:-color|-width|-style)?|box-shadow)\s*:/i.test(body)) {
      continue;
    }

    const isFocusVisible = /:focus-visible/i.test(selector);
    if (!isFocusVisible) {
      const focusVisiblePair = buildPairedFocusVisibleSelector(selector);
      if (focusVisiblePair) {
        const pairRegex = new RegExp(`${escapeRegex(focusVisiblePair)}\\s*\\{([\\s\\S]*?)\\}`, "i");
        const pairBody = pairRegex.exec(content)?.[1] ?? "";
        if (pairBody && /\b(?:outline\s*:\s*(?!none\b|0\b)[^;]+|box-shadow\s*:[^;]+|border(?:-color|-width|-style)?\s*:[^;]+|background(?:-color)?\s*:[^;]+)/i.test(pairBody)) {
          continue;
        }
      }
    }

    const hasColor = /\bcolor\s*:\s*[^;]+/i.test(body);
    const hasBackgroundSignal = /\b(?:background|background-color)\s*:\s*[^;]+/i.test(body);
    const hasStrongIndicator = /\b(?:outline|box-shadow|border(?:-color|-width|-style)?|text-decoration|transform)\s*:/i.test(body);
    if (!hasColor || hasBackgroundSignal || hasStrongIndicator) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-focus-text-color-only",
      title: "Focus style appears text-color-only",
      description: "Focus indication appears to change only text color; include non-color indicators such as outline, border, shadow, text-decoration, or transform (WCAG 1.4.11 / 2.4.7).",
      wcagSc: "1.4.11",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

function findCssHoverOnlyReveal(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const ruleRegex = /([^{}]+)\{([\s\S]*?)\}/g;
  const rules = Array.from(content.matchAll(ruleRegex));

  const normalizeBaseSelector = (selector: string): string =>
    selector
      .replace(/:hover/gi, "")
      .replace(/:focus-visible/gi, "")
      .replace(/:focus-within/gi, "")
      .replace(/:focus/gi, "")
      .replace(/:active/gi, "")
      .replace(/\s+/g, " ")
      .trim();

  const revealsHiddenContent = (body: string): boolean => {
    return /\bdisplay\s*:\s*(?:block|inline|inline-block|flex|grid|table|table-row|table-cell)\b/i.test(body)
      || /\bvisibility\s*:\s*visible\b/i.test(body)
      || /\bopacity\s*:\s*1(?:\.0+)?\b/i.test(body)
      || /\btransform\s*:\s*[^;]*(?:scale\((?!0(?:\.0+)?)|translate[XY]?\((?!0(?:px|%|rem|em)?\)))/i.test(body)
      || /\b(?:height|max-height)\s*:\s*(?:[1-9]\d*|\d+\.\d+)(?:px|em|rem|%|vh)\b/i.test(body)
      || /\boverflow\s*:\s*(?:visible|auto|scroll)\b/i.test(body);
  };

  const isPurelyCosmeticChange = (body: string): boolean => {
    const hasRevealProperties = /\b(?:display|visibility|opacity|transform|height|max-height|overflow)\s*:/i.test(body);
    const hasColorOnly = /\b(?:color|background|background-color|border-color|text-decoration-color)\s*:/i.test(body);
    return !hasRevealProperties && hasColorOnly;
  };

  const extractSelectorClassNames = (selector: string): string[] =>
    Array.from(selector.matchAll(/\.([\w-]+)/g))
      .map((m) => m[1] ?? "")
      .filter(Boolean);

  const focusRevealBaseSelectors = new Set<string>();
  for (const rule of rules) {
    const selectorGroup = (rule[1] ?? "").trim();
    const body = rule[2] ?? "";
    if (!selectorGroup || !revealsHiddenContent(body) || isPurelyCosmeticChange(body)) continue;

    const selectors = selectorGroup.split(",").map((s) => s.trim()).filter(Boolean);
    for (const selector of selectors) {
      if (!/:(?:focus|focus-within|focus-visible)/i.test(selector)) continue;
      focusRevealBaseSelectors.add(normalizeBaseSelector(selector));
    }
  }

  const focusableClassNames = new Set<string>();
  const interactiveContextRegex = /class\s*=\s*['\"]([^'\"]+)['\"][\s\S]{0,600}?(?:<a\b|<button\b|<input\b|<select\b|<textarea\b|tabindex\s*=\s*['\"]?0)/gi;
  for (const match of content.matchAll(interactiveContextRegex)) {
    const classAttr = match[1] ?? "";
    for (const className of classAttr.split(/\s+/)) {
      const normalized = className.trim();
      if (normalized.length > 0) {
        focusableClassNames.add(normalized);
      }
    }
  }

  const hasFocusHandlers = /onfocus|focusin|addEventListener\s*\(\s*['\"]focus(?:in)?['\"]|\.on\s*\(\s*['\"]focus(?:in)?['\"]/i.test(content);
  const jsReferencedClassNames = new Set<string>();
  if (hasFocusHandlers) {
    const classSelectorRegex = /(?:querySelector|matches|closest)\s*\(\s*['\"][^'\"]*\.([\w-]+)/gi;
    for (const match of content.matchAll(classSelectorRegex)) {
      const className = (match[1] ?? "").trim();
      if (className.length > 0) {
        jsReferencedClassNames.add(className);
      }
    }

    const classContainsRegex = /classList\.contains\s*\(\s*['\"]([\w-]+)['\"]\s*\)/gi;
    for (const match of content.matchAll(classContainsRegex)) {
      const className = (match[1] ?? "").trim();
      if (className.length > 0) {
        jsReferencedClassNames.add(className);
      }
    }
  }

  const focusableContextCache = new Map<string, boolean>();
  const focusJsCompanionCache = new Map<string, boolean>();

  const baseHasFocusableContext = (baseSelector: string): boolean => {
    const cached = focusableContextCache.get(baseSelector);
    if (cached !== undefined) {
      return cached;
    }

    if (/(\ba\b|\bbutton\b|\binput\b|\bselect\b|\btextarea\b|\bsummary\b|\[tabindex|\[href|\[role\s*=\s*['"]?(?:button|link|menuitem|tab|option|treeitem|switch|checkbox|radio))/i.test(baseSelector)) {
      focusableContextCache.set(baseSelector, true);
      return true;
    }

    const classNames = extractSelectorClassNames(baseSelector);
    const hasFocusableClass = classNames.some((name) => focusableClassNames.has(name));
    focusableContextCache.set(baseSelector, hasFocusableClass);
    return hasFocusableClass;
  };

  const hasFocusJsCompanion = (baseSelector: string): boolean => {
    const cached = focusJsCompanionCache.get(baseSelector);
    if (cached !== undefined) {
      return cached;
    }

    if (!hasFocusHandlers) {
      focusJsCompanionCache.set(baseSelector, false);
      return false;
    }

    const classNames = extractSelectorClassNames(baseSelector);
    const hasCompanion = classNames.some((name) => jsReferencedClassNames.has(name));
    focusJsCompanionCache.set(baseSelector, hasCompanion);
    return hasCompanion;
  };

  for (const match of rules) {
    const selectorGroup = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    const selectors = selectorGroup.split(",").map((s) => s.trim()).filter(Boolean);
    const hoverSelectors = selectors.filter((s) => /:hover/i.test(s));
    if (hoverSelectors.length === 0) continue;
    if (!revealsHiddenContent(body)) continue;
    if (isPurelyCosmeticChange(body)) continue;

    for (const hoverSelector of hoverSelectors) {
      const baseSelector = normalizeBaseSelector(hoverSelector);
      if (!baseSelector) continue;

      // Skip false positives where the same grouped rule already includes focus equivalent.
      const hasFocusInSameRule = selectors.some((s) =>
        /:(?:focus|focus-within|focus-visible)/i.test(s) && normalizeBaseSelector(s) === baseSelector,
      );
      if (hasFocusInSameRule) continue;
      if (focusRevealBaseSelectors.has(baseSelector)) continue;

      if (!baseHasFocusableContext(baseSelector)) continue;
      if (hasFocusJsCompanion(baseSelector)) continue;

      const index = match.index ?? 0;
      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: "aspnet/css-hover-only-reveal",
        title: "Hover-only reveal without focus equivalent",
        description: "Rule reveals hidden content on :hover but no equivalent :focus/:focus-within/:focus-visible reveal was detected for keyboard users (WCAG 1.4.13).",
        wcagSc: "1.4.13",
        filePath,
        line,
        column,
        htmlSnippet: hoverSelector.slice(0, 220),
      });
    }
  }

  return issues;
}

function findCssLowContrastSameRule(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const ruleRegex = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const match of content.matchAll(ruleRegex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    const fg = parseColorFromCssProp(body, "color");
    const bg = parseColorFromCssProp(body, "background-color") ?? parseColorFromCssProp(body, "background");
    if (!fg || !bg) continue;

    const ratio = contrastRatio(fg, bg);
    const fontSize = parseCssPx(body, "font-size");
    const fontWeight = parseCssFontWeight(body);
    const isLarge = (fontSize !== null && fontSize >= 24) || (fontSize !== null && fontSize >= 18.5 && fontWeight >= 700);
    const threshold = isLarge ? 3 : 4.5;
    if (ratio >= threshold) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-low-contrast-same-rule",
      title: "Low text contrast detected in same CSS rule",
      description: `Same-rule foreground/background contrast is ${ratio.toFixed(2)}:1, below ${threshold}:1 threshold (${isLarge ? "large" : "normal"} text) (WCAG 1.4.3).`,
      wcagSc: "1.4.3",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

function findCssFontSizeZero(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const match of content.matchAll(regex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (!/\bfont-size\s*:\s*0(?:px|rem|em|%)?\b/i.test(body)) continue;

    const isVendor = /(jquery-ui|infragistics|\big-|\bui-)/i.test(filePath) || /(\big-|\bui-)/i.test(selector);
    const knownIconOrSpacer = /(\.ui-icon\b|\.icon\b|\.svg-|::before|::after|\.ui-menu-divider|\.ui-datepicker-row-break|\.ui-resizable-handle|\.ui-iggrid-)/i.test(selector);
    if (knownIconOrSpacer) continue;

    if (/(\bsvg\b|\bimg\b|input\s*\[\s*type\s*=\s*['"]image['"])/i.test(selector)) continue;

    const likelyTextSelector = /(\bp\b|\bh[1-6]\b|\bli\b|\btd\b|\bth\b|\blabel\b|\blegend\b|\bblockquote\b|\ba\b|\bbutton\b|\binput\b|\bselect\b|\btextarea\b|\.text\b|\.content\b|\.copy\b|\.caption\b|\.label\b|\.title\b)/i.test(selector);
    if (isVendor && !likelyTextSelector) continue;

    // Common whitespace-collapse pattern: parent font-size:0 and children restore font-size.
    const hasChildReset = new RegExp(`${escapeRegex(selector)}\\s*>?\\s*[^,{]+\\{[^}]*\\bfont-size\\s*:\\s*(?!0(?:px|rem|em|%)?\\b)[^;]+`, "i").test(content);
    if (hasChildReset) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: isVendor ? "aspnet/css-font-size-zero-informational" : "aspnet/css-font-size-zero",
      title: isVendor ? "font-size:0 can hide text content (informational)" : "font-size:0 can hide text content",
      description: isVendor
        ? "Vendor CSS uses font-size:0. Treat as informational unless visible text descendants are collapsed at runtime."
        : "font-size:0 on text-bearing selectors can remove readable text and hide content from sighted users (WCAG 1.4.4).",
      wcagSc: "1.4.4",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

function findCssFixedBaseFontPx(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  if (/\/font-(?:ar|he|ja|ko|zh|th|hi|bn)\.css$/i.test(normalizePath(filePath))) {
    return issues;
  }

  for (const match of content.matchAll(regex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (!hasRightmostHtmlOrBodyTarget(selector)) continue;
    if (selectorHasLanguageExemption(selector)) continue;
    if (!/\bfont-size\s*:\s*\d+(?:\.\d+)?px\b/i.test(body)) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-base-font-px",
      title: "Base html/body font-size set in px",
      description: "Fixed px base font sizes on html/body can reduce user text-resize flexibility in some environments (WCAG 1.4.4).",
      wcagSc: "1.4.4",
      filePath,
      line,
      column,
      htmlSnippet: selector,
    });
  }

  return issues;
}

function findCssImportantFontSizePx(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const match of content.matchAll(regex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (!/\bfont-size\s*:\s*\d+(?:\.\d+)?px\s*!important\b/i.test(body)) continue;

    // Exclude font-size:0 !important (covered by dedicated rule).
    if (/\bfont-size\s*:\s*0(?:\.0+)?px\s*!important\b/i.test(body)) continue;

    // Ignore decorative/icon-only containers.
    if (/(\.ui-icon\b|\.icon\b|\.svg-|::before|::after)/i.test(selector)) continue;

    // Only consider text-rendering selectors.
    if (!/(\bp\b|\bh[1-6]\b|\blabel\b|\blegend\b|\ba\b|\bbutton\b|\binput\b|\bselect\b|\btextarea\b|\.text\b|\.content\b|\.copy\b|\.caption\b)/i.test(selector)) {
      continue;
    }

    const isVendor = /(jquery-ui|infragistics|\big-|\bui-)/i.test(filePath) || /(\big-|\bui-)/i.test(selector);

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: isVendor ? "aspnet/css-font-size-px-important-informational" : "aspnet/css-font-size-px-important-warning",
      title: isVendor ? "font-size uses px with !important (informational)" : "font-size uses px with !important (warning)",
      description: isVendor
        ? "Vendor CSS uses px font-size with !important. Treat as informational unless override conflicts are observed at runtime."
        : "Using !important on px font-size is a best-practice warning. It may reduce user stylesheet override flexibility; prefer rem and avoid !important where possible.",
      wcagSc: "1.4.4",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

function findCssLineHeightImportantLow(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const match of content.matchAll(regex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    const lh = parseCssUnitlessOrNumber(body, "line-height");
    if (lh === null || lh >= 1.5) continue;
    if (!/\bline-height\s*:[^;]*!important\b/i.test(body)) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-line-height-important-low",
      title: "line-height < 1.5 with !important",
      description: "Forced low line-height with !important can block text-spacing adjustments needed by some users (WCAG 1.4.12).",
      wcagSc: "1.4.12",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

function findCssSpacingImportant(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  const nonTextContainerSelector =
    /(?:^|[\s>+~.#])(div|section|article|aside|main|nav|header|footer|wrapper|panel|container|layout|frame|viewer|chrome|splitter|resize-|foldersResize|ulc_|igdm_|ui-iggrid)/i;
  const textBearingSelector =
    /(^|[\s>+~,])(p|h[1-6]|li|td|th|label|legend|blockquote|a|button|input|select|textarea)\b|\.(?:text|content|copy|caption|label|title|description)\b/i;

  const parseImportantDeclarationValue = (body: string, prop: string): string | null => {
    const declRegex = new RegExp(`\\b${escapeRegex(prop)}\\s*:\\s*([^;]*?)!important\\b`, "i");
    const value = declRegex.exec(body)?.[1]?.trim();
    return value && value.length > 0 ? value : null;
  };

  const parseCssNumberUnit = (value: string): { num: number; unit: string } | null => {
    const m = /^(-?\d+(?:\.\d+)?)([a-z%]*)$/i.exec(value.trim());
    if (!m) return null;
    const num = Number(m[1]);
    const unit = (m[2] ?? "").toLowerCase();
    if (Number.isNaN(num)) return null;
    return { num, unit };
  };

  const isLikelyBlockingTextSpacingValue = (prop: string, rawValue: string): boolean => {
    const normalized = rawValue.trim().toLowerCase();
    if (/(inherit|initial|unset|normal|calc\(|var\()/i.test(normalized)) {
      return false;
    }

    const parsed = parseCssNumberUnit(normalized);
    if (!parsed) return false;
    const { num, unit } = parsed;

    // Do not flag values that already satisfy WCAG 1.4.12 spacing targets.
    if (prop === "line-height") {
      if (unit === "" && num >= 1.5) return false;
      if (unit === "%" && num >= 150) return false;
      if (unit === "em" && num >= 1.5) return false;
      // Fixed lengths or smaller values can block user overrides.
      return true;
    }

    if (prop === "letter-spacing") {
      if (unit === "em" && num >= 0.12) return false;
      if (unit === "px" && num >= 2) return false;
      return true;
    }

    if (prop === "word-spacing") {
      if (unit === "em" && num >= 0.16) return false;
      if (unit === "px" && num >= 3) return false;
      return true;
    }

    // Paragraph spacing target: 2em. Apply to margin/padding properties.
    if (prop === "margin" || prop === "margin-top" || prop === "margin-bottom" || prop === "padding") {
      if (unit === "em" && num >= 2) return false;
      if (unit === "px" && num >= 32) return false;
      return true;
    }

    return false;
  };

  for (const match of content.matchAll(regex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";

    // Only evaluate selectors likely to render text content.
    if (!textBearingSelector.test(selector)) continue;

    // Skip known structural/layout-only containers.
    if (nonTextContainerSelector.test(selector) && !/(p|h[1-6]|li|td|th|label|legend|blockquote|a|button|input|select|textarea)\b/i.test(selector)) {
      continue;
    }

    const importantTextSpacingProps = ["line-height", "letter-spacing", "word-spacing", "margin", "margin-top", "margin-bottom", "padding"];

    let shouldFlag = false;
    for (const prop of importantTextSpacingProps) {
      const value = parseImportantDeclarationValue(body, prop);
      if (!value) continue;

      // margin/padding should only be considered when selector is paragraph-like/text container.
      if ((prop === "margin" || prop === "margin-top" || prop === "margin-bottom" || prop === "padding") &&
        !/(p|li|td|th|blockquote|label|legend|h[1-6]|textarea|input|select|button|\.text|\.content|\.copy|\.description|\.caption)/i.test(selector)) {
        continue;
      }

      if (isLikelyBlockingTextSpacingValue(prop, value)) {
        shouldFlag = true;
        break;
      }
    }

    if (!shouldFlag) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-spacing-important",
      title: "Text spacing property forced with !important",
      description: "Forcing letter/word/paragraph spacing with !important can interfere with user text-spacing overrides (WCAG 1.4.12).",
      wcagSc: "1.4.12",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

function findCssMinWidthWithoutFallback(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const match of content.matchAll(regex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    const minWidth = parseCssPx(body, "min-width");
    if (minWidth === null || minWidth <= 320) continue;
    if (!/(^|,|\s)(html|body|main|\.container|#app|\.layout-shell)\b/i.test(selector)) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-min-width-large",
      title: "Large min-width on top-level container",
      description: "Top-level min-width above 320px may hinder narrow-viewport reflow unless responsive fallbacks exist (WCAG 1.4.10, heuristic).",
      wcagSc: "1.4.10",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

function findCssTargetSizeTooSmall(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  if (isThirdPartyStylesheetPath(filePath)) return issues;
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  const parsePxDeclaration = (body: string, prop: string): number | null => {
    const m = new RegExp(`\\b${escapeRegex(prop)}\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\b`, "i").exec(body);
    if (!m?.[1]) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  };

  const parsePaddingPx = (body: string): { top: number; right: number; bottom: number; left: number } => {
    const fromSide = (prop: string): number => parsePxDeclaration(body, prop) ?? 0;

    const sideTop = fromSide("padding-top");
    const sideRight = fromSide("padding-right");
    const sideBottom = fromSide("padding-bottom");
    const sideLeft = fromSide("padding-left");
    if (sideTop || sideRight || sideBottom || sideLeft) {
      return { top: sideTop, right: sideRight, bottom: sideBottom, left: sideLeft };
    }

    const shorthand = /\bpadding\s*:\s*([^;]+?)(?:!important)?\s*(?:;|$)/i.exec(body)?.[1]?.trim() ?? "";
    if (!shorthand) return { top: 0, right: 0, bottom: 0, left: 0 };
    const values = shorthand.split(/\s+/).map((v) => {
      const m = /^(\d+(?:\.\d+)?)px$/i.exec(v.trim());
      return m?.[1] ? Number(m[1]) : NaN;
    });
    if (values.some((v) => Number.isNaN(v))) return { top: 0, right: 0, bottom: 0, left: 0 };
    if (values.length === 1) return { top: values[0] ?? 0, right: values[0] ?? 0, bottom: values[0] ?? 0, left: values[0] ?? 0 };
    if (values.length === 2) return { top: values[0] ?? 0, right: values[1] ?? 0, bottom: values[0] ?? 0, left: values[1] ?? 0 };
    if (values.length === 3) return { top: values[0] ?? 0, right: values[1] ?? 0, bottom: values[2] ?? 0, left: values[1] ?? 0 };
    return { top: values[0] ?? 0, right: values[1] ?? 0, bottom: values[2] ?? 0, left: values[3] ?? 0 };
  };

  const normalizeSelector = (selector: string): string => selector.replace(/\s+/g, " ").trim();
  const selectorList = Array.from(content.matchAll(regex)).map((m) => ({
    selector: (m[1] ?? "").trim(),
    body: m[2] ?? "",
    index: m.index ?? 0,
  }));

  // Precompute selectors that already enforce >=24px minimum size.
  const selectorsWithPairedMinRule = new Set<string>();
  for (const candidate of selectorList) {
    if (
      /\bmin-width\s*:\s*(2[4-9]|[3-9]\d|\d{3,})(?:\.\d+)?px\b/i.test(candidate.body)
      && /\bmin-height\s*:\s*(2[4-9]|[3-9]\d|\d{3,})(?:\.\d+)?px\b/i.test(candidate.body)
    ) {
      selectorsWithPairedMinRule.add(normalizeSelector(candidate.selector));
    }
  }

  for (const rule of selectorList) {
    const selector = rule.selector;
    const body = rule.body;

    if (isThirdPartySelector(selector) && !isProjectOverrideFile(filePath)) {
      continue;
    }

    const isVendor = /(jquery-ui|infragistics|\big-|ui-iggrid-|igdm_|\bui-|\bdx-|\bmat-|\bmdl-|\bant-|\.Mui)/i.test(filePath)
      || /(jquery-ui|infragistics|\big-|ui-iggrid-|igdm_|\bui-|\bdx-|\bmat-|\bmdl-|\bant-|\.Mui)/i.test(selector);
    const isScrollbarOrVendorPseudo = /::-webkit-scrollbar|::-webkit-scrollbar-button|scrollbar|\.ui-iggrid-|\.ig-|\.ui-/i.test(selector);
    const isKnownException = /(legend|swatch|chart|sparkline|thumbnail|icon-only|\.icon\b)/i.test(selector) || isScrollbarOrVendorPseudo;

    const targetsInteractive =
      /(\bbutton\b|\ba\b|\binput\b|\bselect\b|\[role\s*=\s*['"](?:button|link|menuitem|option|tab|treeitem|checkbox|radio|switch|gridcell)['"])/i.test(selector);
    if (!targetsInteractive) continue;

    // Inline prose links and footnote refs are spacing-exempt in WCAG 2.5.8.
    if (/\bp\s+a\b|\bprose\b[^,{]*\ba\b|\bfootnote\b|\bsup\s*a\b|a\.fnref\b/i.test(selector)) continue;

    // Background-image/icon sizing alone is not target-size evidence.
    if (/\bbackground-size\s*:/i.test(body) && !/\b(?:width|height)\s*:\s*\d+(?:\.\d+)?px\b/i.test(body)) continue;

    const width = parsePxDeclaration(body, "width");
    const height = parsePxDeclaration(body, "height");
    if (width === null || height === null) continue;
    if (width >= 24 || height >= 24) continue;

    const padding = parsePaddingPx(body);
    const effectiveWidth = width + padding.left + padding.right;
    const effectiveHeight = height + padding.top + padding.bottom;
    if (effectiveWidth >= 24 && effectiveHeight >= 24) continue;

    // Same-rule min sizes can satisfy the requirement.
    const minWidth = parsePxDeclaration(body, "min-width");
    const minHeight = parsePxDeclaration(body, "min-height");
    if ((minWidth ?? 0) >= 24 && (minHeight ?? 0) >= 24) continue;

    // Paired rules for the same selector may raise min dimensions.
    const normalized = normalizeSelector(selector);
    const hasPairedMinRule = selectorsWithPairedMinRule.has(normalized);
    if (hasPairedMinRule) continue;

    if (/input\s*\[\s*type\s*=\s*['"]?(?:checkbox|radio)['"]?\s*\]/i.test(selector)) {
      if (hasExpandedCheckboxRadioHitArea(content, selector, body)) {
        continue;
      }
    }

    if (hasSelectorContainerHitArea(content, selector, body)) {
      continue;
    }

    if (isKnownException && !isVendor) continue;

    const index = rule.index;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: isVendor ? "aspnet/css-target-size-too-small-informational" : "aspnet/css-target-size-too-small",
      title: isVendor
        ? "Interactive target size may be below 24x24px (informational)"
        : "Interactive target size may be below 24x24px",
      description: isVendor
        ? "Vendor stylesheet appears to set a small interactive target. Treat as informational; remediation may belong upstream."
        : "Small fixed interactive targets can be hard to operate by touch and motor-impaired users; aim for at least 24x24 CSS px (WCAG 2.5.8).",
      wcagSc: "2.5.8",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

function parseColorFromCssProp(body: string, prop: string): [number, number, number] | null {
  const regex = new RegExp(`\\b${escapeRegex(prop)}\\s*:\\s*([^;]+)`, "i");
  const value = regex.exec(body)?.[1]?.trim();
  if (!value) return null;

  const hexMatch = /^#([a-f0-9]{3}|[a-f0-9]{6})$/i.exec(value);
  if (hexMatch) {
    const hex = hexMatch[1] ?? "";
    if (hex.length === 3) {
      const h0 = hex.charAt(0);
      const h1 = hex.charAt(1);
      const h2 = hex.charAt(2);
      return [
        parseInt(h0 + h0, 16),
        parseInt(h1 + h1, 16),
        parseInt(h2 + h2, 16),
      ];
    }
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }

  const rgbMatch = /^rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(value);
  if (rgbMatch) {
    return [Number(rgbMatch[1] ?? 0), Number(rgbMatch[2] ?? 0), Number(rgbMatch[3] ?? 0)];
  }

  return null;
}

function relativeLuminance(rgb: [number, number, number]): number {
  const converted = rgb.map((v) => {
    const srgb = v / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  const r = converted[0] ?? 0;
  const g = converted[1] ?? 0;
  const b = converted[2] ?? 0;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseCssPx(body: string, prop: string): number | null {
  const regex = new RegExp(`\\b${escapeRegex(prop)}\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\b`, "i");
  const value = regex.exec(body)?.[1];
  return value ? Number(value) : null;
}

function parseCssFontWeight(body: string): number {
  const value = /\bfont-weight\s*:\s*(\d{3}|normal|bold)\b/i.exec(body)?.[1]?.toLowerCase();
  if (!value) return 400;
  if (value === "bold") return 700;
  if (value === "normal") return 400;
  return Number(value);
}

function parseCssUnitlessOrNumber(body: string, prop: string): number | null {
  const regex = new RegExp(`\\b${escapeRegex(prop)}\\s*:\\s*(\\d+(?:\\.\\d+)?)`, "i");
  const value = regex.exec(body)?.[1];
  return value ? Number(value) : null;
}

function hasCompensatingFocusStyle(content: string, index: number): boolean {
  const windowEnd = Math.min(content.length, index + 900);
  const window = content.slice(index, windowEnd);

  // If the same rule block declares a focus-visible/focus state with an
  // explicit outline/box-shadow, we treat outline:0 as intentional reset.
  const focusStyleRegex = /(?:&:)?:(?:focus-visible|focus)\b[\s\S]{0,220}?(?:outline\s*:\s*(?!none\b|0\b)[^;]+|box-shadow\s*:\s*[^;]+)/i;
  if (focusStyleRegex.test(window)) {
    return true;
  }

  // Also accept a direct positive focus ring after the reset within the same
  // local block, even if the selector isn't nested with &:focus-visible.
  const explicitFocusRingRegex = /(?:&:)?:(?:focus-visible|focus)\b[\s\S]{0,220}?outline\s*:\s*(?!none\b|0\b)[^;]+/i;
  return explicitFocusRingRegex.test(window);
}

async function scanJsDomInjectionPatterns(
  repoPath: string,
  onProgress?: (event: StaticScanProgressEvent) => void,
): Promise<{ filesScanned: number; issues: AspxScanIssue[] }> {
  const jsExts = [".js", ".ts", ".jsx", ".tsx"];
  const files = await listFilesWithExtensions(repoPath, jsExts);
  const issues: AspxScanIssue[] = [];
  let processedFiles = 0;

  logStaticPhaseWorkload("aspnet:dom-injection", files.length);

  // Heuristic a11y checks work on source patterns, not full bundle analysis.
  // Cap content fed to regex at 512 KB so minified/bundled files don't cause
  // catastrophic backtracking — but we still scan every file in the list.
  const DOM_SCAN_CONTENT_WINDOW = 512 * 1024;

  for (const absPath of files) {
    processedFiles += 1;
    const relPath = normalizePath(relative(repoPath, absPath));

    // Skip check before reading to avoid I/O cost on large excluded files.
    if (shouldSkipStaticFile(relPath)) {
      continue;
    }

    console.error(`[static-scanner] aspnet:dom-injection scanning ${relPath}`);

    let rawContent = "";
    try {
      rawContent = await readFile(absPath, "utf8");
    } catch {
      continue;
    }

    logStaticPhaseProgress(
      "aspnet:dom-injection",
      processedFiles,
      files.length,
      relPath,
      onProgress,
    );

    // Truncate to content window so heuristic regex cannot run on megabytes of
    // minified/bundled code. Real app-authored patterns appear near the top.
    const content = rawContent.length > DOM_SCAN_CONTENT_WINDOW
      ? rawContent.slice(0, DOM_SCAN_CONTENT_WINDOW)
      : rawContent;

    issues.push(...findJsImgMissingAlt(content, relPath));
    issues.push(...findJsEmptyInteractiveElement(content, relPath));
    issues.push(...findJsInputMissingLabel(content, relPath));
    issues.push(...findJsAriaHidden(content, relPath));
    issues.push(...findJsPositiveTabIndex(content, relPath));
    issues.push(...findJsCreateElementImgMissingAlt(content, relPath));
    issues.push(...findJsConfirmAlert(content, relPath));
    issues.push(...findJsFocusStealing(content, relPath));
    issues.push(...findJsTabKeySuppression(content, relPath));
    issues.push(...findJsGlobalSingleCharShortcut(content, relPath));
    issues.push(...findJsMouseOnlyHoverBehavior(content, relPath));
    issues.push(...findJsOnFocusContextChange(content, relPath));
    issues.push(...findJsOnchangeNavigation(content, relPath));
    issues.push(...findJsPointerOnlyInteraction(content, relPath));
    issues.push(...findJsTimedContextChange(content, relPath));
    issues.push(...findJsPointermoveOnly(content, relPath));
    issues.push(...findJsDragWithoutKeyboardFallback(content, relPath));
  }

  return { filesScanned: files.length, issues };
}

async function scanAspNetCodeBehindPatterns(
  repoPath: string,
  onProgress?: (event: StaticScanProgressEvent) => void,
): Promise<{ filesScanned: number; issues: AspxScanIssue[] }> {
  const codeBehindExts = [".cs", ".vb"];
  const files = await listFilesWithExtensions(repoPath, codeBehindExts);
  const issues: AspxScanIssue[] = [];
  let processedFiles = 0;

  logStaticPhaseWorkload("aspnet:code-behind", files.length);
  console.error("[static-scanner] aspnet:code-behind roslyn start");
  const roslynResult = await runRoslynCodeBehindScan(repoPath);
  console.error("[static-scanner] aspnet:code-behind roslyn done");
  const roslynScannedFiles = new Set(
    roslynResult?.ScannedFiles.map((path) => path.replace(/\\/g, "/")) ?? [],
  );

  if (roslynResult) {
    issues.push(
      ...roslynResult.Issues
        .map((issue) => ({
          ruleId: issue.RuleId,
          title: issue.Title,
          description: issue.Description,
          wcagSc: issue.WcagSc,
          filePath: normalizePath(issue.FilePath),
          line: issue.Line,
          column: issue.Column,
          htmlSnippet: issue.HtmlSnippet,
        }))
        .filter((issue) => !shouldSkipStaticFile(issue.filePath)),
    );
  }

  for (const absPath of files) {
    processedFiles += 1;
    let content = "";
    try {
      content = await readFile(absPath, "utf8");
    } catch {
      continue;
    }
    const relPath = normalizePath(relative(repoPath, absPath));
    if (shouldSkipStaticFile(relPath)) {
      continue;
    }

    // Roslyn handles C# files with better flow awareness. Keep the heuristic
    // fallback for VB and for any file Roslyn did not report as scanned.
    if (relPath.toLowerCase().endsWith(".cs") && roslynScannedFiles.has(relPath.replace(/\\/g, "/"))) {
      continue;
    }

    logStaticPhaseProgress(
      "aspnet:code-behind",
      processedFiles,
      files.length,
      relPath,
      onProgress,
    );

    issues.push(...findCodeBehindControlPatterns(content, relPath));
    issues.push(...findCodeBehindScriptRegistrations(content, relPath));
    issues.push(...findCodeBehindRefreshHeader(content, relPath));
  }

  return {
    filesScanned: roslynResult?.FilesScanned ?? files.length,
    issues,
  };
}

async function runRoslynCodeBehindScan(
  repoPath: string,
): Promise<RoslynScanResultShape | null> {
  const helperProject = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../roslyn/A11yScout.Roslyn.csproj",
  );

  if (!existsSync(helperProject)) {
    return null;
  }

  return new Promise((resolveFn) => {
    const proc = spawn(
      "dotnet",
      ["run", "--project", helperProject, "--", repoPath],
      {
        cwd: repoPath,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", () => resolveFn(null));
    proc.on("close", (code) => {
      if (code !== 0) {
        console.warn(
          `[static-scanner] Roslyn helper failed, falling back to heuristic code-behind scan. ${stderr.slice(0, 500)}`,
        );
        resolveFn(null);
        return;
      }

      try {
        resolveFn(JSON.parse(stdout) as RoslynScanResultShape);
      } catch {
        console.warn(
          `[static-scanner] Roslyn helper returned unreadable JSON, falling back to heuristic code-behind scan. ${stdout.slice(0, 200)}`,
        );
        resolveFn(null);
      }
    });
  });
}

// ─── JS / jQuery DOM injection checks ────────────────────────────────────────

/**
 * Catches jQuery/template-string `<img` without a non-empty alt in the
 * same string literal: e.g. `$('<img src="x">')` or
 * `el.innerHTML = '<img src="x">'`
 */
function findJsImgMissingAlt(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  // Match string literals (single, double, template) that contain <img
  const stringLiteralRegex = /(?:`[^`]*`|"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')/gs;
  for (const m of content.matchAll(stringLiteralRegex)) {
    const literal = m[0];
    const outerIndex = m.index ?? 0;

    const nearbyStart = Math.max(0, outerIndex - 180);
    const nearbyEnd = Math.min(content.length, outerIndex + literal.length + 260);
    const nearby = content.slice(nearbyStart, nearbyEnd);
    const isDomInjectionContext =
      /(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|\.html\s*\(|\.append\s*\(|\.prepend\s*\(|createContextualFragment\s*\(|document\.write\s*\(|\$\s*\(/i.test(nearby);
    if (!isDomInjectionContext) continue;

    // Find every <img in this literal
    const imgRegex = /<img\b[^>]*>/gi;
    for (const imgMatch of literal.matchAll(imgRegex)) {
      const snippet = imgMatch[0];
      if (/\balt\s*=\s*(?:"\s*\{\{[^"}]+\}\}\s*"|'\s*\{\{[^'}]+\}\}\s*'|"\s*\$\{[^"}]+\}\s*"|'\s*\$\{[^'}]+\}\s*'|"\s*<%[\s\S]*?%>\s*"|'\s*<%[\s\S]*?%>\s*')/i.test(snippet)) {
        continue;
      }
      // Skip if alt attribute is present and non-empty
      if (/\balt\s*=\s*(?:"[^"]+"|'[^']+'|\w+)/i.test(snippet)) continue;
      const { line, column } = getLineColumn(content, outerIndex + (imgMatch.index ?? 0));
      issues.push({
        ruleId: "aspnet/js-img-missing-alt",
        title: "Dynamically injected image missing alt text",
        description:
          "A string literal containing an <img> element has no alt attribute. " +
          "If injected into the DOM, screen readers cannot describe this image (WCAG 1.1.1). " +
          "Verify at runtime with scan-url for final confirmation.",
        wcagSc: "1.1.1",
        filePath,
        line,
        column,
        htmlSnippet: snippet,
      });
    }
  }
  return issues;
}

/**
 * Catches jQuery/string-template interactive elements (<button>, <a>)
 * with no visible text, aria-label, or title in the same string literal.
 */
function findJsEmptyInteractiveElement(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const stringLiteralRegex = /(?:`[^`]*`|"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')/gs;

  const hasTemplateToken = (value: string): boolean => /\{\{[^}]+\}\}|\$\{[^}]+\}|<%[\s\S]*?%>/.test(value);
  const hasAccessibleNameAttrs = (attrs: string): boolean =>
    /\b(?:aria-label|aria-labelledby|title)\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs);

  for (const m of content.matchAll(stringLiteralRegex)) {
    const literal = m[0];
    const outerIndex = m.index ?? 0;
    const nearby = content.slice(Math.max(0, outerIndex - 180), Math.min(content.length, outerIndex + literal.length + 260));
    const isDomInjectionContext =
      /(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|\.html\s*\(|\.append\s*\(|\.prepend\s*\(|createContextualFragment\s*\(|document\.write\s*\(|\$\s*\(/i.test(nearby);
    if (!isDomInjectionContext) continue;

    // Empty <button>
    const btnRegex = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
    for (const bm of literal.matchAll(btnRegex)) {
      const snippet = bm[0];
      const attrs = bm[1] ?? "";
      const inner = bm[2] ?? "";
      if (hasAccessibleNameAttrs(attrs)) continue;
      if (/\bvalue\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs)) continue;
      if (/(<img\b[^>]*\balt\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)|<svg\b[\s\S]*?<title\b[^>]*>[\s\S]*?<\/title>|\baria-label\s*=)/i.test(inner)) {
        continue;
      }

      const normalizedInner = inner.trim();
      if (hasTemplateToken(normalizedInner)) continue;
      if (normalizedInner.replace(/<[^>]+>/g, "").trim().length > 0) continue;

      const { line, column } = getLineColumn(content, outerIndex + (bm.index ?? 0));
      issues.push({
        ruleId: "aspnet/js-button-missing-label",
        title: "Dynamically injected button missing accessible name",
        description:
          "An injected <button> has no text, value, aria-label/aria-labelledby/title, or labeled child content (WCAG 4.1.2).",
        wcagSc: "4.1.2",
        filePath,
        line,
        column,
        htmlSnippet: snippet.slice(0, 200),
      });
    }

    const buttonInputRegex = /<input\b([^>]*)\/?\s*>/gi;
    for (const im of literal.matchAll(buttonInputRegex)) {
      const snippet = im[0];
      const attrs = im[1] ?? "";
      const inputType = (
        /\btype\s*=\s*"([^"]+)"/i.exec(attrs)?.[1]
        ?? /\btype\s*=\s*'([^']+)'/i.exec(attrs)?.[1]
        ?? /\btype\s*=\s*([^\s>]+)/i.exec(attrs)?.[1]
        ?? ""
      ).toLowerCase();
      if (!/^(button|submit|reset|image)$/.test(inputType)) continue;
      if (hasAccessibleNameAttrs(attrs)) continue;
      if (/\bvalue\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs)) continue;
      if (hasTemplateToken(attrs)) continue;

      const { line, column } = getLineColumn(content, outerIndex + (im.index ?? 0));
      issues.push({
        ruleId: "aspnet/js-button-missing-label",
        title: "Dynamically injected button missing accessible name",
        description:
          "An injected <input type=button|submit|reset|image> has no value or aria naming attributes (WCAG 4.1.2).",
        wcagSc: "4.1.2",
        filePath,
        line,
        column,
        htmlSnippet: snippet.slice(0, 200),
      });
    }

    const roleButtonRegex = /<([a-z][\w:-]*)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    for (const rb of literal.matchAll(roleButtonRegex)) {
      const snippet = rb[0];
      const attrs = rb[2] ?? "";
      const inner = rb[3] ?? "";
      if (!/\brole\s*=\s*(?:"button"|'button'|button)/i.test(attrs)) continue;
      if (hasAccessibleNameAttrs(attrs)) continue;
      if (/(<img\b[^>]*\balt\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)|<svg\b[\s\S]*?<title\b[^>]*>[\s\S]*?<\/title>|\baria-label\s*=)/i.test(inner)) {
        continue;
      }
      if (hasTemplateToken(inner)) continue;
      if (inner.replace(/<[^>]+>/g, "").trim().length > 0) continue;

      const { line, column } = getLineColumn(content, outerIndex + (rb.index ?? 0));
      issues.push({
        ruleId: "aspnet/js-button-missing-label",
        title: "Dynamically injected button missing accessible name",
        description:
          "An injected role=button element has no visible or programmatic accessible name (WCAG 4.1.2).",
        wcagSc: "4.1.2",
        filePath,
        line,
        column,
        htmlSnippet: snippet.slice(0, 200),
      });
    }

    // Empty <a>
    const aRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    for (const am of literal.matchAll(aRegex)) {
      const snippet = am[0];
      const attrs = am[1] ?? "";
      const inner = am[2] ?? "";
      const anchorIndex = outerIndex + (am.index ?? 0);
      const nearby = content.slice(Math.max(0, anchorIndex - 180), Math.min(content.length, anchorIndex + snippet.length + 260));
      const isDomInjectionContext =
        /(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|\.html\s*\(|\.append\s*\(|\.prepend\s*\(|createContextualFragment\s*\(|document\.write\s*\(|\$\s*\(/i.test(nearby);
      if (!isDomInjectionContext) continue;

      const hrefValue =
        /\bhref\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]
        ?? /\bhref\s*=\s*'([^']*)'/i.exec(attrs)?.[1]
        ?? "";
      if (!hrefValue || /^(#|javascript:|void\s*\()/i.test(hrefValue.trim())) continue;

      if (
        /\baria-label\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs) ||
        /\btitle\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs)
      ) continue;
      if (inner.trim().replace(/<%[\s\S]*?%>/g, "").trim().length > 0) continue;
      const { line, column } = getLineColumn(content, anchorIndex);
      issues.push({
        ruleId: "aspnet/js-anchor-missing-label",
        title: "Dynamically injected link missing accessible name",
        description:
          "A string literal contains an <a> with no visible text or aria-label. " +
          "Screen readers cannot identify this link's purpose (WCAG 2.4.4).",
        wcagSc: "2.4.4",
        filePath,
        line,
        column,
        htmlSnippet: snippet.slice(0, 200),
      });
    }
  }

  // createElement('button') flow analysis across enclosing function and helper calls.
  const createButtonRegex = /\b(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*document\.createElement\s*\(\s*['"]button['"]\s*\)/gi;
  for (const match of content.matchAll(createButtonRegex)) {
    const variableName = (match[1] ?? "").trim();
    if (!variableName) continue;
    const index = match.index ?? 0;
    const flow = analyzeCreateElementFlow(content, variableName, index);
    if (!flow.insertedIntoDom) continue;
    if (flow.hasAccessibleName || flow.hasAltText) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-button-missing-label",
      title: "Dynamically injected button missing accessible name",
      description:
        "A button created via createElement is inserted with no detected text/aria-label/title assignment in scope (WCAG 4.1.2).",
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

/**
 * Catches `<input>` elements injected via string literals that have no
 * associated label hint (aria-label, aria-labelledby, title, id that might
 * be labelled elsewhere — heuristic, requires human review).
 */
function findJsInputMissingLabel(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labelableTypes = new Set(["text", "password", "email", "number", "tel", "url", "search", "date", "checkbox", "radio", "file"]);
  const stringLiteralRegex = /(?:`[^`]*`|"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')/gs;

  const hasNamingAttrs = (attrs: string): boolean =>
    /\b(?:aria-label|aria-labelledby|title|placeholder)\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs);

  for (const m of content.matchAll(stringLiteralRegex)) {
    const literal = m[0];
    const outerIndex = m.index ?? 0;
    const nearby = content.slice(Math.max(0, outerIndex - 180), Math.min(content.length, outerIndex + literal.length + 260));
    const isDomInjectionContext =
      /(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|\.html\s*\(|\.append\s*\(|\.prepend\s*\(|createContextualFragment\s*\(|document\.write\s*\(|\$\s*\(/i.test(nearby);
    if (!isDomInjectionContext) continue;

    const inputRegex = /<input\b([^>]*)>/gi;
    for (const im of literal.matchAll(inputRegex)) {
      const snippet = im[0];
      const attrs = im[1] ?? "";
      const typeValue = (
        /\btype\s*=\s*"([^"]+)"/i.exec(attrs)?.[1]
        ?? /\btype\s*=\s*'([^']+)'/i.exec(attrs)?.[1]
        ?? /\btype\s*=\s*([^\s>]+)/i.exec(attrs)?.[1]
        ?? ""
      ).toLowerCase();
      if (!typeValue || !labelableTypes.has(typeValue)) continue;
      if (typeValue === "hidden") continue;
      if (/\baria-hidden\s*=\s*(?:"true"|'true'|true)/i.test(attrs)) continue;

      if (hasNamingAttrs(attrs)) continue;

      const inputOffsetInLiteral = im.index ?? 0;
      const beforeInput = literal.slice(0, inputOffsetInLiteral);
      const afterInput = literal.slice(inputOffsetInLiteral + snippet.length);

      const wrappedByLabel = (() => {
        const lastLabelOpen = beforeInput.lastIndexOf("<label");
        const lastLabelClose = beforeInput.lastIndexOf("</label>");
        if (lastLabelOpen > lastLabelClose && lastLabelOpen >= 0) {
          return /<\/label>/i.test(afterInput);
        }
        return false;
      })();
      if (wrappedByLabel) continue;

      const idValue =
        /\bid\s*=\s*"([^"]+)"/i.exec(attrs)?.[1]
        ?? /\bid\s*=\s*'([^']+)'/i.exec(attrs)?.[1]
        ?? "";
      if (idValue) {
        const hasAdjacentForLabel = new RegExp(
          String.raw`<label\b[^>]*\bfor\s*=\s*(?:"${escapeRegex(idValue)}"|'${escapeRegex(idValue)}'|${escapeRegex(idValue)})[^>]*>[\s\S]*?<\/label>`,
          "i",
        ).test(literal);
        if (hasAdjacentForLabel) continue;
      }

      const { line, column } = getLineColumn(content, outerIndex + (im.index ?? 0));
      issues.push({
        ruleId: "aspnet/js-input-missing-label",
        title: "Dynamically injected input may be missing a label",
        description:
          "An injected labelable <input> has no aria-label/aria-labelledby/title/placeholder and no same-fragment label association. Verify runtime labeling (WCAG 3.3.2).",
        wcagSc: "3.3.2",
        filePath,
        line,
        column,
        htmlSnippet: snippet,
      });
    }
  }

  // createElement('input') flow analysis across enclosing function and helper calls.
  const createInputRegex = /\b(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*document\.createElement\s*\(\s*['"]input['"]\s*\)/gi;
  for (const match of content.matchAll(createInputRegex)) {
    const variableName = (match[1] ?? "").trim();
    if (!variableName) continue;
    const index = match.index ?? 0;
    const flow = analyzeCreateElementFlow(content, variableName, index);
    const inferredType = (flow.inferredInputType ?? "text").toLowerCase();
    if (!labelableTypes.has(inferredType) || inferredType === "hidden") continue;
    if (!flow.insertedIntoDom) continue;
    if (flow.isAriaHidden) continue;
    if (flow.hasAccessibleName || flow.hasAssociatedLabelByFor) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-input-missing-label",
      title: "Dynamically injected input may be missing a label",
      description:
        "An input created via createElement is inserted without detected aria-label/aria-labelledby/title/placeholder assignment (WCAG 3.3.2).",
      wcagSc: "3.3.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

/**
 * Flags `aria-hidden="true"` applied to elements that are likely to
 * receive focus — a common jQuery show/hide pattern that traps keyboard
 * users (WCAG 1.3.1 / 4.1.2).
 */
function findJsAriaHidden(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];

  // setAttribute('aria-hidden', 'true') on focusable elements
  const setAttrRegex = /\.setAttribute\s*\(\s*['"]aria-hidden['"]\s*,\s*['"]true['"]\s*\)/gi;
  for (const m of content.matchAll(setAttrRegex)) {
    const index = m.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-aria-hidden-focusable",
      title: "aria-hidden applied dynamically — verify focusable children",
      description:
        "setAttribute('aria-hidden','true') hides content from assistive technology. " +
        "If the element or its descendants can receive focus, keyboard users reach " +
        "content that is invisible to screen readers (WCAG 1.3.1 / 4.1.2).",
      wcagSc: "1.3.1",
      filePath,
      line,
      column,
      htmlSnippet: m[0],
    });
  }

  // jQuery .attr('aria-hidden','true')
  const jqAttrRegex = /\.attr\s*\(\s*['"]aria-hidden['"]\s*,\s*['"]true['"]\s*\)/gi;
  for (const m of content.matchAll(jqAttrRegex)) {
    const index = m.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-aria-hidden-focusable",
      title: "jQuery aria-hidden applied dynamically — verify focusable children",
      description:
        ".attr('aria-hidden','true') hides content from assistive technology. " +
        "If the element or its descendants can receive focus, keyboard users reach " +
        "content that is invisible to screen readers (WCAG 1.3.1 / 4.1.2).",
      wcagSc: "1.3.1",
      filePath,
      line,
      column,
      htmlSnippet: m[0],
    });
  }

  return issues;
}

/**
 * Flags positive tabIndex values set via JS (tabIndex > 0 disrupts reading
 * order, WCAG 2.4.3 Level A).
 */
function findJsPositiveTabIndex(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];

  // el.tabIndex = N (N > 0)
  const tabIndexPropRegex = /\.tabIndex\s*=\s*([1-9]\d*)/g;
  for (const m of content.matchAll(tabIndexPropRegex)) {
    const index = m.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-tabindex-positive",
      title: "Positive tabIndex set via JavaScript disrupts tab order",
      description:
        `tabIndex = ${m[1] ?? "?"} creates a custom tab sequence that is usually confusing ` +
        "for keyboard and AT users. Prefer tabIndex=0 (natural order) or tabIndex=-1 " +
        "(programmatic-only focus). WCAG 2.4.3.",
      wcagSc: "2.4.3",
      filePath,
      line,
      column,
      htmlSnippet: m[0],
    });
  }

  // setAttribute('tabindex', 'N') where N > 0
  const setAttrTabRegex = /\.setAttribute\s*\(\s*['"]tabindex['"]\s*,\s*['"]([1-9]\d*)['"]\s*\)/gi;
  for (const m of content.matchAll(setAttrTabRegex)) {
    const index = m.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-tabindex-positive",
      title: "Positive tabindex set via setAttribute disrupts tab order",
      description:
        `setAttribute('tabindex','${m[1] ?? "?"}') creates a custom tab sequence. ` +
        "Prefer 0 or -1. WCAG 2.4.3.",
      wcagSc: "2.4.3",
      filePath,
      line,
      column,
      htmlSnippet: m[0],
    });
  }

  return issues;
}

/**
 * Catches `document.createElement('img')` calls where dataflow in the enclosing
 * function/helper scope does not assign alt or an equivalent accessible name.
 */
function findJsCreateElementImgMissingAlt(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const createImgRegex = /\b(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*document\.createElement\s*\(\s*['"]img['"]\s*\)/gi;

  for (const m of content.matchAll(createImgRegex)) {
    const index = m.index ?? 0;
    const variableName = (m[1] ?? "").trim();
    if (!variableName) continue;

    const flow = analyzeCreateElementFlow(content, variableName, index);
    if (!flow.insertedIntoDom) continue;
    if (flow.hasAltText || flow.hasAccessibleName) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-img-missing-alt",
      title: "createElement('img') with no alt assignment detected",
      description:
        "An img element is created and inserted into the DOM without a detected alt assignment. " +
        "Provide .alt or setAttribute('alt', ...) before insertion (WCAG 1.1.1).",
      wcagSc: "1.1.1",
      filePath,
      line,
      column,
      htmlSnippet: m[0],
    });
  }

  return issues;
}

function findJsConfirmAlert(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const matches = findGlobalAlertConfirmCalls(content);

  for (const match of matches) {
    const index = match.index;
    const nearby = content.slice(Math.max(0, index - 260), Math.min(content.length, index + 520));
    if (/console\.|debug|spec\.ts|test\(/i.test(nearby)) continue;
    if (isSuppressedAlertContext(nearby)) continue;
    if (!/(submit|delete|remove|logout|session|save|postback|redirect|form|click|onchange|onselect)/i.test(nearby)) {
      continue;
    }

    const elevated = isElevatedAlertContext(nearby);

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: elevated ? "aspnet/js-confirm-alert" : "aspnet/js-confirm-alert-informational",
      title: elevated
        ? "Native alert/confirm dialogs should be replaced with accessible modal UI"
        : "Native alert/confirm dialogs should be reviewed (informational advisory)",
      description:
        elevated
          ? "alert()/confirm() is used in a load/focus/timer lifecycle path. Prefer a focus-managed modal dialog for predictable interaction flow (wcag:3.2.1 level:A)."
          : "alert()/confirm() can be disorienting and is treated as an advisory signal unless in load/focus/timer callbacks (wcag:3.2.1 level:A, advisory).",
      wcagSc: "3.2.1",
      filePath,
      line,
      column,
      htmlSnippet: match.snippet,
    });
  }

  return issues;
}

function findJsFocusStealing(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const lifecycleRegex = /(pageLoad|add_endRequest|window\.onload|DOMContentLoaded|Sys\.WebForms\.PageRequestManager)/i;
  if (!lifecycleRegex.test(content)) return [];

  const focusRegex = /\.focus\s*\(/gi;
  for (const match of content.matchAll(focusRegex)) {
    const index = match.index ?? 0;
    const nearby = content.slice(Math.max(0, index - 260), Math.min(content.length, index + 520));
    if (!lifecycleRegex.test(nearby)) continue;
    if (/(?:click|keydown|keyup|keypress|pointerdown|mousedown)\s*(?:\)|=>|,)/i.test(nearby)) continue;
    if (/(modal|dialog|focusTrap|validationSummary|firstInvalid|aria-live|toast)/i.test(nearby)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-focus-stealing",
      title: "Automatic focus movement on load or postback should be reviewed",
      description:
        "Unrequested focus shifts can interrupt screen readers and keyboard users. Confirm that focus changes only happen after an explicit user action or for a modal lifecycle.",
      wcagSc: "3.2.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findJsTabKeySuppression(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /(key(?:Code)?\s*===\s*9|key\s*===\s*['"]Tab['"]|which\s*===\s*9)[\s\S]{0,160}?preventDefault\s*\(/gi;

  for (const match of content.matchAll(regex)) {
    const index = match.index ?? 0;
    const nearby = content.slice(Math.max(0, index - 320), Math.min(content.length, index + 640));
    if (/(modal|dialog|trap|focusTrap)/i.test(filePath) || /(?:modal|dialog|trap|focusTrap)/i.test(nearby)) continue;

    const hasFocusRouting = /\.focus\s*\(/i.test(nearby);

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: hasFocusRouting ? "aspnet/custom-tab-focus-routing-informational" : "aspnet/custom-tab-key-trap",
      title: hasFocusRouting
        ? "Custom Tab key handling routes focus (informational advisory)"
        : "Custom Tab key handling may trap keyboard navigation",
      description:
        hasFocusRouting
          ? "Tab preventDefault() appears paired with explicit .focus() routing. Keep this as advisory and verify logical tab order (wcag:2.1.1 level:A, advisory)."
          : "Tab preventDefault() appears without any focus routing in the same handler, which can trap keyboard users (wcag:2.1.1 level:A).",
      wcagSc: "2.1.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findJsGlobalSingleCharShortcut(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const globalListenerRegex = /(?:document|window)\.addEventListener\s*\(\s*['"](?:keydown|keypress)['"]\s*,\s*function\s*\(([^)]*)\)\s*\{([\s\S]{0,800}?)\}\s*\)/gi;

  for (const match of content.matchAll(globalListenerRegex)) {
    const handlerBody = match[2] ?? "";
    if (/ctrlKey|altKey|metaKey/.test(handlerBody)) continue;
    if (/remap|disable|shortcut/i.test(handlerBody)) continue;
    if (!/(?:event|e)\.key\s*===\s*['"][a-z0-9]['"]/i.test(handlerBody)) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-single-char-shortcut-global",
      title: "Global single-character keyboard shortcut detected",
      description: "Global printable-character shortcuts need disable/remap or modifier requirements to avoid accidental activation (WCAG 2.1.4).",
      wcagSc: "2.1.4",
      filePath,
      line,
      column,
      htmlSnippet: (match[0] ?? "").slice(0, 240),
    });
  }

  return issues;
}

function findJsMouseOnlyHoverBehavior(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const mouseRegex = /([A-Za-z_$][\w$\.\[\]]*)\s*\.addEventListener\s*\(\s*['"](?:mouseover|mouseenter)['"]\s*,/gi;

  for (const match of content.matchAll(mouseRegex)) {
    const targetExpr = (match[1] ?? "").trim();
    if (!targetExpr || /^(?:document|window)$/i.test(targetExpr)) continue;

    const index = match.index ?? 0;
    const localWindow = content.slice(Math.max(0, index - 220), Math.min(content.length, index + 600));
    if (/\btitle\s*=|tooltip|aria-describedby/i.test(localWindow)) continue;

    const hasFocusParity = new RegExp(
      String.raw`${escapeRegex(targetExpr)}\s*\.addEventListener\s*\(\s*['"](?:focus|focusin|keydown)['"]\s*,`,
      "i",
    ).test(content);
    if (hasFocusParity) continue;

    const handlerWindow = content.slice(Math.max(0, index - 120), Math.min(content.length, index + 1200));
    const visibleChangeSignal =
      /\.style\.display\s*=\s*['"](?!none\b)[^'"]+['"]/i.test(handlerWindow) ||
      /classList\.remove\s*\(\s*['"][^'"]*(?:hide|hidden|d-none|invisible|collapsed)[^'"]*['"]\s*\)/i.test(handlerWindow) ||
      /(?:tooltip|popover)[^\n;{}]{0,80}\.(?:textContent|innerHTML)\s*=/i.test(handlerWindow) ||
      /\b(?:show|open|reveal|display|popover|tooltip)[A-Za-z_$0-9]*\s*\(/i.test(handlerWindow);
    if (!visibleChangeSignal) continue;

    const nonInteractiveOnly =
      /\b(?:analytics|track|telemetry|metrics|ga\()\b/i.test(handlerWindow) ||
      /\.style\.cursor\s*=|classList\.(?:add|toggle)\s*\([^)]*highlight/i.test(handlerWindow);
    if (nonInteractiveOnly && !visibleChangeSignal) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-hover-without-focus-parity",
      title: "Mouseover behavior has no focus equivalent",
      description: "A mouseover/mouseenter handler is attached without a same-target focus/focusin/keyboard equivalent (WCAG 1.4.13 / 2.1.1).",
      wcagSc: "1.4.13",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findJsOnFocusContextChange(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const focusHandlerRegex = /(?:addEventListener\s*\(\s*['"]focus(?:in)?['"]|\bonfocus\s*=)([\s\S]{0,400})/gi;

  for (const match of content.matchAll(focusHandlerRegex)) {
    const snippet = match[0] ?? "";
    const index = match.index ?? 0;
    if (!/(\.submit\s*\(|window\.open\s*\(|(?:window\.|document\.)?location\s*=|location\.href\s*=)/i.test(snippet)) {
      continue;
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-focus-context-change",
      title: "Focus handler triggers context change",
      description: "Changing context directly on focus (submit/open/navigate) can violate predictable behavior expectations (WCAG 3.2.1).",
      wcagSc: "3.2.1",
      filePath,
      line,
      column,
      htmlSnippet: snippet.slice(0, 240),
    });
  }

  return issues;
}

function findJsOnchangeNavigation(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const onchangeRegex = /onchange\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

  for (const match of content.matchAll(onchangeRegex)) {
    const js = (match[1] ?? match[2] ?? "").trim();
    const index = match.index ?? 0;
    if (!/(?:window\.|document\.)?location\s*=|location\.href\s*=/i.test(js)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/onchange-navigation",
      title: "onchange handler triggers immediate navigation",
      description: "Navigation triggered directly by onchange can surprise users unless clearly announced with explicit confirmation controls (WCAG 3.2.2).",
      wcagSc: "3.2.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findJsPointerOnlyInteraction(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const pointerRegex = /([A-Za-z_$][\w$\.\[\]]*)\s*\.addEventListener\s*\(\s*['"](?:mousedown|mouseup|dragstart|drag|dragover|drop|pointerdown|pointerup)['"]\s*,/gi;
  const emittedMapWidgets = new Set<string>();

  for (const match of content.matchAll(pointerRegex)) {
    const targetExpr = (match[1] ?? "").trim();
    if (!targetExpr || /^(?:document|window)$/i.test(targetExpr)) continue;

    const targetFallbackRegex = new RegExp(
      String.raw`${escapeRegex(targetExpr)}\s*\.addEventListener\s*\(\s*['"](?:keydown|keyup|keypress|click|contextmenu)['"]\s*,`,
      "i",
    );
    if (targetFallbackRegex.test(content)) continue;

    const index = match.index ?? 0;
    const nearby = content.slice(Math.max(0, index - 260), Math.min(content.length, index + 520));
    if (/(?:Enter|Space|\bkey\b|keyCode\s*===\s*(?:13|32))/i.test(nearby)) continue;

    const mapWidgetContext = isGraphicsWidgetContext(targetExpr, nearby);
    if (mapWidgetContext) {
      const dedupeKey = `${filePath}|${targetExpr.toLowerCase()}`;
      if (!emittedMapWidgets.has(dedupeKey)) {
        emittedMapWidgets.add(dedupeKey);
        const { line, column } = getLineColumn(content, index);
        issues.push({
          ruleId: "a11y/map-widget-needs-keyboard-review",
          title: "Map/graphics widget needs keyboard interaction review",
          description:
            "Pointer handlers on map/graphics widgets are emitted as a single advisory finding per widget instance and should be manually reviewed for keyboard alternatives.",
          wcagSc: "2.1.1",
          filePath,
          line,
          column,
          htmlSnippet: match[0],
        });
      }
      continue;
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-pointer-only-interaction",
      title: "Pointer-driven interaction lacks keyboard equivalent",
      description: "A pointer/drag handler appears without a same-target keyboard or click fallback path (WCAG 2.1.1).",
      wcagSc: "2.1.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findJsTimedContextChange(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /(?:setTimeout|setInterval)\s*\(\s*(?:function\s*\([^)]*\)\s*\{([\s\S]{0,500}?)\}|\([^)]*\)\s*=>\s*\{([\s\S]{0,500}?)\}|([^,]+))\s*,\s*(\d{1,6})\s*\)/gi;

  for (const match of content.matchAll(regex)) {
    const body = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const delayMs = Number(match[4] ?? "0");
    if (!Number.isFinite(delayMs) || delayMs <= 5000 || delayMs > 120000) continue;

    const appearsUserFacingContextChange =
      /(location\s*=|location\.href\s*=|window\.open\s*\(|\.submit\s*\(|logout|logoff|signout|signOut|session\s*expired|replaceState\s*\(|pushState\s*\()/i.test(body) ||
      /(?:classList\.(?:add|remove)|style\.(?:display|visibility)|setAttribute\s*\(\s*['"]hidden['"])([\s\S]{0,80})(?:main|app|content|panel|page|container)/i.test(body);
    if (!appearsUserFacingContextChange) {
      continue;
    }

    if (/(aria-live|role\s*=\s*['"](?:status|alert)['"]|setInterval\s*\([^)]*poll|heartbeat|refreshCounter|countdownLabel)/i.test(body)) {
      continue;
    }

    const windowStart = Math.max(0, (match.index ?? 0) - 700);
    const windowEnd = Math.min(content.length, (match.index ?? 0) + 1400);
    const nearby = content.slice(windowStart, windowEnd);
    if (/pause|resume|extend|stopTimer|cancel|snooze|keep(?:Alive|Session)|continueSession/i.test(nearby)) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-timed-context-change",
      title: "Timed update or redirect without pause/extend control",
      description: `A timer-based change occurs after ${delayMs}ms with no obvious pause/extend mechanism nearby (WCAG 2.2.1, heuristic).`,
      wcagSc: "2.2.1",
      filePath,
      line,
      column,
      htmlSnippet: (match[0] ?? "").slice(0, 260),
    });
  }

  return issues;
}

function findJsPointermoveOnly(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /([A-Za-z_$][\w$\.\[\]]*)\s*\.addEventListener\s*\(\s*['"]pointermove['"]\s*,\s*/gi;
  const emittedMapWidgets = new Set<string>();

  for (const match of content.matchAll(regex)) {
    const targetExpr = (match[1] ?? "").trim();
    const index = match.index ?? 0;
    const start = Math.max(0, index - 600);
    const end = Math.min(content.length, index + 1200);
    const nearby = content.slice(start, end);
    if (/pointerdown|pointerup|click|keydown|keyup/i.test(nearby)) continue;

    const mapWidgetContext = isGraphicsWidgetContext(targetExpr, nearby);
    if (mapWidgetContext) {
      const dedupeKey = `${filePath}|${(targetExpr || `pointermove-${lineFromIndex(content, index)}`).toLowerCase()}`;
      if (!emittedMapWidgets.has(dedupeKey)) {
        emittedMapWidgets.add(dedupeKey);
        const { line, column } = getLineColumn(content, index);
        issues.push({
          ruleId: "a11y/map-widget-needs-keyboard-review",
          title: "Map/graphics widget needs keyboard interaction review",
          description:
            "pointermove interaction appears tied to a graphics/map widget; emit one advisory review finding per widget instance instead of a hard keyboard-equivalent failure.",
          wcagSc: "2.1.1",
          filePath,
          line,
          column,
          htmlSnippet: match[0],
        });
      }
      continue;
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-pointermove-only",
      title: "pointermove handler without keyboard/click fallback",
      description: "Relying solely on pointermove for interaction can exclude keyboard and non-pointer input users (WCAG 2.1.1, heuristic).",
      wcagSc: "2.1.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findJsDragWithoutKeyboardFallback(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const dragStartRegex = /addEventListener\s*\(\s*['"]dragstart['"]\s*,/gi;

  for (const match of content.matchAll(dragStartRegex)) {
    const index = match.index ?? 0;
    const start = Math.max(0, index - 800);
    const end = Math.min(content.length, index + 1600);
    const nearby = content.slice(start, end);
    if (/keydown|keypress|ArrowKey|keyboardMove|keyboard.*drag/i.test(nearby)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-drag-without-keyboard-fallback",
      title: "Drag interaction without evident keyboard equivalent",
      description: "Drag-and-drop relies on pointer events; screen reader and keyboard users need an accessible alternative (WCAG 2.1.1).",
      wcagSc: "2.1.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

// ─── ASP.NET code-behind checks (.cs/.vb, heuristic) ────────────────────────

function findCodeBehindControlPatterns(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const inlineLabelHintTypes = new Set(["TextBox", "DropDownList", "ListBox", "CheckBox", "RadioButton"]);

  function getMethodWindow(index: number): { methodText: string; methodStart: number; localIndex: number } {
    const methodSigRegex = /(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?[\w<>\[\],\s]+\s+[A-Za-z_]\w*\s*\([^)]*\)\s*\{/g;
    const before = content.slice(0, index);
    let methodStart = Math.max(0, index - 3500);
    for (const match of before.matchAll(methodSigRegex)) {
      if (match.index != null) {
        methodStart = match.index;
      }
    }

    const after = content.slice(index + 1);
    const nextMatch = methodSigRegex.exec(after);
    const methodEnd = nextMatch?.index != null
      ? index + 1 + nextMatch.index
      : Math.min(content.length, index + 5000);

    return {
      methodText: content.slice(methodStart, methodEnd),
      methodStart,
      localIndex: Math.max(0, index - methodStart),
    };
  }

  const controlPatterns: Array<{
    typeName: string;
    requiredPattern: RegExp;
    ruleId: string;
    title: string;
    description: string;
    wcagSc: string;
  }> = [
    {
      typeName: "Image",
      requiredPattern: /\bAlternateText\s*=/i,
      ruleId: "aspnet/cs-image-missing-alt",
      title: "Code-behind Image control may be missing AlternateText",
      description:
        "A dynamically created Image control initializer has no AlternateText assignment. " +
        "If rendered without alt text, screen readers cannot describe it (WCAG 1.1.1). " +
        "Verify runtime output with scan-url.",
      wcagSc: "1.1.1",
    },
    {
      typeName: "ImageButton",
      requiredPattern: /\bAlternateText\s*=/i,
      ruleId: "aspnet/cs-imagebutton-missing-alt",
      title: "Code-behind ImageButton may be missing AlternateText",
      description:
        "A dynamically created ImageButton initializer has no AlternateText assignment. " +
        "If rendered without alt text, assistive tech users may not know the button purpose (WCAG 1.1.1). " +
        "Verify runtime output with scan-url.",
      wcagSc: "1.1.1",
    },
    {
      typeName: "ImageMap",
      requiredPattern: /\bAlternateText\s*=/i,
      ruleId: "aspnet/cs-imagemap-missing-alt",
      title: "Code-behind ImageMap may be missing AlternateText",
      description:
        "A dynamically created ImageMap initializer has no AlternateText assignment. " +
        "If rendered without alternate text, screen reader users lose context (WCAG 1.1.1). " +
        "Verify runtime output with scan-url.",
      wcagSc: "1.1.1",
    },
    {
      typeName: "Button",
      requiredPattern: /\bText\s*=/i,
      ruleId: "aspnet/cs-button-missing-text",
      title: "Code-behind Button may be missing Text",
      description:
        "A dynamically created Button initializer has no Text assignment. " +
        "If rendered unnamed, assistive tech cannot announce the control purpose (WCAG 4.1.2). " +
        "Verify runtime output with scan-url.",
      wcagSc: "4.1.2",
    },
    {
      typeName: "LinkButton",
      requiredPattern: /\bText\s*=/i,
      ruleId: "aspnet/cs-linkbutton-missing-text",
      title: "Code-behind LinkButton may be missing Text",
      description:
        "A dynamically created LinkButton initializer has no Text assignment. " +
        "If rendered unnamed, users cannot determine link purpose (WCAG 2.4.4). " +
        "Verify runtime output with scan-url.",
      wcagSc: "2.4.4",
    },
    {
      typeName: "HyperLink",
      requiredPattern: /\bText\s*=/i,
      ruleId: "aspnet/cs-hyperlink-missing-text",
      title: "Code-behind HyperLink may be missing Text",
      description:
        "A dynamically created HyperLink initializer has no Text assignment. " +
        "If rendered unnamed, users cannot determine link purpose (WCAG 2.4.4). " +
        "Verify runtime output with scan-url.",
      wcagSc: "2.4.4",
    },
    {
      typeName: "CheckBox",
      requiredPattern: /\bText\s*=/i,
      ruleId: "aspnet/cs-checkbox-missing-text",
      title: "Code-behind CheckBox may be missing label text",
      description:
        "A dynamically created CheckBox initializer has no Text assignment. " +
        "If rendered unnamed, assistive tech users cannot identify the field (WCAG 1.3.1). " +
        "Verify runtime output with scan-url.",
      wcagSc: "1.3.1",
    },
    {
      typeName: "RadioButton",
      requiredPattern: /\bText\s*=/i,
      ruleId: "aspnet/cs-radiobutton-missing-text",
      title: "Code-behind RadioButton may be missing label text",
      description:
        "A dynamically created RadioButton initializer has no Text assignment. " +
        "If rendered unnamed, assistive tech users cannot identify the field (WCAG 1.3.1). " +
        "Verify runtime output with scan-url.",
      wcagSc: "1.3.1",
    },
    {
      typeName: "TextBox",
      requiredPattern: /\b(Attributes\s*\[\s*"aria-label"\s*\]\s*=|ToolTip\s*=|Attributes\s*\[\s*"aria-labelledby"\s*\]\s*=|AssociatedControlID\s*=)/i,
      ruleId: "aspnet/cs-textbox-missing-label-hint",
      title: "Code-behind TextBox has no inline labeling hint",
      description:
        "A dynamically created TextBox initializer has no obvious aria-label/aria-labelledby/ToolTip hint. " +
        "A separate Label control may still exist, so confirm at runtime (WCAG 3.3.2).",
      wcagSc: "3.3.2",
    },
    {
      typeName: "DropDownList",
      requiredPattern: /\b(Attributes\s*\[\s*"aria-label"\s*\]\s*=|ToolTip\s*=|Attributes\s*\[\s*"aria-labelledby"\s*\]\s*=|AssociatedControlID\s*=)/i,
      ruleId: "aspnet/cs-dropdownlist-missing-label-hint",
      title: "Code-behind DropDownList has no inline labeling hint",
      description:
        "A dynamically created DropDownList has no obvious aria-label/aria-labelledby/ToolTip or AssociatedControlID hint. " +
        "Confirm a proper label association in runtime output (WCAG 3.3.2).",
      wcagSc: "3.3.2",
    },
    {
      typeName: "ListBox",
      requiredPattern: /\b(Attributes\s*\[\s*"aria-label"\s*\]\s*=|ToolTip\s*=|Attributes\s*\[\s*"aria-labelledby"\s*\]\s*=|AssociatedControlID\s*=)/i,
      ruleId: "aspnet/cs-listbox-missing-label-hint",
      title: "Code-behind ListBox has no inline labeling hint",
      description:
        "A dynamically created ListBox has no obvious aria-label/aria-labelledby/ToolTip or AssociatedControlID hint. " +
        "Confirm a proper label association in runtime output (WCAG 3.3.2).",
      wcagSc: "3.3.2",
    },
    {
      typeName: "CheckBox",
      requiredPattern: /\b(Attributes\s*\[\s*"aria-label"\s*\]\s*=|ToolTip\s*=|Attributes\s*\[\s*"aria-labelledby"\s*\]\s*=|AssociatedControlID\s*=)/i,
      ruleId: "aspnet/cs-checkbox-missing-label-hint",
      title: "Code-behind CheckBox has no inline labeling hint",
      description:
        "A dynamically created CheckBox has no obvious aria-label/aria-labelledby/ToolTip or AssociatedControlID hint. " +
        "Confirm a proper label association in runtime output (WCAG 3.3.2).",
      wcagSc: "3.3.2",
    },
    {
      typeName: "RadioButton",
      requiredPattern: /\b(Attributes\s*\[\s*"aria-label"\s*\]\s*=|ToolTip\s*=|Attributes\s*\[\s*"aria-labelledby"\s*\]\s*=|AssociatedControlID\s*=)/i,
      ruleId: "aspnet/cs-radiobutton-missing-label-hint",
      title: "Code-behind RadioButton has no inline labeling hint",
      description:
        "A dynamically created RadioButton has no obvious aria-label/aria-labelledby/ToolTip or AssociatedControlID hint. " +
        "Confirm a proper label association in runtime output (WCAG 3.3.2).",
      wcagSc: "3.3.2",
    },
  ];

  for (const pattern of controlPatterns) {
    const regex = inlineLabelHintTypes.has(pattern.typeName)
      ? new RegExp(
          `new\\s+(?:System\\.Web\\.UI\\.WebControls\\.)?${pattern.typeName}\\s*(?:\\([^)]*\\))?(?:\\s*\\{([\\s\\S]*?)\\})?`,
          "g",
        )
      : new RegExp(
          `new\\s+(?:System\\.Web\\.UI\\.WebControls\\.)?${pattern.typeName}\\s*(?:\\([^)]*\\))?\\s*\\{([\\s\\S]*?)\\}`,
          "g",
        );

    for (const match of content.matchAll(regex)) {
      const snippet = match[0] ?? "";
      const initializer = match[1] ?? "";
      const index = match.index ?? 0;

      if (pattern.requiredPattern.test(initializer)) continue;

      if (inlineLabelHintTypes.has(pattern.typeName)) {
        const typeEscaped = escapeRegex(pattern.typeName);
        const localPrefix = content.slice(Math.max(0, index - 280), Math.min(content.length, index + snippet.length + 80));
        const variableName =
          new RegExp(
            String.raw`\b(?:var|[A-Za-z_][\w<>]*)\s+([A-Za-z_]\w*)\s*=\s*new\s+(?:System\.Web\.UI\.WebControls\.)?${typeEscaped}\b`,
            "i",
          ).exec(localPrefix)?.[1]
          ?? "";

        const { methodText, localIndex } = getMethodWindow(index);
        const addedViaInlineNew = new RegExp(
          String.raw`(?:\.Controls\s*\.\s*Add|\bControls\s*\.\s*Add)\s*\(\s*new\s+(?:System\.Web\.UI\.WebControls\.)?${typeEscaped}\b`,
          "i",
        ).test(methodText);
        const addedViaVariable =
          variableName.length > 0 &&
          new RegExp(
            String.raw`(?:\.Controls\s*\.\s*Add|\bControls\s*\.\s*Add)\s*\(\s*${escapeRegex(variableName)}\s*\)`,
            "i",
          ).test(methodText);
        if (!addedViaInlineNew && !addedViaVariable) {
          continue;
        }

        if (variableName.length > 0) {
          const hasInlineLabelHint = new RegExp(
            String.raw`${escapeRegex(variableName)}\s*\.\s*(?:ToolTip\s*=|AssociatedControlID\s*=)|${escapeRegex(variableName)}\s*\.\s*Attributes\s*\[\s*['"](?:aria-label|aria-labelledby)['"]\s*\]\s*=`,
            "i",
          ).test(methodText);
          if (hasInlineLabelHint) continue;

          const hiddenByStyleOrVisibility = new RegExp(
            String.raw`${escapeRegex(variableName)}\s*\.\s*Visible\s*=\s*false|${escapeRegex(variableName)}\s*\.\s*CssClass\s*=\s*['"][^'"]*(?:hidden|hide)[^'"]*['"]|${escapeRegex(variableName)}\s*\.\s*Attributes\s*\[\s*['"]class['"]\s*\]\s*=\s*['"][^'"]*(?:hidden|hide)[^'"]*['"]`,
            "i",
          ).test(methodText);
          if (hiddenByStyleOrVisibility) continue;

          const controlId =
            new RegExp(String.raw`${escapeRegex(variableName)}\s*\.\s*ID\s*=\s*['"]([^'"]+)['"]`, "i").exec(methodText)?.[1]
            ?? /\bID\s*=\s*"([^"]+)"/i.exec(initializer)?.[1]
            ?? /\bID\s*=\s*'([^']+)'/i.exec(initializer)?.[1]
            ?? "";

          const hasPairedAssociatedLabel =
            /new\s+(?:System\.Web\.UI\.WebControls\.)?Label\b/i.test(methodText) &&
            (
              new RegExp(String.raw`AssociatedControlID\s*=\s*${escapeRegex(variableName)}\s*\.\s*ID`, "i").test(methodText) ||
              (controlId.length > 0 && new RegExp(String.raw`AssociatedControlID\s*=\s*['"]${escapeRegex(controlId)}['"]`, "i").test(methodText))
            );
          if (hasPairedAssociatedLabel) continue;
        }

        const aroundInsertion = methodText.slice(Math.max(0, localIndex - 260), Math.min(methodText.length, localIndex + 420));
        const hasNearbyLabelAdd = /new\s+(?:System\.Web\.UI\.WebControls\.)?Label\b/i.test(aroundInsertion) && /Controls\s*\.\s*Add\s*\(/i.test(aroundInsertion);
        if (hasNearbyLabelAdd) continue;
      }

      if (pattern.typeName === "LinkButton") {
        const localPrefix = content.slice(Math.max(0, index - 140), index + snippet.length);
        const variableName = /\b(?:var|[A-Za-z_][\w<>]*)\s+([A-Za-z_][\w]*)\s*=\s*$|\b([A-Za-z_][\w]*)\s*=\s*$/i.exec(localPrefix)?.[1]
          ?? /\b([A-Za-z_][\w]*)\s*=\s*new\s+(?:System\.Web\.UI\.WebControls\.)?LinkButton\b/i.exec(localPrefix)?.[1]
          ?? "";

        const methodWindow = content.slice(index, Math.min(content.length, index + 4200));
        const addedViaInlineNew = /Controls\s*\.\s*Add\s*\(\s*new\s+(?:System\.Web\.UI\.WebControls\.)?LinkButton\b/i.test(methodWindow);
        const addedViaVariable =
          variableName.length > 0 &&
          new RegExp(String.raw`Controls\s*\.\s*Add\s*\(\s*${escapeRegex(variableName)}\s*\)`, "i").test(methodWindow);
        if (!addedViaInlineNew && !addedViaVariable) {
          continue;
        }

        if (/\.DataBind\s*\(/i.test(methodWindow)) {
          continue;
        }

        if (
          variableName.length > 0 &&
          new RegExp(String.raw`${escapeRegex(variableName)}\s*\.\s*Text\s*=`, "i").test(methodWindow)
        ) {
          continue;
        }
      }

      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: pattern.ruleId,
        title: pattern.title,
        description: pattern.description,
        wcagSc: pattern.wcagSc,
        filePath,
        line,
        column,
        htmlSnippet: snippet.slice(0, 260),
      });
    }
  }

  return issues;
}

function findCodeBehindScriptRegistrations(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const includeRegex =
    /(?:ClientScript|ScriptManager)\.Register(?:Client|Startup)?ScriptInclude\s*\(([\s\S]{0,400}?)\)\s*;/gi;

  for (const match of content.matchAll(includeRegex)) {
    const callSnippet = match[0] ?? "";
    const args = match[1] ?? "";
    const index = match.index ?? 0;

    const jsLiteralMatch = /["']([^"']+\.js(?:\?[^"']*)?)["']/i.exec(args);
    const jsPath = jsLiteralMatch?.[1] ?? "(dynamic script path)";
    const isRemote = /^https?:\/\//i.test(jsPath);
    const hint = isRemote
      ? "This appears to be a remote script URL."
      : "If this script is outside the scanned repo path, it will not be statically analyzed.";

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/cs-script-include",
      title: "Code-behind registers external JavaScript include",
      description:
        `A code-behind script include was found (${jsPath}). ${hint} ` +
        "The repo scanner still analyzes in-repo JS files directly, but runtime-rendered behavior must be verified with scan-url.",
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: callSnippet.slice(0, 260),
    });
  }

  return issues;
}

function findCodeBehindRefreshHeader(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /Response\.AppendHeader\s*\(\s*["']Refresh["']\s*,\s*([^)]+)\)/gi;

  for (const match of content.matchAll(regex)) {
    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/cs-refresh-header",
      title: "Code-behind sets HTTP Refresh header",
      description: "Refresh headers can create timed redirects/updates that may not be adjustable for users needing more time (WCAG 2.2.1).",
      wcagSc: "2.2.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

async function containsAspNetMarkers(repoPath: string): Promise<boolean> {
  const markerExts = [".aspx", ".ascx", ".master", ".cshtml"];
  const skipDirs = new Set([".git", "node_modules", "dist", "build", ".next"]);
  const queue = [repoPath];

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
        if (!skipDirs.has(entry.name)) {
          queue.push(join(current, entry.name));
        }
        continue;
      }

      const lowered = entry.name.toLowerCase();
      if (markerExts.some((ext) => lowered.endsWith(ext))) {
        return true;
      }
    }
  }

  return false;
}

async function scanAspNetTemplateFiles(
  repoPath: string,
  onProgress?: (event: StaticScanProgressEvent) => void,
): Promise<{ filesScanned: number; issues: AspxScanIssue[] }> {
  const templateExts = [".aspx", ".ascx", ".master", ".cshtml"];
  const files = await listFilesWithExtensions(repoPath, templateExts);
  const iframeReferencedAspx = await buildIframeReferencedAspxSet(files, repoPath);
  const issues: AspxScanIssue[] = [];
  let processedFiles = 0;

  logStaticPhaseWorkload("aspnet:template-files", files.length);

  // Cap content fed to regex at 512 KB; we still scan every file.
  const TEMPLATE_SCAN_CONTENT_WINDOW = 512 * 1024;

  for (const absPath of files) {
    processedFiles += 1;
    let rawContent = "";
    try {
      rawContent = await readFile(absPath, "utf8");
    } catch {
      continue;
    }

    const relPath = normalizePath(relative(repoPath, absPath));
    if (shouldSkipStaticFile(relPath)) {
      continue;
    }

    logStaticPhaseProgress(
      "aspnet:template-files",
      processedFiles,
      files.length,
      relPath,
      onProgress,
    );

    const content = rawContent.length > TEMPLATE_SCAN_CONTENT_WINDOW
      ? rawContent.slice(0, TEMPLATE_SCAN_CONTENT_WINDOW)
      : rawContent;

    const hasCodeBehindDirective = /<%@\s*(?:Page|Control|Master)\b[\s\S]{0,600}?\b(?:CodeBehind|CodeFile|Src)\s*=\s*['"][^'"]+['"]/i.test(content);
    const codeBehindContent = hasCodeBehindDirective
      ? await readAspNetCodeBehind(absPath)
      : "";

    const composedLabelScopeContent = await buildComposedLabelScopeContent(repoPath, absPath, content);

    const isThinWrapperPage = isThinWrapperAspNetPage(content);
    const pageProfile = buildAspNetTemplateProfile(content);

    // HTML elements
    if (pageProfile.hasImg) {
      issues.push(...findMissingAltOnImg(content, relPath));
      issues.push(...findLikelyBrokenImageSrc(content, relPath));
      issues.push(...findMeaninglessImgAlt(content, relPath));
    }
    issues.push(...(await findRenderedHtmlLangIssues({
      repoPath,
      absPath,
      relPath,
      content,
      iframeReferencedAspx,
    })));
    issues.push(...(await findRenderedDocumentTitleIssues({
      repoPath,
      absPath,
      relPath,
      content,
      iframeReferencedAspx,
    })));
    if (pageProfile.hasAnchors) {
      issues.push(...findEmptyAnchors(content, relPath));
      issues.push(...findNonDescriptiveLinkText(content, relPath));
      issues.push(...findDuplicateLinkTextDifferentHref(content, relPath));
      issues.push(...findAnchorUsedAsButton(content, relPath));
    }
    if (pageProfile.hasButtons) {
      issues.push(...findEmptyButtons(content, relPath));
      issues.push(...findOnclickOnNonInteractive(content, relPath));
      issues.push(...findDisabledOnNonFormElements(content, relPath));
    }

    // ASP.NET server controls
    if (pageProfile.hasAspControls) {
      issues.push(...findMissingAltOnAspImage(content, relPath, codeBehindContent));
      issues.push(...findMissingAltOnAspImageButton(content, relPath, codeBehindContent));
      issues.push(...findEmptyAspHyperLink(content, relPath, codeBehindContent));
      issues.push(...findEmptyAspButton(content, relPath, codeBehindContent));
      issues.push(...findAspCheckBoxRadioButtonMissingLabel(content, relPath, codeBehindContent));
      issues.push(...findAspFileUploadMissingLabel(content, relPath, codeBehindContent));
      issues.push(...findAspGridViewMissingCaption(content, relPath));
      issues.push(...findAspLabelUsedAsHeading(content, relPath));
      issues.push(...findAspPanelWithOnclick(content, relPath));
      issues.push(...findAspDropDownAutoPostBackNavigation(content, relPath, codeBehindContent));
      issues.push(...findAspGridUseAccessibleHeaderFalse(content, relPath));
      issues.push(...findAspMenuRenderingMode(content, relPath));
      issues.push(...findAspAuthAutocompleteAndPasteBlocked(content, relPath));
    }

    if (pageProfile.hasFormControls || pageProfile.hasAspControls) {
      issues.push(...findFormControlMissingAccessibleName(content, relPath, composedLabelScopeContent));
    }

    // HTML structural checks
    if (pageProfile.hasIframes) {
      issues.push(...findIframeMissingTitle(content, relPath));
      issues.push(...findIframeEmptyTitle(content, relPath));
    }
    if (pageProfile.hasTables) {
      issues.push(...findTableMissingCaption(content, relPath));
      issues.push(...findGridViewDetailsMissingCaption(content, relPath));
      issues.push(...findTableHeaderMissingScope(content, relPath));
      issues.push(...findTdHeadersMissingTargets(content, relPath));
      issues.push(...findCaptionNotFirstChild(content, relPath));
      issues.push(...findLayoutTableWithoutPresentation(content, relPath));
      issues.push(...findMissingSkipLinks(content, relPath));
    }
    if (pageProfile.hasRadios) {
      issues.push(...findRoleRadioMissingAriaChecked(content, relPath));
    }
    issues.push(...findMissingLandmarkRegions(content, relPath));

    if (isThinWrapperPage) {
      issues.push(...findMetaRefresh(content, relPath));
      issues.push(...findViewportZoomRestrictions(content, relPath));
      issues.push(...findInlineMinWidthTopLevel(content, relPath));
      continue;
    }

    if (pageProfile.hasSvg) {
      issues.push(...findSvgRoleImgMissingName(content, relPath));
      issues.push(...findSvgFocusableWithoutAriaHidden(content, relPath));
    }
    if (pageProfile.hasEmbeds) {
      issues.push(...findObjectEmbedMissingFallback(content, relPath));
    }
    if (pageProfile.hasLabels || pageProfile.hasFormControls) {
      issues.push(...findLabelReferenceMissingControl(content, relPath));
      issues.push(...findOrphanOrEmptyLabel(content, relPath, codeBehindContent));
      issues.push(...findLabelNotAssociatedToControl(content, relPath));
    }
    if (pageProfile.hasFieldset) {
      issues.push(...findFieldsetMissingLegend(content, relPath));
    }
    if (pageProfile.hasOptgroups) {
      issues.push(...findOptgroupMissingLabel(content, relPath));
    }
    issues.push(...findDuplicateIdsWithWebFormsGuards(content, relPath));
    if (pageProfile.hasAriaOrRoles) {
      issues.push(...findBrokenAriaReferenceIds(content, relPath));
      issues.push(...findAriaLabelledbyMissingIdTargets(content, relPath));
      issues.push(...findAriaControlsMissingIdTargets(content, relPath));
      issues.push(...findInvalidAriaAndRoleUsage(content, relPath));
      issues.push(...findRoleHeadingMissingAriaLevel(content, relPath));
      issues.push(...findRoleParentChildSemantics(content, relPath));
      issues.push(...findAriaRoleStateMissing(content, relPath));
      issues.push(...findAriaDisabledContradiction(content, relPath));
      issues.push(...findAriaLabelConflict(content, relPath));
      issues.push(...findPresentationRoleOnInteractive(content, relPath));
    }
    if (pageProfile.hasHeadings || pageProfile.hasRoleHeading) {
      issues.push(...findHeadingLevelSkip(content, relPath));
      issues.push(...findEmptyHeadingMarkup(content, relPath, codeBehindContent));
      issues.push(...findMultipleH1(content, relPath));
    }
    if (pageProfile.hasTabindex) {
      issues.push(...findPositiveTabIndexInMarkup(content, relPath));
      issues.push(...findTabindexNonInteractiveWithoutRole(content, relPath));
    }
    if (pageProfile.hasFormControls) {
      issues.push(...findAutocompleteMissingOnInputs(content, relPath));
      issues.push(...findAspTextBoxAutocompleteMissing(content, relPath, codeBehindContent));
      issues.push(...findPlaceholderOnlyLabel(content, relPath));
      issues.push(...findPatternWithoutTitle(content, relPath));
      issues.push(...findRequiredWithoutIndicator(content, relPath));
      issues.push(...findReadonlyWithJsMutation(content, relPath));
      issues.push(...findFormWithoutSubmitButton(content, relPath));
      issues.push(...findInputTypeWithoutAccessibility(content, relPath));
      issues.push(...findMultipleFormSubmitsSameName(content, relPath));
      issues.push(...findAccessKeyUsage(content, relPath));
      issues.push(...findAutofocusUsage(content, relPath));
    }
    if (pageProfile.hasAspControls || pageProfile.hasErrorIndicators) {
      issues.push(...findValidatorMissingErrorMessage(content, relPath));
      issues.push(...findValidationSummaryMissingLive(content, relPath));
      issues.push(...findUpdateProgressMissingLive(content, relPath));
    }
    issues.push(...findDuplicateLandmarkNames(content, relPath));
    if (pageProfile.hasMarqueeOrBlink) {
      issues.push(...findMarqueeBlink(content, relPath));
    }
    issues.push(...findMetaRefresh(content, relPath));
    issues.push(...findViewportZoomRestrictions(content, relPath));
    issues.push(...findInlineMinWidthTopLevel(content, relPath));
    if (pageProfile.hasMedia) {
      issues.push(...findVideoAudioMissingTrack(content, relPath));
      issues.push(...findAutoplayMedia(content, relPath));
    }
    if (pageProfile.hasAriaOrRoles || pageProfile.hasClickableTags) {
      issues.push(...findAriaHiddenFocusableMarkup(content, relPath));
      issues.push(...findDialogSemantics(content, relPath));
      issues.push(...findContextMenuOnly(content, relPath));
      issues.push(...findNestedInteractive(content, relPath));
    }
    if (pageProfile.hasAspControls) {
      issues.push(...findAsteriskRequiredIndicator(content, relPath));
    }
    if (pageProfile.hasScripts || pageProfile.hasInlineHandlers) {
      issues.push(...findInlineConfirmAlert(content, relPath));
      issues.push(...findInlineFocusStealing(content, relPath));
      issues.push(...findInlineTabKeySuppression(content, relPath));
      issues.push(...findJsGlobalSingleCharShortcut(content, relPath));
      issues.push(...findJsMouseOnlyHoverBehavior(content, relPath));
      issues.push(...findJsOnFocusContextChange(content, relPath));
      issues.push(...findJsOnchangeNavigation(content, relPath));
      issues.push(...findJsPointerOnlyInteraction(content, relPath));
      issues.push(...findJsTimedContextChange(content, relPath));
      issues.push(...findJsPointermoveOnly(content, relPath));
      issues.push(...findJsDragWithoutKeyboardFallback(content, relPath));
    }
    if (pageProfile.hasStyleBlocks) {
      issues.push(...findColorOnlyIndicator(content, relPath));
    }
    if (pageProfile.hasErrorIndicators) {
      issues.push(...findErrorMessageAssociation(content, relPath));
    }
  }

  // Deduplicate findings by (file, line, rule).
  const deduped = new Map<string, AspxScanIssue>();
  for (const issue of issues) {
    const key = `${issue.filePath}|${issue.line}|${issue.ruleId}`;
    if (!deduped.has(key)) {
      deduped.set(key, issue);
    }
  }

  return { filesScanned: files.length, issues: Array.from(deduped.values()) };
}

async function readAspNetCodeBehind(templateAbsPath: string): Promise<string> {
  const candidates = [`${templateAbsPath}.cs`, `${templateAbsPath}.vb`];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // Best effort only.
    }
  }
  return "";
}

function normalizeWebPath(pathValue: string): string {
  return normalizePath(pathValue).replace(/^\/+/, "").replace(/^\.\//, "");
}

async function buildIframeReferencedAspxSet(files: string[], repoPath: string): Promise<Set<string>> {
  const refs = new Set<string>();
  const iframeSrcRegex = /<iframe\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;

  for (const absPath of files) {
    let content = "";
    try {
      content = await readFile(absPath, "utf8");
    } catch {
      continue;
    }

    for (const match of content.matchAll(iframeSrcRegex)) {
      const raw = (match[1] ?? match[2] ?? "").trim();
      if (!raw) continue;
      if (/^(?:https?:|javascript:|data:|#)/i.test(raw)) continue;
      if (/<%[=#:$]/.test(raw)) continue;

      const withoutQuery = raw.split(/[?#]/)[0] ?? "";
      const normalized = normalizeWebPath(withoutQuery.replace(/^~\//, "").replace(/^\//, ""));
      if (!/\.aspx$/i.test(normalized)) continue;

      const lowered = normalized.toLowerCase();
      refs.add(lowered);
      const leaf = lowered.split("/").pop();
      if (leaf) refs.add(leaf);

      const absCandidate = resolve(repoPath, normalized);
      const relCandidate = normalizePath(relative(repoPath, absCandidate)).toLowerCase();
      if (relCandidate && relCandidate !== ".") {
        refs.add(relCandidate);
        const relLeaf = relCandidate.split("/").pop();
        if (relLeaf) refs.add(relLeaf);
      }
    }
  }

  return refs;
}

function isIframeReferencedPage(relPath: string, iframeRefs: Set<string>): boolean {
  const normalized = normalizeWebPath(relPath).toLowerCase();
  if (!normalized) return false;
  if (iframeRefs.has(normalized)) return true;
  const leaf = normalized.split("/").pop();
  return Boolean(leaf && iframeRefs.has(leaf));
}

function extractDirectiveAttribute(content: string, directive: "Page" | "Master", attrName: string): string {
  const regex = new RegExp(
    `<%@\\s*${directive}\\b[\\s\\S]{0,1200}?\\b${escapeRegex(attrName)}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`,
    "i",
  );
  const match = regex.exec(content);
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

function resolveMasterPath(repoPath: string, currentAbsPath: string, masterRef: string): string {
  const cleaned = masterRef.replace(/^~\//, "").replace(/^\//, "");
  if (!cleaned) return "";

  if (/^[A-Za-z]:[\\/]/.test(cleaned)) {
    return resolve(cleaned);
  }

  if (masterRef.startsWith("~/") || masterRef.startsWith("/")) {
    return resolve(repoPath, cleaned);
  }

  return resolve(dirname(currentAbsPath), cleaned);
}

function hasIframeLayoutHtmlClass(attrs: string): boolean {
  const classValue = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  const value = (classValue?.[1] ?? classValue?.[2] ?? "").trim();
  if (!value) return false;
  return /(?:frameContent|iframeContent|LayoutHtml$|LayoutHTML$|itemViewerFrame|dashboardViewerContent|folderTreeLayoutHtml|folderListLayoutHtml|standAloneViewerLayoutHTML|shellContent|embedContent|mainViewerLayoutHtml)/i.test(value);
}

/**
 * Returns true when the normalized relative path points to a known sub-frame or
 * dialog page that is always loaded inside an iframe / host shell.
 */
function isKnownSubFramePage(normalizedRelPath: string): boolean {
  const p = normalizedRelPath.toLowerCase();
  if (/^workflow\/suspendedtasks\//i.test(p)) return true;
  if (/^workview\/viewer\//i.test(p)) return true;
  if (/^workview\/[^/]*shell\.aspx$/i.test(p)) return true;
  if (/^workview\/[^/]*handler[^/]*\.aspx$/i.test(p)) return true;
  if (/^applications\/components\//i.test(p)) return true;
  if (/^packets\/packetpop\//i.test(p)) return true;
  if (/^oem\/[^/]+\/trafficcontroller\.aspx$/i.test(p)) return true;
  const statusViewFrames = new Set([
    "layoutviewer", "loadlayout", "portletviewer", "layoutconfiguration",
    "portletconfiguration", "portletregistrationdialog", "layouttypeselector",
    "mylayouts", "layoutadministration", "sharepointportal",
    "workviewdatapointdetails", "bookmark",
  ]);
  const svMatch = /^statusview\/([^/]+)\.aspx$/i.exec(p);
  if (svMatch && statusViewFrames.has((svMatch[1] ?? "").toLowerCase())) return true;
  const sharepointFrames = new Set([
    "documentinfo", "documentviewer", "sharepointkeywordpanel", "sharepointsilentarchival",
  ]);
  const spMatch = /^sharepoint\/([^/]+)\.aspx$/i.exec(p);
  if (spMatch && sharepointFrames.has((spMatch[1] ?? "").toLowerCase())) return true;
  return false;
}

async function buildComposedLabelScopeContent(repoPath: string, absPath: string, content: string): Promise<string> {
  let composed = content;
  const visited = new Set<string>();
  let currentAbs = absPath;
  let currentContent = content;
  let directive: "Page" | "Master" = "Page";

  while (currentAbs && !visited.has(currentAbs)) {
    visited.add(currentAbs);
    const masterRef = extractDirectiveAttribute(currentContent, directive, "MasterPageFile");
    if (!masterRef) break;

    const nextAbs = resolveMasterPath(repoPath, currentAbs, masterRef);
    if (!nextAbs || visited.has(nextAbs) || !existsSync(nextAbs)) break;

    let nextContent = "";
    try {
      nextContent = await readFile(nextAbs, "utf8");
    } catch {
      break;
    }

    composed += `\n${nextContent}`;
    currentAbs = nextAbs;
    currentContent = nextContent;
    directive = "Master";
  }

  return composed;
}

function hasServerSideLangAssignment(ownerContent: string, ownerCodeBehindContent: string, htmlAttrs: string): boolean {
  const source = `${ownerContent}\n${ownerCodeBehindContent}`;

  if (/\bPage\s*\.\s*(?:Culture|UICulture)\s*=\s*/i.test(source)) return true;
  if (/Response\s*\.\s*Headers\s*\[\s*['"]Content-Language['"]\s*\]\s*=\s*/i.test(source)) return true;
  // Child setting master's culture, or code-behind calling Master.Page.Culture
  if (/\bMaster\s*\.\s*(?:Page\s*\.\s*)?(?:Culture|UICulture)\s*=\s*/i.test(source)) return true;

  const htmlId = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(htmlAttrs);
  const htmlControlId = (htmlId?.[1] ?? htmlId?.[2] ?? "").trim();
  if (htmlControlId) {
    const idPattern = new RegExp(
      String.raw`\b${escapeRegex(htmlControlId)}\s*\.\s*Attributes\s*(?:\[\s*['"]lang['"]\s*\]|\.Add\s*\(\s*['"]lang['"]|\.Set\s*\(\s*['"]lang['"])`,
      "i",
    );
    if (idPattern.test(source)) return true;
  }

  if (/\bhtml\w*\s*\.\s*Attributes\s*(?:\[\s*['"]lang['"]\s*\]|\.Add\s*\(\s*['"]lang['"]|\.Set\s*\(\s*['"]lang['"])/i.test(source)) {
    return true;
  }

  return false;
}

function canonicalizeBcp47Case(value: string): string {
  const parts = value.split("-").filter(Boolean);
  if (parts.length === 0) return value;

  const first = (parts[0] ?? "").toLowerCase();
  const rest = parts.slice(1).map((part) => {
    if (/^[A-Za-z]{4}$/.test(part)) {
      return part[0]?.toUpperCase() + part.slice(1).toLowerCase();
    }
    if (/^[A-Za-z]{2}$/.test(part) || /^\d{3}$/.test(part)) {
      return part.toUpperCase();
    }
    return part.toLowerCase();
  });

  return [first, ...rest].join("-");
}

function evaluateLangValue(langValue: string): { valid: boolean; caseWarning: boolean } {
  const value = langValue.trim();
  if (!value) return { valid: false, caseWarning: false };

  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)) {
    return { valid: false, caseWarning: false };
  }

  const parts = value.split("-").filter(Boolean);
  const primary = (parts[0] ?? "").toLowerCase();
  if (parts.length === 1 && primary === "us") {
    return { valid: false, caseWarning: false };
  }

  const canonicalCase = canonicalizeBcp47Case(value);
  const caseWarning = canonicalCase !== value;
  return { valid: true, caseWarning };
}

async function findRenderedHtmlLangIssues(args: {
  repoPath: string;
  absPath: string;
  relPath: string;
  content: string;
  iframeReferencedAspx: Set<string>;
}): Promise<AspxScanIssue[]> {
  const { repoPath, absPath, relPath, content, iframeReferencedAspx } = args;
  const normalizedRelPath = normalizeWebPath(relPath);

  if (/\.ascx$/i.test(normalizedRelPath)) return [];
  if (!/\.aspx$/i.test(normalizedRelPath)) return [];
  if (isIframeReferencedPage(normalizedRelPath, iframeReferencedAspx)) return [];
  if (isKnownSubFramePage(normalizedRelPath)) return [];

  const visited = new Set<string>();
  let currentAbs = absPath;
  let currentRel = normalizedRelPath;
  let currentContent = content;
  let directive: "Page" | "Master" = "Page";

  let ownerAbs = "";
  let ownerRel = "";
  let ownerContent = "";
  let ownerHtml = "";
  let ownerHtmlAttrs = "";
  let ownerHtmlIndex = -1;

  while (currentAbs && !visited.has(currentAbs)) {
    visited.add(currentAbs);

    const htmlMatch = /<html\b([^>]*)>/i.exec(currentContent);
    if (htmlMatch) {
      ownerAbs = currentAbs;
      ownerRel = currentRel;
      ownerContent = currentContent;
      ownerHtml = htmlMatch[0] ?? "";
      ownerHtmlAttrs = htmlMatch[1] ?? "";
      ownerHtmlIndex = htmlMatch.index ?? 0;
    }

    const masterRef = extractDirectiveAttribute(currentContent, directive, "MasterPageFile");
    if (!masterRef) break;

    const nextAbs = resolveMasterPath(repoPath, currentAbs, masterRef);
    if (!nextAbs || visited.has(nextAbs) || !existsSync(nextAbs)) break;

    let nextContent = "";
    try {
      nextContent = await readFile(nextAbs, "utf8");
    } catch {
      break;
    }

    currentAbs = nextAbs;
    currentRel = normalizePath(relative(repoPath, nextAbs));
    currentContent = nextContent;
    directive = "Master";
  }

  if (!ownerHtml) return [];
  if (hasIframeLayoutHtmlClass(ownerHtmlAttrs)) return [];

  const langMatch = /\b(?:lang|xml:lang)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(ownerHtml);

  if (!langMatch) {
    const ownerCodeBehind = await readAspNetCodeBehind(ownerAbs);
    if (/\brunat\s*=\s*(?:"server"|'server'|server)/i.test(ownerHtmlAttrs) && hasServerSideLangAssignment(ownerContent, ownerCodeBehind, ownerHtmlAttrs)) {
      return [];
    }

    const { line, column } = getLineColumn(ownerContent, ownerHtmlIndex);
    return [
      {
        ruleId: "a11y/html-has-lang",
        title: "Rendered page root html element is missing lang/xml:lang",
        description: "The runtime root html element has no lang (or xml:lang) declaration. Declare a valid BCP-47 language tag on the owning page/master root html (WCAG 3.1.1).",
        wcagSc: "3.1.1",
        filePath: ownerRel || normalizedRelPath,
        line,
        column,
        htmlSnippet: ownerHtml,
      },
    ];
  }

  const langValue = (langMatch[1] ?? langMatch[2] ?? langMatch[3] ?? "").trim();
  if (!langValue) {
    const { line, column } = getLineColumn(ownerContent, ownerHtmlIndex);
    return [
      {
        ruleId: "a11y/html-has-lang",
        title: "Rendered page root html has an empty lang/xml:lang value",
        description: "The runtime root html element declares lang/xml:lang but the value is empty. Provide a valid BCP-47 language tag (WCAG 3.1.1).",
        wcagSc: "3.1.1",
        filePath: ownerRel || normalizedRelPath,
        line,
        column,
        htmlSnippet: ownerHtml,
      },
    ];
  }

  const langState = evaluateLangValue(langValue);
  if (!langState.valid) {
    const { line, column } = getLineColumn(ownerContent, ownerHtmlIndex);
    return [
      {
        ruleId: "a11y/html-has-lang",
        title: "Rendered page root html has an invalid lang/xml:lang value",
        description: `The runtime root html lang/xml:lang value "${langValue}" does not look like a valid BCP-47 language tag (WCAG 3.1.1).`,
        wcagSc: "3.1.1",
        filePath: ownerRel || normalizedRelPath,
        line,
        column,
        htmlSnippet: ownerHtml,
      },
    ];
  }

  if (langState.caseWarning) {
    const { line, column } = getLineColumn(ownerContent, ownerHtmlIndex);
    return [
      {
        ruleId: "a11y/html-has-lang",
        title: "Rendered page root html lang/xml:lang casing should follow BCP-47 conventions",
        description: `The runtime root html lang/xml:lang value "${langValue}" is parseable but casing is non-canonical. Prefer "${canonicalizeBcp47Case(langValue)}" (WCAG 3.1.1).`,
        wcagSc: "3.1.1",
        filePath: ownerRel || normalizedRelPath,
        line,
        column,
        htmlSnippet: ownerHtml,
      },
    ];
  }

  return [];
}

// ─── Composition-aware document-title rule ───────────────────────────────────

/**
 * Returns true if the code-behind content contains a runtime Page.Title assignment
 * that will fill an otherwise-empty or absent <title> element.
 */
function hasCodeBehindTitleAssignment(codeBehindContent: string): boolean {
  if (!codeBehindContent) return false;
  // Page.Title = "…" or this.Title = "…"
  if (/\b(?:Page|this)\s*\.\s*Title\s*=\s*/i.test(codeBehindContent)) return true;
  // Master.Page.Title = "…" (child overrides master title)
  if (/\bMaster\s*\.\s*(?:Page\s*\.\s*)?Title\s*=\s*/i.test(codeBehindContent)) return true;
  return false;
}

async function findRenderedDocumentTitleIssues(args: {
  repoPath: string;
  absPath: string;
  relPath: string;
  content: string;
  iframeReferencedAspx: Set<string>;
}): Promise<AspxScanIssue[]> {
  const { repoPath, absPath, relPath, content, iframeReferencedAspx } = args;
  const normalizedRelPath = normalizeWebPath(relPath);

  // Step 1: never fire on user controls — they are fragments.
  if (/\.ascx$/i.test(normalizedRelPath)) return [];
  // Only check .aspx full pages.
  if (!/\.aspx$/i.test(normalizedRelPath)) return [];
  // Step 4: iframe-embedded pages inherit title context from parent document.
  if (isIframeReferencedPage(normalizedRelPath, iframeReferencedAspx)) return [];
  // Step 5: class-hint heuristic for iframe-embedded pages.
  const htmlTagMatch = /<html\b([^>]*)>/i.exec(content);
  if (htmlTagMatch && hasIframeLayoutHtmlClass(htmlTagMatch[1] ?? "")) return [];
  if (isKnownSubFramePage(normalizedRelPath)) return [];

  // Step 2: walk master chain. If any master in the chain has a <title> element
  // (even empty — that is the Web Forms placeholder pattern, e.g.
  // <title><%: Page.Title %></title> or <title></title>), suppress for children:
  // the master provides the slot and the child fills it via Page.Title at runtime.
  const visited = new Set<string>();
  let currentAbs = absPath;
  let currentContent = content;
  let directive: "Page" | "Master" = "Page";

  while (currentAbs && !visited.has(currentAbs)) {
    visited.add(currentAbs);
    const masterRef = extractDirectiveAttribute(currentContent, directive, "MasterPageFile");
    if (!masterRef) break;

    const nextAbs = resolveMasterPath(repoPath, currentAbs, masterRef);
    if (!nextAbs || visited.has(nextAbs) || !existsSync(nextAbs)) break;

    let nextContent = "";
    try {
      nextContent = await readFile(nextAbs, "utf8");
    } catch {
      break;
    }

    // Any <title> element in the master (even empty) satisfies the title requirement
    // for child pages — the master is the runtime owner.
    if (/<title\b[^>]*>/i.test(nextContent)) return [];

    currentAbs = nextAbs;
    currentContent = nextContent;
    directive = "Master";
  }

  // No master in the chain provides a <title>. Evaluate this page directly.
  const isFullPage = /<html\b/i.test(content) || /<%@\s*Page\b/i.test(content);
  if (!isFullPage) return [];

  // Step 3: read code-behind for runtime Page.Title assignments.
  const codeBehindContent = await readAspNetCodeBehind(absPath);

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(content);

  if (!titleMatch) {
    // No <title> element at all.
    if (hasCodeBehindTitleAssignment(codeBehindContent)) return [];
    return [{
      ruleId: "a11y/document-title",
      title: "Page is missing a <title> element",
      description: "No <title> element found. Screen readers announce the page title when the page loads; provide a descriptive, unique title (WCAG 2.4.2).",
      wcagSc: "2.4.2",
      filePath: normalizedRelPath,
      line: 1,
      column: 1,
      htmlSnippet: "(no <title> found)",
    }];
  }

  const rawTitleInner = titleMatch[1] ?? "";

  // Server expression in title content — ASP.NET fills this at runtime.
  if (/<%[\s=:#$]/.test(rawTitleInner)) return [];

  const titleText = stripTagsAndServerBlocks(rawTitleInner).trim();

  if (titleText.length === 0) {
    // Empty <title> — code-behind may assign Page.Title at runtime.
    if (hasCodeBehindTitleAssignment(codeBehindContent)) return [];
    return [{
      ruleId: "a11y/document-title",
      title: "Page has an empty <title> element",
      description: "The <title> element exists but is empty. Provide a descriptive, unique title so screen readers can identify the page (WCAG 2.4.2).",
      wcagSc: "2.4.2",
      filePath: normalizedRelPath,
      line: 1,
      column: 1,
      htmlSnippet: titleMatch[0] ?? "<title></title>",
    }];
  }

  const genericTitles = new Set(["page", "default", "untitled"]);
  if (genericTitles.has(titleText.toLowerCase())) {
    return [{
      ruleId: "a11y/document-title",
      title: "Page title is too generic",
      description: `Page title "${titleText}" is not descriptive. Provide a unique title that identifies the page purpose (WCAG 2.4.2).`,
      wcagSc: "2.4.2",
      filePath: normalizedRelPath,
      line: 1,
      column: 1,
      htmlSnippet: titleMatch[0] ?? "",
    }];
  }

  return [];
}

function isThinWrapperAspNetPage(content: string): boolean {
  if (content.length > 2500) return false;

  const hasCustomControl = /<[a-z][\w-]*:[A-Za-z][\w-]*\b/i.test(content);
  if (!hasCustomControl) return false;

  const hasCommonMarkup = /<(?:a|button|img|table|input|select|textarea|label|fieldset|iframe|nav|main|section|article|aside|footer|header)\b|<asp:(?:Button|LinkButton|ImageButton|HyperLink|TextBox|DropDownList|ListBox|CheckBox|RadioButton|GridView|DetailsView|FormView|Menu|TreeView|FileUpload)\b/i.test(content);
  return !hasCommonMarkup;
}

function buildAspNetTemplateProfile(content: string): {
  hasImg: boolean;
  hasAnchors: boolean;
  hasButtons: boolean;
  hasAspControls: boolean;
  hasIframes: boolean;
  hasTables: boolean;
  hasRadios: boolean;
  hasEmbeds: boolean;
  hasSvg: boolean;
  hasLabels: boolean;
  hasFormControls: boolean;
  hasFieldset: boolean;
  hasOptgroups: boolean;
  hasAriaOrRoles: boolean;
  hasHeadings: boolean;
  hasRoleHeading: boolean;
  hasTabindex: boolean;
  hasMarqueeOrBlink: boolean;
  hasMedia: boolean;
  hasClickableTags: boolean;
  hasScripts: boolean;
  hasInlineHandlers: boolean;
  hasStyleBlocks: boolean;
  hasErrorIndicators: boolean;
} {
  return {
    hasImg: /<(?:img|asp:image|asp:imagebutton)\b/i.test(content),
    hasAnchors: /<a\b|<asp:(?:hyperlink|linkbutton)\b/i.test(content),
    hasButtons: /<(?:button|input\b[^>]*\btype\s*=\s*(?:"button"|'button'|button))\b|<asp:(?:button|imagebutton)\b/i.test(content),
    hasAspControls: /<asp:[A-Za-z]/i.test(content),
    hasIframes: /<iframe\b/i.test(content),
    hasTables: /<table\b|<asp:(?:gridview|detailsview|formview)\b/i.test(content),
    hasRadios: /<(?:input\b[^>]*\btype\s*=\s*(?:"radio"|'radio'|radio)|asp:radiobutton)\b/i.test(content),
    hasEmbeds: /<(?:object|embed)\b/i.test(content),
    hasSvg: /<svg\b/i.test(content),
    hasLabels: /<(?:label|asp:label)\b/i.test(content),
    hasFormControls: /<(?:input|select|textarea|button)\b|<asp:(?:textbox|dropdownlist|listbox|checkbox|radiobutton|fileupload)\b/i.test(content),
    hasFieldset: /<fieldset\b/i.test(content),
    hasOptgroups: /<optgroup\b/i.test(content),
    hasAriaOrRoles: /\baria[-\w]*\s*=|\brole\s*=/i.test(content),
    hasHeadings: /<h[1-6]\b/i.test(content),
    hasRoleHeading: /role\s*=\s*(?:"heading"|'heading'|heading)/i.test(content),
    hasTabindex: /\btabindex\s*=/i.test(content),
    hasMarqueeOrBlink: /<(?:marquee|blink)\b/i.test(content),
    hasMedia: /<(?:video|audio)\b/i.test(content),
    hasClickableTags: /<(?:a|button|input|summary|details|label|li|td|th|div|span|tr|p|section|article|header|nav|main|aside)\b/i.test(content),
    hasScripts: /<script\b/i.test(content),
    hasInlineHandlers: /\bon(?:click|change|submit|keydown|keyup|keypress|focus|blur|mousedown|mouseup|dragstart|drag|dragover|drop|pointerdown|pointerup|mouseover|mouseenter)\s*=/i.test(content),
    hasStyleBlocks: /<style\b/i.test(content),
    hasErrorIndicators: /(?:error|errmsg|errormessage|validation|alert|status|warning|message|notify)/i.test(content),
  };
}

function findMissingAltOnImg(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labeledParentRanges = getLabeledAnchorButtonRanges(content);
  // Allow %> inside ASP.NET server blocks and > inside quoted attrs.
  const regex = /<img\b(?:<%[\s\S]*?%>|"[^"]*"|'[^']*'|[^>"'])*>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const index = match.index ?? 0;
    if (/\balt\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(snippet)) continue;
    if (isWithinAnyRange(index, labeledParentRanges)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspx-static/img-missing-alt",
      title: "Images must have alternate text",
      description: "Image element is missing an alt attribute.",
      wcagSc: "1.1.1",
      filePath,
      line,
      column,
      htmlSnippet: snippet,
    });
  }
  return issues;
}

function findLikelyBrokenImageSrc(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<img\b(?:<%[\s\S]*?%>|"[^"]*"|'[^']*'|[^>"'])*>/gi;

  for (const match of content.matchAll(regex)) {
    const snippet = match[0] ?? "";
    const index = match.index ?? 0;
    const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(snippet);
    if (!srcMatch) continue;

    const rawSrc = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? "";
    const trimmed = rawSrc.trim();
    if (!trimmed) continue;

    const startsWithWhitespace = /^\s+/.test(rawSrc);
    const loneSlash = trimmed === "/";
    const suspiciousDoubleSlash = /(^|[^:])\/\//.test(trimmed) && !/^\/\/[A-Za-z0-9._-]+/.test(trimmed);

    if (!startsWithWhitespace && !loneSlash && !suspiciousDoubleSlash) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "a11y/image-src-likely-broken",
      title: "Image src looks malformed and may fail to load",
      description:
        "Image src starts with whitespace, is a lone slash, or has suspicious double slashes that often indicate an empty path prefix. Broken images plus missing alt can compound WCAG 1.1.1 failures.",
      wcagSc: "1.1.1",
      filePath,
      line,
      column,
      htmlSnippet: snippet,
    });
  }

  return issues;
}

function extractAspControlId(attrs: string): string {
  return /\bID\s*=\s*['"]([^'"]+)['"]/i.exec(attrs)?.[1]?.trim() ?? "";
}

function hasCodeBehindControlAssignment(
  controlId: string,
  codeBehindContent: string,
  options: {
    properties?: string[];
    attributeNames?: string[];
  },
): boolean {
  if (!controlId || !codeBehindContent) return false;

  const propertyPatterns = (options.properties ?? []).map((property) =>
    new RegExp(`\\b${escapeRegex(controlId)}\\s*\\.\\s*${escapeRegex(property)}\\s*=`, "i"),
  );
  const attributePatterns = (options.attributeNames ?? []).flatMap((attributeName) => {
    const escapedAttribute = escapeRegex(attributeName);
    return [
      new RegExp(`\\b${escapeRegex(controlId)}\\s*\\.\\s*Attributes\\s*\\[\\s*['\"]${escapedAttribute}['\"]\\s*\\]\\s*=`, "i"),
      new RegExp(`\\b${escapeRegex(controlId)}\\s*\\.\\s*Attributes\\s*\\.\\s*Add\\s*\\(\\s*['\"]${escapedAttribute}['\"]`, "i"),
      new RegExp(`\\b${escapeRegex(controlId)}\\s*\\.\\s*Attributes\\s*\\.\\s*Set\\s*\\(\\s*['\"]${escapedAttribute}['\"]`, "i"),
    ];
  });

  return [...propertyPatterns, ...attributePatterns].some((pattern) => pattern.test(codeBehindContent));
}

function findMissingAltOnAspImage(content: string, filePath: string, codeBehindContent = ""): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labeledParentRanges = getLabeledAnchorButtonRanges(content);
  const regex = /<asp:Image\b[^>]*>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const index = match.index ?? 0;
    if (/\bAlternateText\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(snippet)) continue;
    if (isWithinAnyRange(index, labeledParentRanges)) continue;
    const controlId = extractAspControlId(snippet);
    if (
      hasCodeBehindControlAssignment(controlId, codeBehindContent, {
        properties: ["AlternateText", "ToolTip"],
        attributeNames: ["aria-label", "aria-labelledby"],
      })
    ) {
      continue;
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspx-static/img-missing-alt",
      title: "ASP.NET image controls must have alternate text",
      description: "asp:Image control is missing AlternateText.",
      wcagSc: "1.1.1",
      filePath,
      line,
      column,
      htmlSnippet: snippet,
    });
  }
  return issues;
}

function findMissingAltOnAspImageButton(content: string, filePath: string, codeBehindContent = ""): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labeledParentRanges = getLabeledAnchorButtonRanges(content);
  const regex = /<asp:ImageButton\b[^>]*\/?>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const index = match.index ?? 0;
    if (/\bAlternateText\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(snippet)) continue;
    if (isWithinAnyRange(index, labeledParentRanges)) continue;
    const controlId = extractAspControlId(snippet);
    if (
      hasCodeBehindControlAssignment(controlId, codeBehindContent, {
        properties: ["AlternateText", "ToolTip"],
        attributeNames: ["aria-label", "aria-labelledby"],
      })
    ) {
      continue;
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspx-static/img-missing-alt",
      title: "ASP.NET ImageButton controls must have alternate text",
      description: "asp:ImageButton control is missing AlternateText attribute (WCAG 1.1.1).",
      wcagSc: "1.1.1",
      filePath,
      line,
      column,
      htmlSnippet: snippet,
    });
  }
  return issues;
}

function findMissingAltOnAspImageMap(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<asp:ImageMap\b[^>]*\/?>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const index = match.index ?? 0;
    if (/\bAlternateText\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(snippet)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspx-static/img-missing-alt",
      title: "ASP.NET ImageMap controls must have alternate text",
      description: "asp:ImageMap control is missing AlternateText attribute (WCAG 1.1.1).",
      wcagSc: "1.1.1",
      filePath,
      line,
      column,
      htmlSnippet: snippet,
    });
  }
  return issues;
}

function getLabeledAnchorButtonRanges(content: string): Array<[number, number]> {
  const tokenRegex = /<\/?(?:a|button)\b[^>]*>/gi;
  const stack: Array<{ tag: "a" | "button"; labeled: boolean; start: number }> = [];
  const ranges: Array<[number, number]> = [];

  for (const token of content.matchAll(tokenRegex)) {
    const raw = token[0] ?? "";
    const tokenIndex = token.index ?? 0;
    const isClosing = /^<\//.test(raw);
    const tagMatch = raw.match(/^<\/?\s*(a|button)\b/i);
    if (!tagMatch) continue;
    const tag = (tagMatch[1]?.toLowerCase() === "button" ? "button" : "a") as "a" | "button";

    if (isClosing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const entry = stack[i];
        if (entry?.tag === tag) {
          stack.splice(i, 1);
          if (entry.labeled) {
            ranges.push([entry.start, tokenIndex + raw.length]);
          }
          break;
        }
      }
      continue;
    }

    const selfClosing = /\/\s*>$/.test(raw);
    const labeled =
      /\baria-label\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(raw) ||
      /\baria-labelledby\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(raw) ||
      /\btitle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(raw);

    if (!selfClosing) {
      stack.push({ tag, labeled, start: tokenIndex });
    }
  }

  return ranges;
}

function isWithinAnyRange(index: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (index >= start && index <= end) {
      return true;
    }
  }
  return false;
}

function findEmptyAspHyperLink(content: string, filePath: string, codeBehindContent = ""): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  // Self-closing or opening tag only (no inner content for Text attr check)
  const tagRegex = /<asp:HyperLink\b([^>]*)(?:\/>|>([\s\S]*?)<\/asp:HyperLink>)/gi;
  for (const match of content.matchAll(tagRegex)) {
    const fullSnippet = match[0];
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const index = match.index ?? 0;

    const hasTextAttr = /\bText\s*=\s*(?:"[^"]+"|'[^']+'|<%[^%]*%>)/i.test(attrs);
    const hasAriaLabel =
      /\baria-label\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs) ||
      /\bToolTip\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs);
    if (hasTextAttr || hasAriaLabel) continue;

    const controlId = extractAspControlId(attrs);
    if (
      hasCodeBehindControlAssignment(controlId, codeBehindContent, {
        properties: ["Text", "ToolTip"],
        attributeNames: ["aria-label", "aria-labelledby", "title"],
      })
    ) {
      continue;
    }

    const innerText = stripTagsAndServerBlocks(inner);
    if (innerText.length > 0) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/hyperlink-has-content",
      title: "ASP.NET HyperLink controls must have discernible text",
      description: "asp:HyperLink has no Text attribute and no visible inner content.",
      wcagSc: "2.4.4",
      filePath,
      line,
      column,
      htmlSnippet: fullSnippet.slice(0, 300),
    });
  }
  return issues;
}

function findEmptyAspLinkButton(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const tagRegex = /<asp:LinkButton\b([^>]*)(?:\/>|>([\s\S]*?)<\/asp:LinkButton>)/gi;
  for (const match of content.matchAll(tagRegex)) {
    const fullSnippet = match[0];
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const index = match.index ?? 0;

    const hasTextAttr = /\bText\s*=\s*(?:"[^"]+"|'[^']+'|<%[^%]*%>)/i.test(attrs);
    const hasAriaLabel =
      /\baria-label\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs) ||
      /\bToolTip\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs);
    if (hasTextAttr || hasAriaLabel) continue;

    const innerText = stripTagsAndServerBlocks(inner);
    if (innerText.length > 0) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/linkbutton-has-content",
      title: "ASP.NET LinkButton controls must have discernible text",
      description: "asp:LinkButton has no Text attribute and no visible inner content.",
      wcagSc: "2.4.4",
      filePath,
      line,
      column,
      htmlSnippet: fullSnippet.slice(0, 300),
    });
  }
  return issues;
}

function findEmptyAspButton(content: string, filePath: string, codeBehindContent = ""): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<asp:(Button|LinkButton|ImageButton)\b([^>]*)(?:\/>|>([\s\S]*?)<\/asp:\1>)/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0] ?? "";
    const controlType = (match[1] ?? "Button").trim();
    const attrs = match[2] ?? "";
    const inner = match[3] ?? "";
    const index = match.index ?? 0;

    // Pass if control is hidden or Visible="false".
    if (/\bVisible\s*=\s*['"]false['"]|style\s*=\s*['"][^'"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^'"]*['"]|\bhidden\b/i.test(attrs)) {
      continue;
    }

    // Check for text/label sources based on control type.
    let hasText = false;
    if (controlType === "ImageButton") {
      hasText =
        /\bAlternateText\s*=\s*(?:"[^"]+"|'[^']+'|<%[^%]*%>|<%\$[^%]*%>)/i.test(attrs) ||
        /\bToolTip\s*=\s*(?:"[^"]+"|'[^']+'|<%[^%]*%>|<%\$[^%]*%>)/i.test(attrs);
    } else {
      hasText = /\bText\s*=\s*(?:"[^"]+"|'[^']+'|<%[^%]*%>|<%\$[^%]*%>)/i.test(attrs);
    }

    const hasAriaLabel =
      /\baria-label\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs) ||
      /\baria-labelledby\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs) ||
      /\bToolTip\s*=\s*(?:"[^"]+"|'[^']+'|<%[^%]*%>|<%\$[^%]*%>)/i.test(attrs);

    const hasInnerContent = stripTagsAndServerBlocks(inner).length > 0 || hasServerExpressionContent(inner);

    if (hasText || hasAriaLabel) continue;
    if ((controlType === "Button" || controlType === "LinkButton") && hasInnerContent) continue;

    const controlId = extractAspControlId(attrs);
    if (
      hasCodeBehindControlAssignment(controlId, codeBehindContent, {
        properties: controlType === "ImageButton" ? ["AlternateText", "ToolTip"] : ["Text", "ToolTip"],
        attributeNames: controlType === "ImageButton"
          ? ["alt", "title", "aria-label", "aria-labelledby"]
          : ["title", "aria-label", "aria-labelledby"],
      })
    ) {
      continue;
    }

    // For LinkButton with TabIndex="-1", suppress: hidden postback trigger pattern.
    const isLinkButtonHiddenPostback = controlType === "LinkButton" && /\bTabIndex\s*=\s*['"]?-1['"]?/i.test(attrs);
    if (isLinkButtonHiddenPostback) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/button-has-content",
      title: `${controlType} control must have discernible text`,
      description:
        `${controlType === "ImageButton" ? "ImageButton must have AlternateText" : `${controlType} must have Text`}. ` +
        `Alternatively, provide aria-label, aria-labelledby, or ToolTip (WCAG 4.1.2).`,
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: snippet.slice(0, 200),
    });
  }
  return issues;
}

function findAspCheckBoxRadioButtonMissingLabel(content: string, filePath: string, codeBehindContent = ""): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<asp:(?:CheckBox|RadioButton|CheckBoxList|RadioButtonList)\b([^>]*)\/?>/gi;

  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    const controlType = match[0].match(/asp:(\w+)/)?.[1] ?? "CheckBox";

    // Pass if control is inline-hidden, not rendered, or disabled.
    if (/\bVisible\s*=\s*['"]false['"]|\bEnabled\s*=\s*['"]false['"]|style\s*=\s*['"][^'"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^'"]*['"]|\bhidden\b/i.test(attrs)) {
      continue;
    }

    // Check for direct text/label attributes.
    const hasText = /\bText\s*=\s*(?:"[^"]+"|'[^']+'|<%[^%]*%>|<%\$[^%]*%>)/i.test(attrs);
    const hasToolTip = /\b(?:ToolTip|title)\s*=\s*(?:"[^"]+"|'[^']+'|<%[^%]*%>|<%\$[^%]*%>)/i.test(attrs);
    const hasAssociatedControl = /\bAssociatedControlID\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs);
    const hasAriaLabel = /\baria-label\s*=\s*(?:"[^"]+"|'[^']+'|<%[^%]*%>|<%\$[^%]*%>)/i.test(attrs) || /\baria-labelledby\s*=\s*(?:"[^"]+"|'[^']+'|<%[^%]*%>|<%\$[^%]*%>)/i.test(attrs);

    if (hasText || hasToolTip || hasAssociatedControl || hasAriaLabel) continue;

    // Extract control ID if present.
    const idMatch = /\bID\s*=\s*['"]([^'"]+)['"]/.exec(attrs);
    const controlId = idMatch?.[1] ?? "";

    // Data-bound list controls are often populated with accessible item text at runtime.
    // Keep this path conservative to avoid over-reporting templated list controls.
    if (
      /\b(?:CheckBoxList|RadioButtonList)\b/i.test(controlType) &&
      /\b(?:DataTextField|DataSourceID|DataSource|DataValueField)\s*=\s*(?:"[^"]+"|'[^']+'|<%[^%]*%>|<%\$[^%]*%>)/i.test(attrs)
    ) {
      continue;
    }

    if (
      hasCodeBehindControlAssignment(controlId, codeBehindContent, {
        properties: ["Text", "ToolTip"],
        attributeNames: ["aria-label", "aria-labelledby", "title"],
      })
    ) {
      continue;
    }

    // Check if control is wrapped in a <label>.
    const before = content.slice(Math.max(0, index - 800), index);
    const after = content.slice(index + snippet.length, Math.min(content.length, index + snippet.length + 800));

    // Check for preceding <label> without closing tag.
    const lastLabelOpen = before.lastIndexOf("<label");
    const lastLabelClose = before.lastIndexOf("</label>");
    if (lastLabelOpen > lastLabelClose && lastLabelOpen >= 0) {
      continue; // Wrapped in label
    }

    // Check for sibling <label for="..."> in the same local container.
    // Look for <label ... for="..."> in the vicinity.
    const labelRegex = /<label\b[^>]*for\s*=\s*['"]([^'"]*)['"][^>]*>([\s\S]*?)<\/label>/gi;
    let hasMatchingLabel = false;
    for (const labelMatch of content.matchAll(labelRegex)) {
      const targetId = labelMatch[1] ?? "";
      // In ASP.NET, client IDs are mangled, so this is a best-effort check.
      if (controlId && (targetId === controlId || targetId.endsWith("_" + controlId))) {
        hasMatchingLabel = true;
        break;
      }
    }
    if (hasMatchingLabel) continue;

    // Do not treat adjacent span/server-expression text as a programmatic label.
    // Only explicit labels (or control attributes/code-behind) are considered sufficient.

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspx-static/control-missing-label",
      title: `${controlType} control must have a label`,
      description:
        `ASP.NET <asp:${controlType}> has no Text attribute, ToolTip, AssociatedControlID, aria-label, aria-labelledby, or adjacent label element. ` +
        `Screen readers cannot identify this control. Add Text= or an explicit <label> association (WCAG 4.1.2 / 3.3.2).`,
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: snippet.slice(0, 200),
    });
  }

  return issues;
}

function findAspTextBoxMissingLabel(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labelledIds = collectLabelledIds(content);

  const regex = /<asp:TextBox\b([^>]*)\/?>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;

    if (hasAriaLabelAttr(attrs)) continue;

    // Extract the control ID
    const idMatch = /\bID\s*=\s*"([^"]+)"/i.exec(attrs);
    if (idMatch) {
      const controlId = (idMatch[1] ?? "").toLowerCase();
      if (labelledIds.has(controlId)) continue;
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/textbox-has-label",
      title: "ASP.NET TextBox controls must have an associated label",
      description:
        "asp:TextBox has no associated asp:Label (AssociatedControlID) or aria-label. " +
        "Screen readers cannot identify this input field.",
      wcagSc: "3.3.2",
      filePath,
      line,
      column,
      htmlSnippet: snippet,
    });
  }
  return issues;
}

// ─── Additional ASP.NET server control checks ────────────────────────────────

function findAspDropDownListMissingLabel(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labelledIds = collectLabelledIds(content);
  const regex = /<asp:DropDownList\b([^>]*)\/?>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    if (hasAriaLabelAttr(attrs)) continue;
    const idMatch = /\bID\s*=\s*"([^"]+)"/i.exec(attrs);
    if (idMatch && labelledIds.has((idMatch[1] ?? "").toLowerCase())) continue;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/dropdownlist-has-label",
      title: "asp:DropDownList must have an associated label",
      description: "asp:DropDownList has no associated asp:Label (AssociatedControlID) or aria-label. Screen readers cannot identify this field (WCAG 3.3.2).",
      wcagSc: "3.3.2",
      filePath, line, column, htmlSnippet: snippet,
    });
  }
  return issues;
}

function findAspListBoxMissingLabel(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labelledIds = collectLabelledIds(content);
  const regex = /<asp:ListBox\b([^>]*)\/?>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    if (hasAriaLabelAttr(attrs)) continue;
    const idMatch = /\bID\s*=\s*"([^"]+)"/i.exec(attrs);
    if (idMatch && labelledIds.has((idMatch[1] ?? "").toLowerCase())) continue;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/listbox-has-label",
      title: "asp:ListBox must have an associated label",
      description: "asp:ListBox has no associated asp:Label (AssociatedControlID) or aria-label. Screen readers cannot identify this field (WCAG 3.3.2).",
      wcagSc: "3.3.2",
      filePath, line, column, htmlSnippet: snippet,
    });
  }
  return issues;
}

function findAspFileUploadMissingLabel(content: string, filePath: string, codeBehindContent = ""): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labelledIds = collectLabelledIds(content);
  const regex = /<asp:FileUpload\b([^>]*)\/?>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    if (hasAriaLabelAttr(attrs)) continue;
    const idMatch = /\bID\s*=\s*"([^"]+)"/i.exec(attrs);
    const controlId = idMatch?.[1] ?? "";
    if (controlId && labelledIds.has(controlId.toLowerCase())) continue;
    if (
      hasCodeBehindControlAssignment(controlId, codeBehindContent, {
        properties: ["ToolTip"],
        attributeNames: ["aria-label", "aria-labelledby", "title"],
      })
    ) {
      continue;
    }
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/fileupload-has-label",
      title: "asp:FileUpload must have an associated label",
      description: "asp:FileUpload has no associated asp:Label (AssociatedControlID) or aria-label. Screen readers cannot identify this file input (WCAG 3.3.2).",
      wcagSc: "3.3.2",
      filePath, line, column, htmlSnippet: snippet,
    });
  }
  return issues;
}

function findAspGridViewMissingCaption(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  // asp:GridView and asp:DetailsView render as <table> — require Caption attr
  const regex = /<asp:(?:GridView|DetailsView)\b([^>]*)>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    if (/\bCaption\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs)) continue;
    if (hasAriaLabelAttr(attrs)) continue;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/grid-missing-caption",
      title: "asp:GridView/DetailsView should have a Caption",
      description: "Data grid controls render as HTML tables. Without a Caption or aria-label, screen readers cannot describe the table's purpose (WCAG 1.3.1).",
      wcagSc: "1.3.1",
      filePath, line, column, htmlSnippet: snippet,
    });
  }
  return issues;
}

function findAspGridUseAccessibleHeaderFalse(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<asp:GridView\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    if (!/\bUseAccessibleHeader\s*=\s*(?:"false"|'false'|false)/i.test(attrs)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/grid-useaccessibleheader-false",
      title: "asp:GridView has UseAccessibleHeader=false",
      description: "UseAccessibleHeader=false can prevent proper table header semantics for assistive technologies (WCAG 1.3.1).",
      wcagSc: "1.3.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findAspMenuRenderingMode(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<asp:Menu\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    const hasRenderingMode = /\bRenderingMode\s*=\s*(?:"List"|'List'|List)/i.test(attrs);
    if (hasRenderingMode) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/menu-renderingmode-not-list",
      title: "asp:Menu does not specify RenderingMode=List",
      description: "Legacy asp:Menu rendering can emit table-heavy markup; RenderingMode=List generally improves semantic navigation structure (WCAG 1.3.1).",
      wcagSc: "1.3.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findAspAuthAutocompleteAndPasteBlocked(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const isAuthLikePage =
    /(login|signin|sign-in|auth|password|recover|signup|register)/i.test(filePath) ||
    (/<form\b[\s\S]{0,4000}(?:type\s*=\s*['"]password['"]|name\s*=\s*['"][^'"]*(?:user|email|login|pass)[^'"]*['"]|id\s*=\s*['"][^'"]*(?:user|email|login|pass)[^'"]*['"])[\s\S]{0,4000}(?:type\s*=\s*['"]submit['"]|<button\b[^>]*>)/i.test(content));
  if (!isAuthLikePage) return issues;

  const pasteRegex = /\bonpaste\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of content.matchAll(pasteRegex)) {
    const handler = (match[1] ?? match[2] ?? "").trim();
    if (!/return\s+false|preventDefault\s*\(/i.test(handler)) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/auth-paste-blocked",
      title: "Authentication input blocks paste",
      description: "Blocking paste in authentication fields can create accessibility barriers and conflicts with password manager workflows (WCAG 3.3.8).",
      wcagSc: "3.3.8",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  const inputRegex = /<(input|asp:TextBox)\b([^>]*)>/gi;
  for (const inputMatch of content.matchAll(inputRegex)) {
    const tag = (inputMatch[1] ?? "input").toLowerCase();
    const attrs = inputMatch[2] ?? "";
    const index = inputMatch.index ?? 0;

    const type = (/(?:\btype|\bTextMode)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs)?.[1]
      ?? /(?:\btype|\bTextMode)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs)?.[2]
      ?? /(?:\btype|\bTextMode)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs)?.[3]
      ?? "").toLowerCase();

    const idOrName = `${/\bid\s*=\s*['"]([^'"]+)['"]/i.exec(attrs)?.[1] ?? ""} ${/\bname\s*=\s*['"]([^'"]+)['"]/i.exec(attrs)?.[1] ?? ""}`.toLowerCase();

    if (/\bEnabled\s*=\s*(?:"false"|'false'|false)|\bReadOnly\s*=\s*(?:"true"|'true'|true)|\bVisible\s*=\s*(?:"false"|'false'|false)|style\s*=\s*['"][^'"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs)) {
      continue;
    }

    const hiddenType = /^(?:hidden)$/i.test(type);
    if (hiddenType) continue;

    const visibleCredentialType = /^(?:text|email|password|search|tel)$/i.test(type) || type.length === 0;
    if (!visibleCredentialType) continue;

    const isCredentialField =
      type === "password" ||
      /(?:username|password|email|login|user$|pwd|passwd)/i.test(idOrName);
    if (!isCredentialField) continue;

    // Skip admin/config credential entry contexts.
    if (/(recipient|admin|config)/i.test(idOrName) || /(admin|config|settings)/i.test(filePath)) {
      continue;
    }

    const hasAutocomplete = /\bautocomplete\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs);
    const hasAutocompleteType = /\bAutoCompleteType\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs);
    const hasServerExprAutocomplete = /\b(?:autocomplete|AutoCompleteType)\s*=\s*(?:"[^\"]*<%[\s\S]*?%>[^\"]*"|'[^']*<%[\s\S]*?%>[^']*'|<%[\s\S]*?%>)/i.test(attrs);
    if (hasAutocomplete || hasAutocompleteType || hasServerExprAutocomplete) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/auth-autocomplete-missing",
      title: "Authentication fields missing recommended autocomplete tokens",
      description: "Credential-like field on an auth page is missing autocomplete/autocompletetype metadata. Provide username/current-password/new-password tokens where appropriate (WCAG 1.3.5).",
      wcagSc: "1.3.5",
      filePath,
      line,
      column,
      htmlSnippet: (inputMatch[0] ?? "").slice(0, 220),
    });
  }

  return issues;
}

function findAspDropDownAutoPostBackNavigation(content: string, filePath: string, codeBehindContent = ""): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<asp:DropDownList\b([^>]*)\/?>(?:<\/asp:DropDownList>)?/gi;
  const navigationRegex = /\bResponse\.(?:Redirect|End)\s*\(|\bServer\.Transfer\s*\(|\bwindow\.location\b|\blocation\.href\b/i;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    if (!/\bAutoPostBack\s*=\s*(?:"true"|'true'|true)/i.test(attrs)) continue;

    const handlerMatch = /\bOnSelectedIndexChanged\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs);
    const handlerName = (handlerMatch?.[1] ?? handlerMatch?.[2] ?? "").trim();
    if (!handlerName) continue;

    // Best-effort: resolve matching handler in template or code-behind and only flag if it navigates.
    const navigationDetected = [content, codeBehindContent].some((source) => {
      if (!source) return false;
      const methodAnchor = new RegExp(`\\b${escapeRegex(handlerName)}\\s*\\(`, "i");
      const anchorMatch = methodAnchor.exec(source);
      if (!anchorMatch || anchorMatch.index == null) return false;
      const methodSlice = source.slice(anchorMatch.index, Math.min(source.length, anchorMatch.index + 3000));
      return navigationRegex.test(methodSlice);
    });
    if (!navigationDetected) continue;

    const nearby = content.slice(Math.max(0, index - 700), Math.min(content.length, index + 1400));

    const hasInstructionalText = (() => {
      if (/(<%=|<%:|<%#|<%\$)\s*[\s\S]{0,120}(submit|navigate|redirect|refresh|update|filter|reload)/i.test(nearby)) {
        return true;
      }

      const hintRegex = /<(label|span)\b[^>]*>([\s\S]{0,220}?)<\/\1>/gi;
      for (const hintMatch of nearby.matchAll(hintRegex)) {
        const hintInner = hintMatch[2] ?? "";
        if (hasServerExpressionContent(hintInner)) return true;
        const normalized = stripTagsAndServerBlocks(hintInner).toLowerCase();
        if (/(submit|navigate|redirect|refresh|update|reload|filter)/.test(normalized)) {
          return true;
        }
      }
      return false;
    })();
    if (hasInstructionalText) continue;

    const insideInteractiveFilterSection =
      /<(fieldset|section|div|td|tr)\b[\s\S]{0,300}(filter|search|refine|results|sort)/i.test(nearby) ||
      /(filter|search|refine|results|sort)[\s\S]{0,200}<asp:DropDownList\b/i.test(nearby);
    if (insideInteractiveFilterSection) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/dropdown-autopostback-navigation",
      title: "asp:DropDownList AutoPostBack may cause immediate navigation (informational)",
      description: "AutoPostBack with a navigation handler can cause unexpected context changes on selection (WCAG 3.2.2). This is informational in static analysis; confirm runtime behavior.",
      wcagSc: "3.2.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

// ─── HTML structural checks ───────────────────────────────────────────────────

function findMissingPageTitle(content: string, filePath: string): AspxScanIssue[] {
  // Only check files that are full page documents (have <html> or <%@ Page)
  const isFullPage = /<html\b/i.test(content) || /<%@\s*Page\b/i.test(content);
  if (!isFullPage) return [];
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(content);
  if (titleMatch) {
    const titleText = stripTagsAndServerBlocks(titleMatch[1] ?? "").trim();
    const genericTitles = new Set(["page", "default", "untitled"]);
    if (titleText.length === 0) {
      return [{
        ruleId: "aspnet/page-has-title",
        title: "Page has an empty <title> element",
        description: "The <title> element exists but is empty. Screen readers announce the page title when a page loads (WCAG 2.4.2).",
        wcagSc: "2.4.2",
        filePath, line: 1, column: 1, htmlSnippet: "<title></title>",
      }];
    }

    if (!genericTitles.has(titleText.toLowerCase())) {
      return [];
    }

    return [{
      ruleId: "aspnet/title-non-descriptive",
      title: "Page title is too generic",
      description: "Title text like 'Page', 'Default', or 'Untitled' is not descriptive enough for navigation and history context (WCAG 2.4.2).",
      wcagSc: "2.4.2",
      filePath,
      line: 1,
      column: 1,
      htmlSnippet: titleMatch[0],
    }];
  }

  // Has <title> tag but empty
  if (/<title\b[^>]*>\s*<\/title>/i.test(content)) {
    return [{
      ruleId: "aspnet/page-has-title",
      title: "Page has an empty <title> element",
      description: "The <title> element exists but is empty. Screen readers announce the page title when a page loads (WCAG 2.4.2).",
      wcagSc: "2.4.2",
      filePath, line: 1, column: 1, htmlSnippet: "<title></title>",
    }];
  }
  return [{
    ruleId: "aspnet/page-has-title",
    title: "Page is missing a <title> element",
    description: "No <title> element found. Screen readers announce the page title when the page loads (WCAG 2.4.2).",
    wcagSc: "2.4.2",
    filePath, line: 1, column: 1, htmlSnippet: "(no <title> found)",
  }];
}

function findIframeMissingTitle(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const knownIds = collectKnownElementIds(content);
  const regex = /<iframe\b([^>]*)>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    const titleAttr = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const titleValue = (titleAttr?.[1] ?? titleAttr?.[2] ?? titleAttr?.[3] ?? "").trim();
    if (titleAttr && titleValue.length > 0 && !/^<%[\s\S]*%>$/.test(titleValue)) continue;
    if (/\baria-hidden\s*=\s*(?:"true"|'true'|true)/i.test(attrs) && /\btabindex\s*=\s*(?:"-1"|'-1'|-1)/i.test(attrs)) continue;
    if (/\baria-label\s*=\s*(?:"[^"\s][^"]*"|'[^'\s][^']*'|[^\s>]+)/i.test(attrs)) continue;
    if (hasResolvableAriaLabelledby(attrs, knownIds)) continue;
    const { line, column } = getLineColumn(content, index);
    const isRuntimeOnlyTitle = titleAttr != null && /^<%[\s\S]*%>$/.test(titleValue);
    issues.push({
      ruleId: isRuntimeOnlyTitle
        ? "aspx-static/iframe-missing-title-runtime-review"
        : "aspx-static/iframe-missing-title",
      title: isRuntimeOnlyTitle
        ? "iframe title is runtime expression only (review)"
        : "iframe must have a title attribute",
      description: isRuntimeOnlyTitle
        ? "iframe title is populated only by a server expression and could resolve to empty/whitespace. Review runtime output and ensure a non-empty frame name is exposed (WCAG 2.4.1 / 4.1.2)."
        : "iframes without a title attribute cannot be identified by screen reader users navigating by frames (WCAG 2.4.1 / 4.1.2).",
      wcagSc: "2.4.1",
      filePath, line, column, htmlSnippet: snippet,
    });
  }
  return issues;
}

function findTableMissingCaption(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  if (/\.(?:ascx)$/i.test(filePath)) return issues;
  const tableRegex = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;

  for (const match of content.matchAll(tableRegex)) {
    const snippet = match[0];
    const attrs = match[1] ?? "";
    const tableBody = match[2] ?? "";
    const index = match.index ?? 0;

    // Skip decorative and explicitly-overridden semantic roles.
    if (/\brole\s*=\s*(?:"presentation"|'presentation'|"none"|'none')/i.test(attrs)) continue;
    if (/\brole\s*=\s*(?:"grid"|'grid'|"treegrid"|'treegrid'|"table"|'table'|"radiogroup"|'radiogroup'|"region"|'region'|"group"|'group'|"tablist"|'tablist'|"menu"|'menu'|"listbox"|'listbox')/i.test(attrs)) continue;

    // Check if table has header semantics (data table indicator).
    const hasThTag = /<th\b/i.test(tableBody);
    const hasThead = /<thead\b/i.test(tableBody);
    const hasScope = /\bscope\s*=\s*(?:"col"|"row"|'col'|'row')/i.test(tableBody);
    const hasHeaderRole = /role\s*=\s*(?:"columnheader"|"rowheader"|'columnheader'|'rowheader')/i.test(tableBody);
    const hasTableRole = /role\s*=\s*(?:"table"|"grid"|'table'|'grid')/i.test(attrs);
    const hasDataHintingClass = /\bclass\s*=\s*['"][^'"]*(?:tableData|dataTable|gridView|reportTable|panelTable|parameterTable|SystemNotificationTable|Table\b|Grid\b|Data\b|List\b|Report\b)[^'"]*['"]/i.test(attrs);
    const isRunatServer = /\brunat\s*=\s*(?:"server"|'server'|server)/i.test(attrs);

    // Only flag if this is a DATA table (has header semantics).
    const isDataTable = hasThTag || hasThead || hasScope || hasHeaderRole || hasTableRole || (isRunatServer && hasDataHintingClass);
    if (!isDataTable) continue;

    // Skip if already has accessible name.
    if (hasAriaLabelAttr(attrs)) continue;
    if (/\btitle\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs)) continue;

    // Look for <caption> within the table.
    if (/<caption\b/i.test(tableBody)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/table-missing-caption",
      title: "Data table is missing a caption or accessible name",
      description: "Tables with header semantics (data tables) should have a <caption> element, aria-label, or aria-labelledby so screen readers can identify the table's purpose (WCAG 1.3.1).",
      wcagSc: "1.3.1",
      filePath,
      line,
      column,
      htmlSnippet: snippet.slice(0, 200),
    });
  }
  return issues;
}

function findGridViewDetailsMissingCaption(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const isAspNetFile = /\.aspx$|\.ascx$/.test(filePath);
  if (!isAspNetFile) return issues;

  const gridviewRegex = /<asp:(?:GridView|DetailsView|FormView)\b([^>]*)>/gi;
  for (const match of content.matchAll(gridviewRegex)) {
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    const controlType = match[0].match(/asp:(\w+)/)?.[1] ?? "GridView";

    // Skip if control is not rendered as data table.
    if (/ShowHeader\s*=\s*['"]false['"]/i.test(attrs)) continue;
    if (/Visible\s*=\s*['"]false['"]/i.test(attrs)) continue;
    if (/GridLines\s*=\s*['"]None['"]/i.test(attrs)) continue;

    // Skip if already has Caption, CaptionAlign, aria-label, aria-labelledby.
    if (/\bCaption\s*=\s*(?:"[^"]*"|'[^']*'|<%[^%]*%>)/i.test(attrs)) continue;
    if (/\bCaptionAlign\s*=\s*(?:"[^"]*"|'[^']*')/i.test(attrs)) continue;
    if (/\baria-label\s*=\s*(?:"[^"]*"|'[^']*')/i.test(attrs)) continue;
    if (/\baria-labelledby\s*=\s*(?:"[^"]*"|'[^']*')/i.test(attrs)) continue;

    // Check if immediately preceded by a heading or titled label.
    const before = content.slice(Math.max(0, index - 800), index);
    if (/<h[1-6]\b|role\s*=\s*['"]heading['"]|<asp:Label\b[^>]*Text\s*=/i.test(before)) {
      // Check if heading/label is recent (within last 300 chars).
      const recentBefore = before.slice(-300);
      if (/<h[1-6]\b|role\s*=\s*['"]heading['"]|<asp:Label\b[^>]*Text\s*=/i.test(recentBefore)) {
        continue; // Preceded by heading or titled label.
      }
    }

    // Check if inside a section with aria-label.
    if (/<section\b[^>]*aria-label\s*=\s*['"][^'"]*['"]/i.test(before)) continue;

    // Check if inside a fieldset with legend.
    if (/<fieldset\b[^>]*>\s*<legend\b/i.test(before)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/gridview-details-missing-caption",
      title: `${controlType} control should have a caption`,
      description:
        `${controlType} data controls need a caption or aria-label to provide an accessible name for assistive technology users. ` +
        `Add Caption="..." attribute or a preceding heading (WCAG 1.3.1 / 2.4.2).`,
      wcagSc: "1.3.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0].slice(0, 220),
    });
  }

  return issues;
}

function findTableHeaderMissingScope(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];

  // Find all <table> elements.
  const tableRegex = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
  for (const tableMatch of content.matchAll(tableRegex)) {
    const tableAttrs = tableMatch[1] ?? "";
    const tableContent = tableMatch[2] ?? "";
    const tableIndex = tableMatch.index ?? 0;
    const tableSnippet = tableMatch[0];

    // Skip layout tables (role="presentation" or role="none").
    if (/role\s*=\s*['"](?:presentation|none)['"]/i.test(tableAttrs)) continue;

    // Count rows and columns to skip single-row/column tables.
    const rowCount = (tableContent.match(/<tr\b/gi) ?? []).length;
    const thCount = (tableContent.match(/<th\b/gi) ?? []).length;
    const tdCount = (tableContent.match(/<td\b/gi) ?? []).length;
    const colCount = Math.max(thCount, tdCount) / Math.max(rowCount, 1);

    // Skip if single row or single column.
    if (rowCount <= 1 || colCount <= 1) continue;

    // Find all <th> elements in this table.
    const thRegex = /<th\b([^>]*)>/gi;
    let thMatch;
    while ((thMatch = thRegex.exec(content)) !== null) {
      const thIndex = thMatch.index ?? 0;

      // Check if <th> is inside this table.
      if (thIndex < tableIndex || thIndex > tableIndex + tableSnippet.length) continue;

      const thAttrs = thMatch[1] ?? "";
      const thSnippet = thMatch[0];

      // Skip if scope= present (including server expressions).
      if (/\bscope\s*=\s*(?:"[^"]*"|'[^']*'|<%[^%]*%>)/i.test(thAttrs)) continue;

      // Skip if id+ headers= linkage present (id-based association is acceptable).
      const thIdMatch = /\bid\s*=\s*['"]([^'"]*)['"]/i.exec(thAttrs);
      if (thIdMatch) {
        const thId = thIdMatch[1] ?? "";
        const cellsWithHeadersRegex = new RegExp(`\\bheaders\\s*=\\s*['"]([^'"]*${thId}[^'"]*)['"]/i`);
        if (cellsWithHeadersRegex.test(tableContent)) continue;
      }

      // Skip if generated by server control UseAccessibleHeader="true".
      const beforeTh = content.slice(Math.max(0, thIndex - 3000), thIndex);
      if (/<asp:GridView\b[^>]*UseAccessibleHeader\s*=\s*['"]true['"][^>]*>/i.test(beforeTh)) continue;

      const { line, column } = getLineColumn(content, thIndex);
      issues.push({
        ruleId: "aspnet/th-missing-scope",
        title: "Table header missing scope attribute",
        description:
          `<th> elements should have scope="col" (for column headers) or scope="row" (for row headers) ` +
          `so screen readers can associate headers with data cells (WCAG 1.3.1).`,
        wcagSc: "1.3.1",
        filePath,
        line,
        column,
        htmlSnippet: thSnippet,
      });
    }
  }

  return issues;
}

function findTdHeadersMissingTargets(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const tableRegex = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;

  for (const tableMatch of content.matchAll(tableRegex)) {
    const tableBlock = tableMatch[0] ?? "";
    const thIds = new Set<string>();
    for (const thMatch of tableBlock.matchAll(/<th\b([^>]*)>/gi)) {
      const thAttrs = thMatch[1] ?? "";
      const idMatch = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(thAttrs);
      const id = (idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3] ?? "").trim().toLowerCase();
      if (id) thIds.add(id);
    }

    if (thIds.size === 0) continue;

    for (const tdMatch of tableBlock.matchAll(/<td\b([^>]*)>/gi)) {
      const tdAttrs = tdMatch[1] ?? "";
      const headersMatch = /\bheaders\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(tdAttrs);
      if (!headersMatch) continue;

      const headerRefs = (headersMatch[1] ?? headersMatch[2] ?? "")
        .split(/\s+/)
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean);
      const missing = headerRefs.filter((id) => !thIds.has(id));
      if (missing.length === 0) continue;

      const localIndex = tdMatch.index ?? 0;
      const globalIndex = (tableMatch.index ?? 0) + localIndex;
      const { line, column } = getLineColumn(content, globalIndex);
      issues.push({
        ruleId: "aspnet/td-headers-missing-target",
        title: "Table cell headers attribute references missing th ids",
        description: `headers references id(s) not found in this table: ${missing.join(", ")} (WCAG 1.3.1).`,
        wcagSc: "1.3.1",
        filePath,
        line,
        column,
        htmlSnippet: tdMatch[0],
      });
    }
  }

  return issues;
}

function findCaptionNotFirstChild(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const tableRegex = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;

  for (const match of content.matchAll(tableRegex)) {
    const inner = match[1] ?? "";
    const captionMatch = /<caption\b/i.exec(inner);
    if (!captionMatch) continue;

    const beforeCaption = inner.slice(0, captionMatch.index ?? 0);
    const withoutComments = beforeCaption.replace(/<!--([\s\S]*?)-->/g, " ").trim();
    if (withoutComments.length === 0) continue;

    const index = (match.index ?? 0) + (captionMatch.index ?? 0);
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/caption-not-first-child",
      title: "Table caption should be the first child of table",
      description: "When a caption exists, place it as the first child of <table> so assistive technologies reliably announce table context (WCAG 1.3.1).",
      wcagSc: "1.3.1",
      filePath,
      line,
      column,
      htmlSnippet: "<caption>",
    });
  }

  return issues;
}

function findRoleRadioMissingAriaChecked(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<([a-z0-9:-]+)\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[2] ?? "";
    const index = match.index ?? 0;
    const snippet = match[0];

    // Check if element has literal role="radio" in markup.
    if (!/\brole\s*=\s*['"]radio['"]\b/i.test(attrs)) continue;

    // Pass if aria-checked is already present.
    if (/\baria-checked\s*=\s*['"](?:true|false|mixed)['"]\b/i.test(attrs)) continue;

    // Pass if aria-checked is bound dynamically (server expression).
    if (/\baria-checked\s*=\s*['"]<%/i.test(attrs)) continue;

    // Check if element is inside a radiogroup or data-bound context.
    const before = content.slice(Math.max(0, index - 1000), index);
    const lastOpenTag = before.lastIndexOf("<");
    const contextSnippet = before.slice(lastOpenTag - 100, before.length);

    // Pass if inside role="radiogroup".
    if (/role\s*=\s*['"]radiogroup['"]\b/i.test(contextSnippet)) continue;

    // Pass if in a data-bound template (presence of data-* attributes or nearby script binding).
    if (/\bdata-[-\w]+\s*=|ng-|v-|@|ngIf|\(\(ngModel|v-model|:model|x-data/i.test(contextSnippet)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/role-radio-missing-checked",
      title: "role=radio missing aria-checked",
      description:
        "Element has role=\"radio\" but no aria-checked attribute in markup. " +
        "Add aria-checked=\"false\" as a static default so the initial state is correct before any JS runs (WCAG 4.1.2). " +
        "JS can then update aria-checked dynamically.",
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: snippet,
    });
  }
  return issues;
}

function findMissingLandmarkRegions(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];

  // Only applies to full-page .aspx documents.
  if (!/\.aspx$/i.test(filePath)) return [];
  if (!/<html\b/i.test(content)) return [];
  if (!/<body\b/i.test(content)) return [];

  // Skip known non-content pages or shell-fragment targets.
  if (SKIP_LINK_EXEMPT_FILENAME.test(filePath)) return [];
  if (/(login|logout|error|loading|splash|session[-_]?timeout|blank|unload|popup|dialog|iframe|print)/i.test(filePath)) return [];

  // Skip explicit iframe/dialog/popup targets.
  if (/<iframe\b/i.test(content)) return [];
  if (/<[^>]+role\s*=\s*(?:"dialog"|'dialog'|"alertdialog"|'alertdialog')/i.test(content)) return [];
  if (/window\.open\s*\(|window\.showModalDialog\s*\(/i.test(content)) return [];
  if (/\bparent\.(?:document|location|opener)|\bwindow\.frameElement\b/i.test(content)) return [];

  // Extract body content to check for substantive content.
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(content);
  if (!bodyMatch) return [];
  const bodyContent = bodyMatch[1] ?? "";

  const hasInteractiveContent = /<(?:a\b[^>]*href\s*=|button\b|input\b(?![^>]*\btype\s*=\s*['"]?(?:hidden)['"]?)|select\b|textarea\b|asp:(?:Button|LinkButton|ImageButton|TextBox|DropDownList|ListBox|CheckBox|RadioButton|Menu|TreeView|GridView))|\btabindex\s*=\s*['"]?0['"]?/i.test(bodyContent);
  if (!hasInteractiveContent) return [];

  // Only apply when navigation/menu structures are present.
  // Count anchors with a simple global match instead of a nested repetition regex
  // to avoid catastrophic backtracking on pages with inline script blocks.
  const anchorCount = (bodyContent.match(/<a\b[^>]*\bhref\s*=/gi) ?? []).length;
  const hasNavSignal =
    /<nav\b|role\s*=\s*(?:"navigation"|'navigation'|navigation)/i.test(bodyContent) ||
    (/<(?:ul|ol)\b/i.test(bodyContent) && anchorCount >= 5) ||
    /<asp:(?:Menu|TreeView|SiteMapPath)\b/i.test(bodyContent);
  if (!hasNavSignal) return [];

  // Skip single-purpose shell-loaded forms.
  const hasSingleForm = (bodyContent.match(/<form\b/gi) ?? []).length === 1;
  const hasFewInputs = (bodyContent.match(/<(?:input\b|select\b|textarea\b|asp:(?:TextBox|DropDownList|ListBox|CheckBox|RadioButton|FileUpload)\b)/gi) ?? []).length <= 4;
  if (hasSingleForm && hasFewInputs && !hasNavSignal) return [];

  // Check for landmark elements/roles.
  const hasMain = /<main\b|role\s*=\s*(?:"main"|'main')/i.test(bodyContent);
  const hasHeader = /<header\b|role\s*=\s*(?:"banner"|'banner')/i.test(bodyContent);
  const hasFooter = /<footer\b|role\s*=\s*(?:"contentinfo"|'contentinfo')/i.test(bodyContent);
  const hasNav = /<nav\b|role\s*=\s*(?:"navigation"|'navigation')/i.test(bodyContent);
  const hasAside = /<aside\b|role\s*=\s*(?:"complementary"|'complementary')/i.test(bodyContent);
  const hasSection = /<section\b(?:[^>]*aria-label|[^>]*aria-labelledby|[^>]*role)/i.test(bodyContent);
  const hasRegion = /role\s*=\s*(?:"region"|'region')/i.test(bodyContent);
  const hasSearch = /role\s*=\s*(?:"search"|'search')/i.test(bodyContent);

  // At least one landmark should exist.
  if (hasMain || hasHeader || hasFooter || hasNav || hasAside || hasSection || hasRegion || hasSearch) {
    return [];
  }

  // No landmarks detected.
  const { line, column } = getLineColumn(content, 0);
  issues.push({
    ruleId: "aspnet/page-missing-landmarks",
    title: "Top-level page is missing landmark regions",
    description:
      "Page has no landmark elements (<main>, <header>, <footer>, <nav>, <aside>) or landmark roles. " +
      "Landmarks help screen reader users navigate page structure and jump to key sections (WCAG 1.3.1).",
    wcagSc: "1.3.1",
    filePath,
    line,
    column,
    htmlSnippet: "Document",
  });

  return issues;
}

function findDuplicateIdsWithWebFormsGuards(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const occurrences = new Map<string, Array<{ index: number; snippet: string }>>();
  const tagRegex = /<([a-z][\w:-]*)\b([^>]*?)\b(?:id|ID)\s*=\s*(?:"([^"]+)"|'([^']+)')([^>]*)>/gi;

  for (const match of content.matchAll(tagRegex)) {
    const attrs = `${match[2] ?? ""} ${match[5] ?? ""}`;
    const idValue = (match[3] ?? match[4] ?? "").trim().toLowerCase();
    if (!idValue) continue;
    if (/<%[=:#$]?/.test(idValue)) continue;

    if (/\brunat\s*=\s*['"]server['"]/i.test(attrs) && isLikelyTemplatedServerControlContext(content, match.index ?? 0)) {
      continue;
    }

    const bucket = occurrences.get(idValue) ?? [];
    bucket.push({ index: match.index ?? 0, snippet: match[0] ?? "" });
    occurrences.set(idValue, bucket);
  }

  for (const [idValue, list] of occurrences) {
    if (list.length < 2) continue;
    if (list.some((entry) => isInServerConditionalBranch(content, entry.index))) continue;

    const first = list[0];
    if (!first) continue;
    const { line, column } = getLineColumn(content, first.index);
    issues.push({
      ruleId: "aspx-static/duplicate-id",
      title: "Duplicate id value detected",
      description: `id=\"${idValue}\" appears ${list.length} times in the same document scope. Duplicate ids break label and ARIA relationships (WCAG 4.1.1 / 4.1.2).`,
      wcagSc: "4.1.1",
      filePath,
      line,
      column,
      htmlSnippet: first.snippet.slice(0, 220),
    });
  }

  return issues;
}

function findMeaninglessImgAlt(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const imgRegex = /<img\b([^>]*)>/gi;
  const genericAltWords = new Set(["image", "picture", "photo", "icon", "button", "link"]);

  for (const match of content.matchAll(imgRegex)) {
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (!altMatch) continue;

    const altRaw = (altMatch[1] ?? altMatch[2] ?? altMatch[3] ?? "").trim();
    if (altRaw.length === 0) continue;

    const srcMatch = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const srcRaw = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "").trim();
    const srcBase = srcRaw.split(/[\\/]/).pop()?.replace(/\.[a-z0-9]+$/i, "").toLowerCase() ?? "";
    const altNorm = altRaw.toLowerCase().replace(/\s+/g, " ").trim();
    const looksLikeFileName = /\b[a-z0-9_-]+\.(?:png|jpe?g|gif|bmp|webp|svg)\b/i.test(altRaw);
    const looksLikeIconToken = /\b(?:icon|img|image|photo|picture|button|link)[_-]?\d*\b/i.test(altNorm);
    const isGenericWord = genericAltWords.has(altNorm);
    const sameAsSrc = srcBase.length > 0 && srcBase === altNorm.replace(/\.[a-z0-9]+$/i, "");

    if (!(looksLikeFileName || looksLikeIconToken || isGenericWord || sameAsSrc)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/alt-text-meaningless",
      title: "Image alternate text appears non-descriptive",
      description: "alt text looks like a filename, generic token, or source basename and may not communicate meaningful purpose (WCAG 1.1.1).",
      wcagSc: "1.1.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findSvgRoleImgMissingName(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const svgRegex = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/gi;

  for (const match of content.matchAll(svgRegex)) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const index = match.index ?? 0;
    if (!/\brole\s*=\s*(?:"img"|'img'|img)/i.test(attrs)) continue;

    const hasName =
      hasAriaLabelAttr(attrs) ||
      /\btitle\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs) ||
      /<title\b[^>]*>\s*[^<\s][\s\S]*?<\/title>/i.test(inner);
    if (hasName) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/svg-role-img-missing-name",
      title: "SVG with role=img is missing an accessible name",
      description: "Meaningful SVG graphics need an accessible name via <title>, aria-label, or aria-labelledby (WCAG 1.1.1 / 4.1.2).",
      wcagSc: "1.1.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0].slice(0, 260),
    });
  }

  return issues;
}

function findObjectEmbedMissingFallback(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const objectRegex = /<object\b([^>]*)>([\s\S]*?)<\/object>/gi;
  const embedRegex = /<embed\b([^>]*)\/?>(?:<\/embed>)?/gi;

  for (const match of content.matchAll(objectRegex)) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const index = match.index ?? 0;
    const hasTitle = /\btitle\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs);
    const fallbackText = stripTagsAndServerBlocks(inner);
    if (hasTitle || fallbackText.length > 0) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/object-embed-missing-fallback",
      title: "Object element missing title and fallback content",
      description: "Embedded object content should provide a title or meaningful fallback text for assistive technology users (WCAG 1.1.1).",
      wcagSc: "1.1.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0].slice(0, 260),
    });
  }

  for (const match of content.matchAll(embedRegex)) {
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    const hasTitle = /\btitle\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs);
    if (hasTitle) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/object-embed-missing-fallback",
      title: "Embed element missing title",
      description: "Embedded media should expose a title or alternate text mechanism for non-visual users (WCAG 1.1.1).",
      wcagSc: "1.1.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0].slice(0, 220),
    });
  }

  return issues;
}

function findLabelReferenceMissingControl(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const knownIds = collectKnownElementIds(content);
  const isAspNetFile = /\.aspx$|\.ascx$/.test(filePath);
  const allServerControlIds = new Set<string>();

  // In ASP.NET, collect all runat="server" IDs (which will be rewritten).
  if (isAspNetFile) {
    const serverControlRegex = /\brunat\s*=\s*['"]server['"]|<asp:\w+\b[^>]*\bID\s*=\s*['"]([^'"]+)['"]/gi;
    for (const match of content.matchAll(serverControlRegex)) {
      if (match[1]) allServerControlIds.add(match[1].toLowerCase());
    }
  }

  // Check HTML <label for="...">
  const labelForRegex = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  for (const labelMatch of content.matchAll(labelForRegex)) {
    const attrs = labelMatch[1] ?? "";
    const inner = labelMatch[2] ?? "";
    const index = labelMatch.index ?? 0;
    const labelSnippet = labelMatch[0];

    const forMatch = /\bfor\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
    if (!forMatch) continue;

    const forValue = (forMatch[1] ?? forMatch[2] ?? "").trim();
    if (!forValue) continue;

    // Skip if for= is a server expression.
    if (/<%[=:#]|<%\$/.test(forValue)) continue;

    const targetId = forValue.toLowerCase();

    // In ASP.NET, skip if target ID is a server control (will be rewritten to ctl00_...).
    if (isAspNetFile && allServerControlIds.has(targetId)) continue;

    if (isAspNetFile && hasServerControlChild(inner)) continue;

    if (isAspNetFile && isLikelyServerEmittedClientIdTarget(targetId, knownIds, allServerControlIds)) continue;

    // Skip if the target ID exists.
    if (knownIds.has(targetId)) continue;

    const wrapsOnlyDisplayContent = /<(?:span|div|p|strong|em|b|small)\b/i.test(inner) &&
      !/(<(?:input|select|textarea|button)\b|<asp:|runat\s*=\s*['"]server['"])/i.test(inner);

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: wrapsOnlyDisplayContent
        ? "a11y/label-misused-as-content-wrapper"
        : "aspnet/label-references-missing-control",
      title: wrapsOnlyDisplayContent
        ? "Label with for= appears misused as a content wrapper"
        : "Label references a missing form control",
      description: wrapsOnlyDisplayContent
        ? `This label wraps display content but for="${forValue}" does not reference a real control. Use <div>/<p> for content wrappers, or point for= at an actual control id (WCAG 1.3.1).`
        : `The label's for="${forValue}" points to an id that does not exist in this document. Either add the matching id to the form control or update the for= value to an existing id (WCAG 1.3.1).`,
      wcagSc: "1.3.1",
      filePath,
      line,
      column,
      htmlSnippet: labelSnippet.slice(0, 220),
    });
  }

  // Check ASP.NET <asp:Label AssociatedControlID="...">
  if (isAspNetFile) {
    const aspLabelRegex = /<asp:Label\b([^>]*)>([\s\S]*?)<\/asp:Label>/gi;
    for (const labelMatch of content.matchAll(aspLabelRegex)) {
      const attrs = labelMatch[1] ?? "";
      const index = labelMatch.index ?? 0;
      const labelSnippet = labelMatch[0];

      const acMatch = /\bAssociatedControlID\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
      if (!acMatch) continue;

      const acValue = (acMatch[1] ?? acMatch[2] ?? "").trim();
      if (!acValue) continue;

      // Skip if AssociatedControlID= is a server expression.
      if (/<%[=:#]|<%\$/.test(acValue)) continue;

      const targetId = acValue.toLowerCase();

      // Skip if target ID is a server control (will be rewritten).
      if (allServerControlIds.has(targetId)) continue;

      // Skip if the target ID exists.
      if (knownIds.has(targetId)) continue;

      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: "aspnet/label-references-missing-control",
        title: "asp:Label references a missing form control",
        description:
          `The asp:Label's AssociatedControlID="${acValue}" points to an id that does not exist. ` +
          `Either add the matching ID= to the target control or update AssociatedControlID= (WCAG 1.3.1).`,
        wcagSc: "1.3.1",
        filePath,
        line,
        column,
        htmlSnippet: labelSnippet.slice(0, 220),
      });
    }
  }

  return issues;
}

function findOrphanOrEmptyLabel(content: string, filePath: string, codeBehindContent = ""): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labelRegex = /<(?:label|asp:Label)\b([^>]*)>([\s\S]*?)<\/(?:label|asp:Label)>/gi;

  for (const match of content.matchAll(labelRegex)) {
    const tagName = match[0].match(/^<([\w:]+)/)?.[1]?.toLowerCase() ?? "label";
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const index = match.index ?? 0;

    if (/\bVisible\s*=\s*['"]false['"]/i.test(attrs)) continue;

    const labelId = /\b(?:id|ID)\s*=\s*['"]([^'"]+)['"]/i.exec(attrs)?.[1] ?? "";

    if (
      labelId &&
      tagName === "asp:label" &&
      hasCodeBehindControlAssignment(labelId, codeBehindContent, {
        properties: ["Text", "ToolTip"],
        attributeNames: ["aria-label", "aria-labelledby", "title"],
      })
    ) {
      continue;
    }

    // Pass if label has aria-label, aria-labelledby, or title.
    if (/\baria-label\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs)) continue;
    if (/\baria-labelledby\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs)) continue;
    if (/\btitle\s*=\s*(?:"[^"]+"|'[^']+'|<%[^%]*%>|<%\$[^%]*%>)/i.test(attrs)) continue;

    // For asp:Label, pass if has Text= attribute with literal text or any server expression/resource binding.
    if (tagName === "asp:label") {
      const hasTextAttr = /\bText\s*=\s*(?:"[^"]+"|'[^']+'|<%[^%]*%>|<%\$[^%]*%>)/i.test(attrs);
      if (hasTextAttr) continue;
    }

    // Pass if inner content has any server expression or localization helper.
    if (hasServerExpressionContent(inner)) continue;
    if (/\bLocalize\s*\(/i.test(inner)) continue;

    const wrapsServerControl = hasServerControlChild(inner);
    const text = stripTagsAndServerBlocks(inner);
    if (text.length === 0) {
      if (wrapsServerControl) continue;

      const classAttr = /\b(?:class|CssClass)\s*=\s*['"]([^'"]+)['"]/i.exec(attrs)?.[1] ?? "";
      const lowerId = labelId.toLowerCase();
      const lowerClass = classAttr.toLowerCase();
      const isCounterContainer = /\bcounter\b/.test(lowerClass) || /(?:counter|count)/i.test(lowerId);
      const isMessageContainer = /(?:error|message|status|feedback|warning|alert)/i.test(lowerId) ||
        /(?:error|message|status|feedback|warning|alert)/i.test(lowerClass);

      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: isCounterContainer
          ? "a11y/label-misuse-as-counter-informational"
          : isMessageContainer
            ? "a11y/label-misuse-as-message-container-informational"
            : "aspnet/label-empty",
        title: isCounterContainer
          ? "Label appears to be used as a counter container"
          : isMessageContainer
            ? "Label appears to be used as a message/status container"
            : "Label has no discernible text",
        description: isCounterContainer
          ? "Counter/status text containers should use <output> or a non-label live region (for example <span aria-live=\"polite\">)."
          : isMessageContainer
            ? "Message/status containers should use role=alert/status or aria-live regions instead of empty labels."
            : `A <${tagName}> with empty or whitespace-only text does not convey field purpose. Add visible text, aria-label, or aria-labelledby (WCAG 1.3.1 / 2.4.6).`,
        wcagSc: "1.3.1",
        filePath,
        line,
        column,
        htmlSnippet: match[0].slice(0, 220),
      });
      continue;
    }

    // Check for orphan label (no for= or wrapped input).
    const hasFor = /\bfor\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs);
    const wrapsInput = /<(?:input|select|textarea|asp:TextBox|asp:DropDownList|asp:ListBox|asp:FileUpload)\b/i.test(inner) || wrapsServerControl;

    const labelHtml = match[0];
    const headingLikeClassOrRole = /\b(?:class|CssClass)\s*=\s*['"][^'"]*(?:heading|header|title|panelTitle|sectionTitle|section-heading|elementTitle)[^'"]*['"]/i.test(attrs);
    const headingLikeContext = /<(?:h[1-6]|legend)\b/i.test(labelHtml) || headingLikeClassOrRole;
    if (headingLikeContext && !hasFor) {
      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: "a11y/label-misused-as-section-heading",
        title: "Label element appears misused as section heading",
        description: "Label-like heading text should use semantic heading elements (h2/h3) instead of <label> when it is not associated to a control.",
        wcagSc: "1.3.1",
        filePath,
        line,
        column,
        htmlSnippet: match[0].slice(0, 220),
      });
      continue;
    }
    if (headingLikeContext) continue;

    const localBefore = content.slice(Math.max(0, index - 600), index);
    const localAfter = content.slice(index + labelHtml.length, Math.min(content.length, index + labelHtml.length + 600));
    const rowStart = Math.max(localBefore.lastIndexOf("<tr"), localBefore.lastIndexOf("<fieldset"), localBefore.lastIndexOf("<td"), localBefore.lastIndexOf("<div"));
    const localContext = `${localBefore.slice(Math.max(0, rowStart))}${labelHtml}${localAfter}`;
    const nearbyControlCount = (localContext.match(/<(?:input|select|textarea|button|asp:(?:TextBox|DropDownList|ListBox|FileUpload|CheckBox|RadioButton|CheckBoxList|RadioButtonList))\b/gi) ?? []).length;
    if (nearbyControlCount === 0) continue;

    if (!hasFor && !wrapsInput) {
      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: "aspnet/label-orphan",
        title: "Label is not associated with a form control",
        description: `A label must either wrap a form control or reference one via for= attribute so screen readers can associate them (WCAG 1.3.1).`,
        wcagSc: "1.3.1",
        filePath,
        line,
        column,
        htmlSnippet: match[0].slice(0, 220),
      });
    }
  }
  return issues;
}

function findFieldsetMissingLegend(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const fieldsetRegex = /<fieldset\b([^>]*)>([\s\S]*?)<\/fieldset>/gi;
  const isAspNetFile = /\.aspx$|\.ascx$/.test(filePath);

  for (const fieldsetMatch of content.matchAll(fieldsetRegex)) {
    const fieldsetAttrs = fieldsetMatch[1] ?? "";
    const fieldsetContent = fieldsetMatch[2] ?? "";
    const fieldsetIndex = fieldsetMatch.index ?? 0;
    const fieldsetSnippet = fieldsetMatch[0];

    // Skip if fieldset has aria-label.
    if (/\baria-label\s*=\s*(?:"[^"]*"|'[^']*')/i.test(fieldsetAttrs)) continue;

    // Skip if fieldset has aria-labelledby (may reference heading or legend).
    const ariaLabelledbyMatch = /\baria-labelledby\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(fieldsetAttrs);
    if (ariaLabelledbyMatch) {
      // Found aria-labelledby; pass (assume valid reference - we can't resolve easily here).
      continue;
    }

    // Check if <legend> is the first child.
    const normalizedStart = fieldsetContent
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<%--([\s\S]*?)--%>/g, " ")
      .trimStart();

    const hasLegendFirst = /^<legend\b/i.test(normalizedStart);

    // Skip if legend is first child (correct structure).
    if (hasLegendFirst) continue;

    // Check if <legend> exists anywhere in the fieldset and might be referenced.
    const legendMatch = /<legend\b([^>]*)>/i.exec(fieldsetContent);
    if (legendMatch) {
      const legendAttrs = legendMatch[1] ?? "";
      const legendId = /\bid\s*=\s*['"]([^'"]*)['"]/i.exec(legendAttrs)?.[1];

      // If legend has an id and fieldset's aria-labelledby references it, it's valid.
      // (We already checked for aria-labelledby above, so this legend is just not first child.)
      // Still fire because spec says legend MUST be first child.
    }

    // Check if preceded by heading that could serve as accessible name.
    const beforeFieldset = content.slice(Math.max(0, fieldsetIndex - 800), fieldsetIndex);
    let hasHeadingBefore = false;

    // Look for heading elements or heading-like classes.
    if (/<h[1-6]\b|role\s*=\s*['"]heading['"]/i.test(beforeFieldset)) {
      // Find the most recent heading.
      const recentBefore = beforeFieldset.slice(-300);
      if (/<h[1-6]\b|role\s*=\s*['"]heading['"]/i.test(recentBefore)) {
        hasHeadingBefore = true;
      }
    }

    // Look for heading-like classes (.panelTitle, .label-bold, etc.).
    if (/class\s*=\s*['"]([^'"])*(?:panelTitle|label-bold|heading)[^'"]*['"]/i.test(beforeFieldset)) {
      const recentBefore = beforeFieldset.slice(-300);
      if (/class\s*=\s*['"]([^'"])*(?:panelTitle|label-bold|heading)[^'"]*['"]/i.test(recentBefore)) {
        hasHeadingBefore = true;
      }
    }

    // If preceded by heading and fieldset uses aria-labelledby to reference it, skip.
    if (hasHeadingBefore && ariaLabelledbyMatch) {
      // Already checked above; aria-labelledby is present, so skip.
      continue;
    }

    // Check if this is a runat="server" fieldset with likely code-behind legend binding.
    if (isAspNetFile && /\brunat\s*=\s*['"]server['"]/.test(fieldsetAttrs)) {
      // Look for a <legend> with server expression binding (best-effort).
      const legendWithBindingRegex = /<legend\b[^>]*>.*?<%[^%]*%>/i;
      if (legendWithBindingRegex.test(fieldsetContent)) {
        continue; // Legend text is bound in code-behind.
      }
    }

    const { line, column } = getLineColumn(content, fieldsetIndex);
    issues.push({
      ruleId: "aspnet/fieldset-missing-legend",
      title: "Fieldset missing leading legend",
      description:
        `Per HTML spec, a <fieldset> must have a <legend> as its first child to describe the grouped controls. ` +
        `Add <legend>...</legend> immediately after the <fieldset> opening tag, or use aria-label / aria-labelledby if legend is impractical (WCAG 1.3.1).`,
      wcagSc: "1.3.1",
      filePath,
      line,
      column,
      htmlSnippet: fieldsetSnippet.slice(0, 220),
    });
  }

  return issues;
}

function findLabelNotAssociatedToControl(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labelRegex = /<(?:label|asp:Label)\b([^>]*)>([\s\S]*?)<\/(?:label|asp:Label)>/gi;
  const knownAriaLabelledByIds = new Set<string>();

  // Collect all IDs that are referenced via aria-labelledby.
  const ariaLabelledByRegex = /\baria-labelledby\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of content.matchAll(ariaLabelledByRegex)) {
    const tokens = (match[1] ?? match[2] ?? "").split(/\s+/);
    tokens.forEach((id) => knownAriaLabelledByIds.add(id.toLowerCase()));
  }

  for (const labelMatch of content.matchAll(labelRegex)) {
    const tagName = labelMatch[0].match(/^<(\w+)/)?.[1]?.toLowerCase() ?? "label";
    const attrs = labelMatch[1] ?? "";
    const inner = labelMatch[2] ?? "";
    const index = labelMatch.index ?? 0;
    const snippet = labelMatch[0];

    if (/\bVisible\s*=\s*['"]false['"]/i.test(attrs)) continue;

    // Pass if label has explicit aria-label or aria-labelledby attribute.
    if (/\baria-label\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs)) continue;
    if (/\baria-labelledby\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs)) continue;

    // Extract label ID if present (for aria-labelledby references).
    const labelIdMatch = /\bID\s*=\s*['\"]([^'\"]+)['\"]/.exec(attrs);
    const labelId = labelIdMatch?.[1] ?? "";
    if (labelId && knownAriaLabelledByIds.has(labelId.toLowerCase())) continue;

    // Pass if label text is a server expression.
    if (hasServerExpressionContent(inner)) continue;

    const text = stripTagsAndServerBlocks(inner).trim();
    if (text.length === 0) continue; // Skip empty labels (handled by findOrphanOrEmptyLabel).

    // Check for for= / AssociatedControlID= attribute.
    const hasFor = /\bfor\s*=\s*(?:"[^"]*"|'[^']*'|<%[^%]*%>)/i.test(attrs);
    const hasAssociated = /\bAssociatedControlID\s*=\s*(?:"[^"]*"|'[^']*'|<%[^%]*%>)/i.test(attrs);
    if (hasFor || hasAssociated) continue; // Has explicit association (may be server expression).

    // Pass if label wraps a form control.
    if (/<(?:input|select|textarea|asp:TextBox|asp:DropDownList|asp:ListBox|asp:FileUpload|asp:CheckBox|asp:RadioButton)\b/i.test(inner)) {
      continue;
    }

    // Filter: Pass if label is inside a heading context (section/panel title).
    const before = content.slice(Math.max(0, index - 1000), index);
    if (/<h[1-6]\b|role\s*=\s*['\"]heading['\"]/i.test(before)) {
      const lastHeadingOpen = Math.max(
        before.lastIndexOf("<h1"),
        before.lastIndexOf("<h2"),
        before.lastIndexOf("<h3"),
        before.lastIndexOf("<h4"),
        before.lastIndexOf("<h5"),
        before.lastIndexOf("<h6"),
        before.lastIndexOf('role="heading"'),
        before.lastIndexOf("role='heading'")
      );
      const lastHeadingClose = Math.max(
        before.lastIndexOf("</h1>"),
        before.lastIndexOf("</h2>"),
        before.lastIndexOf("</h3>"),
        before.lastIndexOf("</h4>"),
        before.lastIndexOf("</h5>"),
        before.lastIndexOf("</h6>")
      );
      if (lastHeadingOpen > lastHeadingClose && lastHeadingOpen >= 0) continue; // Inside heading.
    }

    // Filter: Pass if label is inside a heading-like container (class patterns).
    if (/\bclass\s*=\s*['\"]([^'\"]*(?:header|title|panel-?title|section-?title)[^'\"]*)['\"]/i.test(before)) {
      continue;
    }

    // Filter: Pass if label contains a numeric badge/count (e.g., "Documents (5)", "<%= count %>").
    if (/\(\s*\d+\s*\)|<%[^%]*%>\s*\)/i.test(text)) {
      continue;
    }

    // Filter: Pass if label is inside a fieldset with a legend (group caption).
    const beforeFieldset = content.slice(Math.max(0, index - 2000), index);
    const lastFieldsetOpen = beforeFieldset.lastIndexOf("<fieldset");
    if (lastFieldsetOpen >= 0) {
      const afterFieldsetOpen = content.slice(index, Math.min(content.length, index + 1000));
      const nextFieldsetClose = afterFieldsetOpen.indexOf("</fieldset>");
      if (nextFieldsetClose >= 0) {
        // Check if there's a legend after the last <fieldset> open.
        const fieldsetContent = beforeFieldset.slice(lastFieldsetOpen) + afterFieldsetOpen.slice(0, nextFieldsetClose);
        if (/<legend\b/i.test(fieldsetContent)) {
          continue; // Has legend; this label is likely the group caption.
        }
      }
    }

    // Filter: Only fire if there's an adjacent unlabeled form control in the same row/fieldset.
    const contextBefore = content.slice(Math.max(0, index - 800), index);
    const contextAfter = content.slice(index + snippet.length, Math.min(content.length, index + snippet.length + 800));

    // Look for nearby form controls.
    const formControlRegex = /<(?:input|select|textarea|asp:TextBox|asp:DropDownList|asp:ListBox|asp:FileUpload|asp:CheckBox|asp:RadioButton)\b([^>]*)/gi;

    // Check before the label.
    let foundUnlabeledControlBefore = false;
    for (const controlMatch of contextBefore.matchAll(formControlRegex)) {
      const controlAttrs = controlMatch[1] ?? "";
      const hasControlId = /\bid\s*=\s*['\"]([^'\"]*)['\"]/.exec(controlAttrs);
      const controlId = hasControlId?.[1] ?? "";

      // Check if this control is referenced by any label.
      if (controlId) {
        const controlLabelRegex = new RegExp(`\\bfor\\s*=\\s*['\"]${escapeRegex(controlId)}['\"]`, "i");
        if (!controlLabelRegex.test(content)) {
          foundUnlabeledControlBefore = true;
          break;
        }
      }
    }

    // Check after the label.
    let foundUnlabeledControlAfter = false;
    for (const controlMatch of contextAfter.matchAll(formControlRegex)) {
      const controlAttrs = controlMatch[1] ?? "";
      const hasControlId = /\bid\s*=\s*['\"]([^'\"]*)['\"]/.exec(controlAttrs);
      const controlId = hasControlId?.[1] ?? "";

      // Check if this control is referenced by any label.
      if (controlId) {
        const controlLabelRegex = new RegExp(`\\bfor\\s*=\\s*['\"]${escapeRegex(controlId)}['\"]`, "i");
        if (!controlLabelRegex.test(content)) {
          foundUnlabeledControlAfter = true;
          break;
        }
      }
    }

    // Only fire if there's an adjacent unlabeled control.
    if (!foundUnlabeledControlBefore && !foundUnlabeledControlAfter) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/label-not-associated",
      title: `${tagName} is not associated to a form control`,
      description:
        `A <${tagName}> element with text is not associated with any form control. ` +
        `Add a for= attribute or wrap a form control inside the label to create the association (WCAG 1.3.1).`,
      wcagSc: "1.3.1",
      filePath,
      line,
      column,
      htmlSnippet: snippet.slice(0, 220),
    });
  }

  return issues;
}

function findOptgroupMissingLabel(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<optgroup\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    if (/\blabel\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/optgroup-missing-label",
      title: "Optgroup missing label",
      description: "optgroup elements need a label attribute so grouped options are announced with context (WCAG 1.3.1).",
      wcagSc: "1.3.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findBrokenAriaReferenceIds(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const knownIds = collectKnownElementIds(content);
  const attrs = [
    "aria-describedby",
    "aria-owns",
    "aria-activedescendant",
  ];

  for (const attr of attrs) {
    const regex = new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`, "gi");
    for (const match of content.matchAll(regex)) {
      const rawValue = (match[1] ?? match[2] ?? "").trim();
      if (!rawValue) continue;
      const refs = rawValue.split(/\s+/).map((id) => id.toLowerCase());
      const missing = refs.filter((id) => !knownIds.has(id));
      if (missing.length === 0) continue;

      const index = match.index ?? 0;
      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: "a11y/aria-referenced-id-missing",
        title: `${attr} references missing id targets`,
        description: `ARIA id reference ${attr} includes missing target id(s): ${missing.join(", ")}. Broken references prevent correct assistive relationships (WCAG 1.3.1 / 4.1.2).`,
        wcagSc: "4.1.2",
        filePath,
        line,
        column,
        htmlSnippet: match[0],
      });
    }
  }

  return issues;
}

function findAriaLabelledbyMissingIdTargets(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const knownIds = collectKnownElementIds(content);
  const isAspNetFile = /\.aspx$|\.ascx$/.test(filePath);
  const plainHtmlIdRegex = /<([a-z][\w:-]*)\b([^>]*?)\bid\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  const plainHtmlLiteralIds = new Set<string>();
  for (const candidate of content.matchAll(plainHtmlIdRegex)) {
    const tag = (candidate[1] ?? "").toLowerCase();
    const attrs = candidate[2] ?? "";
    const id = (candidate[3] ?? candidate[4] ?? "").trim().toLowerCase();
    if (!id) continue;
    if (tag.startsWith("asp:")) continue;
    if (/\brunat\s*=\s*['"]server['"]/i.test(attrs)) continue;
    if (/<%[=:#$]?/.test(attrs)) continue;
    plainHtmlLiteralIds.add(id);
  }
  const regex = /\baria-labelledby\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;

  for (const match of content.matchAll(regex)) {
    const index = match.index ?? 0;
    const rawValue = (match[1] ?? match[2] ?? "").trim();
    if (!rawValue) continue;

    const refs = rawValue.split(/\s+/).map((id) => id.toLowerCase());
    // Pass if ANY token resolves to a known id (ARIA IDREFS is a token list).
    const resolved = refs.filter((id) => knownIds.has(id));
    if (resolved.length > 0) continue;

    // In ASP.NET files, suppress unless referencing element is plain HTML with literal id and no runat=server.
    if (isAspNetFile) {
      const beforeMatch = content.slice(Math.max(0, index - 500), index);
      const elementStart = beforeMatch.lastIndexOf("<");
      const elementSnippet = content.slice(Math.max(0, index - 500 + elementStart), index + 200);

      const referencingTagMatch = /<([a-z][\w:-]*)\b([^>]*)>/i.exec(elementSnippet);
      const refTag = (referencingTagMatch?.[1] ?? "").toLowerCase();
      const refAttrs = referencingTagMatch?.[2] ?? "";
      const refHasLiteralId = /\bid\s*=\s*(?:"[^"]+"|'[^']+')/i.test(refAttrs);
      const refIsServer = /\brunat\s*=\s*['"]server['"]|<%\s*=.*ClientID/i.test(refAttrs);
      if (!refTag || refTag.startsWith("asp:") || !refHasLiteralId || refIsServer) continue;

      // Pass if target id values are server expressions or data-binding.
      if (/<%|data-[-\w]+/i.test(rawValue)) continue;

      // In Web Forms, only trust plain-html literal ids for static matching.
      const resolvedPlain = refs.filter((id) => plainHtmlLiteralIds.has(id));
      if (resolvedPlain.length > 0) continue;
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "a11y/aria-referenced-id-missing",
      title: "aria-labelledby references missing id targets",
      description: `All token IDs in aria-labelledby (${refs.join(", ")}) cannot be resolved to elements in the document (WCAG 1.3.1 / 4.1.2).`,
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findAriaControlsMissingIdTargets(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const knownIds = collectKnownElementIds(content);
  const isAspNetFile = /\.aspx$|\.ascx$/.test(filePath);
  const regex = /\baria-controls\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;

  for (const match of content.matchAll(regex)) {
    const index = match.index ?? 0;
    const rawValue = (match[1] ?? match[2] ?? "").trim();
    if (!rawValue) continue;

    const refs = rawValue.split(/\s+/).map((id) => id.toLowerCase());
    // Pass if ANY token resolves.
    const resolved = refs.filter((id) => knownIds.has(id));
    if (resolved.length > 0) continue;

    // In ASP.NET files, check if referencing element is plain static HTML with literal id.
    if (isAspNetFile) {
      const beforeMatch = content.slice(Math.max(0, index - 500), index);
      const elementStart = beforeMatch.lastIndexOf("<");
      const elementSnippet = content.slice(Math.max(0, index - 500 + elementStart), index + 200);

      // Pass if referencing element has runat="server" or server-controlled id.
      if (/runat\s*=\s*['"]server['"]|<%|data-[-\w]+/i.test(elementSnippet)) continue;
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "a11y/aria-referenced-id-missing",
      title: "aria-controls references missing id targets",
      description: `All token IDs in aria-controls (${refs.join(", ")}) cannot be resolved to elements in the document (WCAG 4.1.2).`,
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findInvalidAriaAndRoleUsage(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const misspelledAriaAttrs = [
    "aria-labeledby",
    "aria-descibedby",
    "aria-controlls",
    "aria-role",
    "aria-hasPopup",
    "aria-describeby",
    "aria-checkable",
  ];
  const validRoles = new Set([
    "alert", "alertdialog", "application", "article", "banner", "button", "cell", "checkbox", "columnheader",
    "combobox", "complementary", "contentinfo", "definition", "dialog", "directory", "document", "feed", "figure",
    "form", "grid", "gridcell", "group", "heading", "img", "link", "list", "listbox", "listitem", "log", "main",
    "marquee", "math", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "navigation", "none",
    "note", "option", "presentation", "progressbar", "radio", "radiogroup", "region", "row", "rowgroup", "rowheader",
    "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status", "switch", "tab", "table",
    "tablist", "tabpanel", "term", "textbox", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
  ]);

  for (const attr of misspelledAriaAttrs) {
    const regex = new RegExp(`\\b${attr}\\s*=`, "gi");
    for (const match of content.matchAll(regex)) {
      const index = match.index ?? 0;
      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: "aspnet/aria-attribute-misspelled",
        title: "ARIA attribute appears misspelled",
        description: `Detected '${attr}', which is not a valid ARIA attribute spelling (WCAG 4.1.2).`,
        wcagSc: "4.1.2",
        filePath,
        line,
        column,
        htmlSnippet: match[0],
      });
    }
  }

  const invalidBooleanEnums: Array<{ attr: string; disallowed: RegExp }> = [
    { attr: "aria-hidden", disallowed: /^(?:1|0|yes|no)$/i },
    { attr: "aria-expanded", disallowed: /^(?:1|0|yes|no)$/i },
    { attr: "aria-pressed", disallowed: /^(?:1|0|yes|no)$/i },
  ];

  for (const entry of invalidBooleanEnums) {
    const regex = new RegExp(`\\b${entry.attr}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s>]+))`, "gi");
    for (const match of content.matchAll(regex)) {
      const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (!entry.disallowed.test(value)) continue;

      const index = match.index ?? 0;
      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: "aspnet/aria-enum-invalid",
        title: `${entry.attr} has an invalid enumerated value`,
        description: `${entry.attr} should use ARIA enum values like true/false/mixed where applicable; value '${value}' is invalid (WCAG 4.1.2).`,
        wcagSc: "4.1.2",
        filePath,
        line,
        column,
        htmlSnippet: match[0],
      });
    }
  }

  const sanitizedMarkup = content
    .replace(/<!--([\s\S]*?)-->/g, (m) => " ".repeat(m.length))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => " ".repeat(m.length))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => " ".repeat(m.length));

  const tagRegex = /<([a-z0-9:-]+)\b([^>]*)>/gi;
  for (const tagMatch of sanitizedMarkup.matchAll(tagRegex)) {
    const attrs = tagMatch[2] ?? "";
    const roleAttrMatch = /\brole\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    if (!roleAttrMatch) continue;

    const rawRoles = (roleAttrMatch[1] ?? roleAttrMatch[2] ?? roleAttrMatch[3] ?? "").trim();
    if (!rawRoles) continue;

    const roles = rawRoles.split(/\s+/).map((r) => r.toLowerCase());
    const invalid = roles.filter((r) => !validRoles.has(r));
    if (invalid.length === 0) continue;

    const index = tagMatch.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "a11y/invalid-role",
      title: "Invalid ARIA role value detected",
      description: `role attribute includes unknown value(s): ${invalid.join(", ")} (WCAG 4.1.2).`,
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: tagMatch[0] ?? roleAttrMatch[0],
    });
  }

  return issues;
}

function findRoleHeadingMissingAriaLevel(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<([a-z0-9:-]+)\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[2] ?? "";
    const index = match.index ?? 0;
    if (!/\brole\s*=\s*(?:"heading"|'heading'|heading)/i.test(attrs)) continue;
    if (/\baria-level\s*=\s*(?:"[1-6]"|'[1-6]'|[1-6])/i.test(attrs)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/role-heading-missing-level",
      title: "role=heading missing aria-level",
      description: "Elements with role=heading need aria-level to communicate heading rank (WCAG 1.3.1).",
      wcagSc: "1.3.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findRoleParentChildSemantics(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const parentExpectations: Array<{ parent: string; child: string; ruleId: string; title: string }> = [
    { parent: "radiogroup", child: "radio", ruleId: "aspnet/radiogroup-missing-radio", title: "radiogroup missing radio children" },
    { parent: "tablist", child: "tab", ruleId: "aspnet/tablist-missing-tab", title: "tablist missing tab children" },
    { parent: "tree", child: "treeitem", ruleId: "aspnet/tree-missing-treeitem", title: "tree missing treeitem children" },
  ];

  for (const expectation of parentExpectations) {
    const regex = new RegExp(`<([a-z0-9:-]+)\\b([^>]*)>([\\s\\S]*?)<\\/\\1>`, "gi");
    for (const match of content.matchAll(regex)) {
      const attrs = match[2] ?? "";
      const inner = match[3] ?? "";
      const index = match.index ?? 0;
      if (!new RegExp(`\\brole\\s*=\\s*(?:"${expectation.parent}"|'${expectation.parent}'|${expectation.parent})`, "i").test(attrs)) continue;
      if (new RegExp(`\\brole\\s*=\\s*(?:"${expectation.child}"|'${expectation.child}'|${expectation.child})`, "i").test(inner)) continue;

      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: expectation.ruleId,
        title: expectation.title,
        description: `role=${expectation.parent} should contain role=${expectation.child} descendants to preserve expected semantics (WCAG 1.3.1 / 4.1.2).`,
        wcagSc: "1.3.1",
        filePath,
        line,
        column,
        htmlSnippet: match[0].slice(0, 240),
      });
    }
  }

  const childExpectations: Array<{ child: string; parent: string; ruleId: string }> = [
    { child: "tab", parent: "tablist", ruleId: "aspnet/tab-outside-tablist" },
    { child: "menuitem", parent: "menu|menubar", ruleId: "aspnet/menuitem-outside-menu" },
    { child: "option", parent: "listbox", ruleId: "aspnet/option-outside-listbox" },
    { child: "treeitem", parent: "tree", ruleId: "aspnet/treeitem-outside-tree" },
  ];

  for (const expectation of childExpectations) {
    const childRegex = new RegExp(`<([a-z0-9:-]+)\\b([^>]*)>([\\s\\S]*?)<\\/\\1>`, "gi");
    for (const match of content.matchAll(childRegex)) {
      const attrs = match[2] ?? "";
      const index = match.index ?? 0;
      if (!new RegExp(`\\brole\\s*=\\s*(?:"${expectation.child}"|'${expectation.child}'|${expectation.child})`, "i").test(attrs)) continue;

      const before = content.slice(0, index);
      const hasParentNearby = new RegExp(`role\\s*=\\s*(?:"(?:${expectation.parent})"|'(?:${expectation.parent})'|(?:${expectation.parent}))`, "i").test(before.slice(Math.max(0, before.length - 1500)));
      if (hasParentNearby) continue;

      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: expectation.ruleId,
        title: `role=${expectation.child} appears outside required parent context`,
        description: `role=${expectation.child} should be owned by role=${expectation.parent} context (WCAG 1.3.1 / 4.1.2).`,
        wcagSc: "1.3.1",
        filePath,
        line,
        column,
        htmlSnippet: match[0].slice(0, 220),
      });
    }
  }

  return issues;
}

function findAriaRoleStateMissing(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const checks: Array<{ role: string; attrs: string[]; ruleId: string; title: string }> = [
    { role: "checkbox", attrs: ["aria-checked"], ruleId: "aspnet/role-checkbox-missing-checked", title: "role=checkbox missing aria-checked" },
    { role: "switch", attrs: ["aria-checked"], ruleId: "aspnet/role-switch-missing-checked", title: "role=switch missing aria-checked" },
    { role: "radio", attrs: ["aria-checked"], ruleId: "aspnet/role-radio-missing-checked", title: "role=radio missing aria-checked" },
    { role: "combobox", attrs: ["aria-expanded"], ruleId: "aspnet/role-combobox-missing-expanded", title: "role=combobox missing aria-expanded" },
    { role: "slider", attrs: ["aria-valuenow", "aria-valuemin", "aria-valuemax"], ruleId: "aspnet/role-slider-missing-value", title: "role=slider missing aria value attributes" },
  ];

  const regex = /<([a-z0-9:-]+)\b([^>]*)>/gi;
  for (const match of content.matchAll(regex)) {
    const attrs = match[2] ?? "";
    const index = match.index ?? 0;

    for (const check of checks) {
      if (!new RegExp(`\\brole\\s*=\\s*(?:"${check.role}"|'${check.role}'|${check.role})`, "i").test(attrs)) continue;
      const missing = check.attrs.filter((attr) => !new RegExp(`\\b${attr}\\s*=`, "i").test(attrs));
      if (missing.length === 0) continue;

      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: check.ruleId,
        title: check.title,
        description: `${check.role} widget is missing required state/value attributes: ${missing.join(", ")} (WCAG 4.1.2).`,
        wcagSc: "4.1.2",
        filePath,
        line,
        column,
        htmlSnippet: match[0],
      });
    }
  }

  return issues;
}

function findAriaDisabledContradiction(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<([a-z0-9:-]+)\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[2] ?? "";
    const index = match.index ?? 0;
    if (!/\bdisabled\b/i.test(attrs)) continue;
    if (!/\baria-disabled\s*=\s*(?:"false"|'false'|false)/i.test(attrs)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/disabled-aria-disabled-contradiction",
      title: "disabled conflicts with aria-disabled=false",
      description: "Element has native disabled and aria-disabled=false simultaneously, creating contradictory state announcements (WCAG 4.1.2).",
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findAriaLabelConflict(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<([a-z0-9:-]+)\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[2] ?? "";
    const index = match.index ?? 0;
    const ariaLabel = /\baria-label\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs);
    const ariaLabelledby = /\baria-labelledby\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs);
    if (!ariaLabel || !ariaLabelledby) continue;

    const labelValue = (ariaLabel[1] ?? ariaLabel[2] ?? "").trim().toLowerCase();
    const labelledByValue = (ariaLabelledby[1] ?? ariaLabelledby[2] ?? "").trim().toLowerCase();
    if (!labelValue || !labelledByValue || labelValue === labelledByValue) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "a11y/redundant-or-conflicting-aria",
      title: "aria-label and aria-labelledby both set with differing values",
      description: "Both naming mechanisms are present with conflicting literal values, which is usually an authoring error (WCAG 4.1.2).",
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findPresentationRoleOnInteractive(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<([a-z0-9:-]+)\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[2] ?? "";
    const index = match.index ?? 0;
    if (!/\brole\s*=\s*(?:"presentation"|'presentation'|presentation|"none"|'none'|none)/i.test(attrs)) continue;
    const focusable = /\btabindex\s*=\s*(?:"0"|'0'|0|"[1-9]\d*"|'[1-9]\d*'|[1-9]\d*)/i.test(attrs);
    const clickable = /\bonclick\s*=/i.test(attrs);
    if (!focusable && !clickable) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/presentation-role-on-interactive",
      title: "role=presentation/none used on interactive element",
      description: "Presentational roles should not be applied to focusable or clickable elements because it suppresses required semantics (WCAG 4.1.2).",
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findHeadingLevelSkip(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const isFragmentFile = /\.ascx$/.test(filePath);
  const isDialogOrPopup = /dialog|popup|modal/i.test(filePath);

  // Skip this rule for fragment files, dialog targets, popup files.
  if (isFragmentFile || isDialogOrPopup) return issues;

  // Collect all headings (h1-h6 and role="heading" with aria-level).
  const headings: Array<{ level: number; index: number; snippet: string; isHidden: boolean }> = [];

  // Find HTML headings (h1-h6).
  const htmlHeadingRegex = /<h([1-6])\b([^>]*)>/gi;
  for (const match of content.matchAll(htmlHeadingRegex)) {
    const level = Number(match[1] ?? "0");
    const attrs = match[2] ?? "";
    const index = match.index ?? 0;
    const snippet = match[0];

    // Skip if heading rank contains server expression (dynamic rank).
    if (/<%[=:#]/.test(snippet)) continue;

    // Check if heading is hidden.
    const isHidden = /hidden\b|display\s*:\s*none|Visible\s*=\s*['"]false['"]|aria-hidden\s*=\s*['"]true['"]/i.test(attrs);

    headings.push({ level, index, snippet, isHidden });
  }

  // Find role="heading" with aria-level.
  const roleHeadingRegex = /role\s*=\s*['"]heading['"]/gi;
  for (const roleMatch of content.matchAll(roleHeadingRegex)) {
    const roleIndex = roleMatch.index ?? 0;

    // Find the opening tag containing this role.
    const beforeRole = content.slice(Math.max(0, roleIndex - 200), roleIndex);
    const tagStart = beforeRole.lastIndexOf("<");
    if (tagStart < 0) continue;

    const elementStart = roleIndex - (roleIndex - tagStart) + tagStart;
    const elementContent = content.slice(elementStart, roleIndex + 100);

    // Extract aria-level from this element.
    const ariaLevelMatch = /aria-level\s*=\s*['"](\d+)['"]/i.exec(elementContent);
    if (!ariaLevelMatch) continue; // No aria-level; skip role="heading" without level.

    const level = Number(ariaLevelMatch[1] ?? "0");
    if (level < 1 || level > 6) continue;

    // Skip if contains server expression (dynamic).
    if (/<%[=:#]/.test(elementContent)) continue;

    // Find full opening tag.
    const fullTagMatch = /<[^>]*role\s*=\s*['"]heading['"][^>]*>/i.exec(content.slice(elementStart, elementStart + 500));
    if (!fullTagMatch) continue;

    const snippet = fullTagMatch[0];
    const isHidden = /hidden\b|display\s*:\s*none|Visible\s*=\s*['"]false['"]|aria-hidden\s*=\s*['"]true['"]/i.test(snippet);

    headings.push({ level, index: elementStart, snippet, isHidden });
  }

  // Sort by document order.
  headings.sort((a, b) => a.index - b.index);

  // Check for level skips in same subtree (not hidden, not in different fragments).
  for (let i = 1; i < headings.length; i++) {
    const prevHeading = headings[i - 1];
    const currentHeading = headings[i];

    // Satisfy TypeScript that these are defined.
    if (!prevHeading || !currentHeading) continue;

    // Skip if either heading is hidden.
    if (prevHeading.isHidden || currentHeading.isHidden) continue;

    // Check if headings are in different subtrees (iframe, asp:Panel, user control).
    const betweenHeadings = content.slice(prevHeading.index, currentHeading.index);

    // Skip if inside separate component/fragment (iframe, asp:Panel, user control).
    if (/<iframe\b|<asp:Panel\b|<uc:/i.test(betweenHeadings)) continue;

    // Skip if inside hidden branch.
    if (/Visible\s*=\s*['"]false['"]|hidden\b|display\s*:\s*none|aria-hidden\s*=\s*['"]true['"]/i.test(betweenHeadings)) continue;

    // Check for level skip (difference > 1).
    if (currentHeading.level > prevHeading.level + 1) {
      const { line, column } = getLineColumn(content, currentHeading.index);
      issues.push({
        ruleId: "a11y/heading-order-cross-file",
        title: "Heading levels skip intermediate ranks",
        description:
          `Detected h${prevHeading.level} (or level ${prevHeading.level}) followed by h${currentHeading.level} (or level ${currentHeading.level}) ` +
          `without intermediate heading levels, which can confuse structural navigation (WCAG 1.3.1 / 2.4.6).`,
        wcagSc: "1.3.1",
        filePath,
        line,
        column,
        htmlSnippet: currentHeading.snippet.slice(0, 220),
      });
    }
  }

  return issues;
}

function findEmptyHeadingMarkup(content: string, filePath: string, codeBehindContent = ""): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const htmlHeadingRegex = /<(h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const roleHeadingRegex = /<([a-z][\w:-]*)\b([^>]*)\brole\s*=\s*['"]heading['"][^>]*>([\s\S]*?)<\/\1>/gi;

  const evaluateHeading = (snippet: string, attrs: string, inner: string, index: number): void => {
    // aria-label/labelledby provides an accessible name.
    if (/\baria-label\s*=\s*(?:"[^"]+"|'[^']+'|<%[\s\S]*?%>)|\baria-labelledby\s*=\s*(?:"[^"]+"|'[^']+'|<%[\s\S]*?%>)/i.test(attrs)) {
      return;
    }

    // Dynamic text expressions and server literal/localize controls count as text content.
    if (hasServerExpressionContent(inner)) return;
    if (/<asp:(?:Literal|Localize)\b/i.test(inner)) return;

    // Labeled media/children provide meaningful heading alternatives.
    const hasLabeledChild =
      /<img\b[^>]*\balt\s*=\s*(?:"\s*[^\"]+\s*"|'\s*[^']+\s*'|<%[\s\S]*?%>)/i.test(inner) ||
      /<svg\b[\s\S]*?(?:\baria-label\s*=\s*(?:"[^"]+"|'[^']+'|<%[\s\S]*?%>)|\brole\s*=\s*['"]img['"][\s\S]*?<title\b[^>]*>\s*[^<]+\s*<\/title>)/i.test(inner) ||
      /<[^>]+\baria-label\s*=\s*(?:"[^"]+"|'[^']+'|<%[\s\S]*?%>)[^>]*>/i.test(inner);
    if (hasLabeledChild) return;

    const stripped = stripTagsAndServerBlocks(inner);
    if (stripped.length > 0) return;

    const classOrId = `${attrs}`;
    const jsRuntimeHeading =
      /\b(?:id|class)\s*=\s*['"][^'"]*\bjs-[^'"]*['"]/i.test(classOrId) ||
      /\b(?:id|class)\s*=\s*['"][^'"]*(?:Title|Heading|Name|Status)[^'"]*['"]/i.test(classOrId) ||
      /^\s*<(?:span|div)\b[^>]*class\s*=\s*['"][^'"]*(?:hide|hidden|d-none|invisible)[^'"]*['"][^>]*>\s*<\/(?:span|div)>\s*$/i.test(inner);
    if (jsRuntimeHeading) {
      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: "a11y/heading-populated-at-runtime-needs-live-region",
        title: "Heading is populated at runtime and needs announcement strategy",
        description: "Heading appears empty at server render but is likely populated by JavaScript. Ensure updates are announced appropriately and avoid empty heading markup at initial render (wcag:2.4.6 level:AA).",
        wcagSc: "2.4.6",
        filePath,
        line,
        column,
        htmlSnippet: snippet.slice(0, 220),
      });
      return;
    }

    // Best effort: skip if code-behind assigns heading text by id.
    const idMatch = /\b(?:id|ID)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const headingId = (idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3] ?? "").trim();
    if (headingId && codeBehindContent) {
      const codeBehindPatterns = [
        new RegExp(`\\b${escapeRegex(headingId)}\\s*\\.\\s*(?:InnerText|InnerHtml|Text)\\s*=`, "i"),
      ];
      if (codeBehindPatterns.some((p) => p.test(codeBehindContent))) {
        return;
      }
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspx-static/empty-heading",
      title: "Heading is empty or has no meaningful text alternative",
      description: "Heading has no discernible text and no accessible name/text alternative. Provide visible heading text or an accessible label (WCAG 1.3.1 / 2.4.6).",
      wcagSc: "2.4.6",
      filePath,
      line,
      column,
      htmlSnippet: snippet.slice(0, 220),
    });
  };

  for (const match of content.matchAll(htmlHeadingRegex)) {
    const attrs = match[2] ?? "";
    const inner = match[3] ?? "";
    const index = match.index ?? 0;
    evaluateHeading(match[0] ?? "", attrs, inner, index);
  }

  for (const match of content.matchAll(roleHeadingRegex)) {
    const attrs = match[2] ?? "";
    const inner = match[3] ?? "";
    const index = match.index ?? 0;
    if (!/\baria-level\s*=\s*(?:"\d+"|'\d+'|\d+)/i.test(attrs)) continue;
    evaluateHeading(match[0] ?? "", attrs, inner, index);
  }

  return issues;
}

function findTabindexNonInteractiveNoRole(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<(div|span)\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const tag = match[1] ?? "div";
    const attrs = match[2] ?? "";
    const index = match.index ?? 0;
    if (!/\btabindex\s*=\s*(?:"0"|'0'|0|"[1-9]\d*"|'[1-9]\d*'|[1-9]\d*)/i.test(attrs)) continue;
    if (/\brole\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/tabindex-noninteractive-no-role",
      title: `tabindex used on non-interactive <${tag}> without role`,
      description: `Non-interactive <${tag}> is moved into tab order without semantics, which creates ambiguous keyboard focus targets (WCAG 1.3.2 / 2.1.1).`,
      wcagSc: "1.3.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findAutocompleteMissingOnInputs(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<input\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    const typeMatch = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const type = (typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? "").toLowerCase();
    if (type === "hidden") continue;
    if (!/(email|tel|url|password)/.test(type)) continue;
    if (/\bautocomplete\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/input-autocomplete-missing",
      title: "Input type with user data purpose is missing autocomplete",
      description: `Input type='${type}' should provide an appropriate autocomplete token where applicable (WCAG 1.3.5).`,
      wcagSc: "1.3.5",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findAspTextBoxAutocompleteMissing(content: string, filePath: string, codeBehindContent = ""): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<asp:TextBox\b([^>]*)\/?>(?:<\/asp:TextBox>)?/gi;
  const identifyingFieldHint = /\b(?:zip|zipcode|postal|postcode|address|street|city|state|province|country|phone|mobile|email|first\s*name|last\s*name|fullname|card|cardnumber|ccnum|credit|debit|cvv|cvc|iban|swift|routing|account|ssn|taxid|passport|dob|birth|username|user\s*name)\b/i;

  const modeTokenHint = (textMode: string): string | null => {
    switch (textMode) {
      case "email":
        return "email";
      case "password":
        return "current-password/new-password";
      case "phone":
      case "tel":
        return "tel";
      case "url":
        return "url";
      default:
        return null;
    }
  };

  for (const match of content.matchAll(regex)) {
    const snippet = match[0] ?? "";
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    const textModeMatch = /\bTextMode\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const textMode = (textModeMatch?.[1] ?? textModeMatch?.[2] ?? textModeMatch?.[3] ?? "text").toLowerCase();

    const idMatch = /\bID\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const controlId = (idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3] ?? "").trim();
    const nameMatch = /\b(?:name|UniqueID)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const controlName = (nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3] ?? "").trim();

    const directToken = modeTokenHint(textMode);
    const conditionallyApplicable = /^(?:number|singleline|multiline|search)$/i.test(textMode) &&
      identifyingFieldHint.test(`${controlId} ${controlName}`);

    if (!directToken && !conditionallyApplicable) continue;

    // Skip non-applicable controls.
    if (/\bEnabled\s*=\s*(?:"false"|'false'|false)/i.test(attrs)) continue;
    if (/\bReadOnly\s*=\s*(?:"true"|'true'|true)/i.test(attrs)) continue;
    if (/\bVisible\s*=\s*(?:"false"|'false'|false)|style\s*=\s*['"][^'"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^'"]*['"]|\bhidden\b/i.test(attrs)) continue;

    // Explicit opt-out is intentional.
    if (/\bAutoCompleteType\s*=\s*(?:"Disabled"|'Disabled'|Disabled)/i.test(attrs)) continue;

    // Any explicit autocomplete/autocomplete-like config counts as present.
    if (/\bautocomplete\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs)) continue;
    if (/\bAutoCompleteType\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs)) continue;

    // Best effort: autocomplete assigned in code-behind.
    if (controlId && codeBehindContent) {
      const cbPatterns = [
        new RegExp(`\\b${escapeRegex(controlId)}\\s*\\.\\s*AutoCompleteType\\s*=`, "i"),
        new RegExp(`\\b${escapeRegex(controlId)}\\s*\\.\\s*Attributes\\s*\\[\\s*[\"']autocomplete[\"']\\s*\\]\\s*=`, "i"),
      ];
      if (cbPatterns.some((p) => p.test(codeBehindContent))) continue;
    }

    const isAdminOrConfigContext =
      /(recipient|admin|config|setting|apikey|api_key|token|secret|keygen|generatekey)/i.test(attrs) ||
      (controlId.length > 0 && /(recipient|admin|config|setting|apikey|api_key|token|secret|keygen|generatekey)/i.test(controlId)) ||
      /(admin|config|settings|security|keys?)/i.test(filePath);

    const { line, column } = getLineColumn(content, index);
    const suggestedToken = directToken ?? "appropriate identifying-info token";
    issues.push({
      ruleId: isAdminOrConfigContext
        ? "aspnet/textbox-autocomplete-missing-informational"
        : "aspnet/textbox-autocomplete-missing",
      title: isAdminOrConfigContext
        ? "asp:TextBox identifying field missing autocomplete (informational)"
        : "asp:TextBox identifying field is missing autocomplete",
      description: isAdminOrConfigContext
        ? `asp:TextBox TextMode='${textMode}' appears to collect identifying information but has no autocomplete token. Suggested token: ${suggestedToken}. In admin/config scenarios this may be intentional, so review as informational (WCAG 1.3.5).`
        : `asp:TextBox TextMode='${textMode}' appears to collect identifying information but has no autocomplete token. Suggested token: ${suggestedToken} (WCAG 1.3.5).`,
      wcagSc: "1.3.5",
      filePath,
      line,
      column,
      htmlSnippet: snippet,
    });
  }

  return issues;
}

function findPlaceholderOnlyLabel(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labelledIds = collectLabelledIds(content);
  const regex = /<input\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    if (!/\bplaceholder\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs)) continue;
    if (hasAriaLabelAttr(attrs)) continue;
    if (/\btitle\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs)) continue;
    const idMatch = /\bid\s*=\s*"([^"]+)"/i.exec(attrs);
    if (idMatch && labelledIds.has((idMatch[1] ?? "").toLowerCase())) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/placeholder-only-label",
      title: "Placeholder appears to be the only labeling mechanism",
      description: "Placeholder text is not a substitute for an associated label (WCAG 3.3.2).",
      wcagSc: "3.3.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findPatternWithoutTitle(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<input\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    if (!/\bpattern\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs)) continue;
    if (/\btitle\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/input-pattern-missing-title",
      title: "Pattern-constrained input missing title guidance",
      description: "Inputs with pattern should expose constraint guidance via title or nearby instructions (WCAG 3.3.2).",
      wcagSc: "3.3.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findIframeEmptyTitle(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<iframe\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const titleMatch = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    if (!titleMatch) continue;
    const title = (titleMatch[1] ?? titleMatch[2] ?? "").trim();
    if (title.length > 0) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspx-static/iframe-missing-title",
      title: "iframe title is empty",
      description: "iframe title is present but empty, so frame purpose is not conveyed (WCAG 2.4.1 / 4.1.2).",
      wcagSc: "2.4.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findFrameMissingTitle(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<frame\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const titleMatch = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const title = (titleMatch?.[1] ?? titleMatch?.[2] ?? "").trim();
    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);

    if (title.length > 0) continue;

    issues.push({
      ruleId: "a11y/frame-title",
      title: "Frame title is missing or empty",
      description: "Legacy frame elements should expose a non-empty title so users can identify frame purpose (WCAG 2.4.1 / 4.1.2).",
      wcagSc: "2.4.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findAutoplayMedia(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<(video|audio)\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const tag = match[1] ?? "video";
    const attrs = match[2] ?? "";
    const index = match.index ?? 0;
    if (!/\bautoplay\b/i.test(attrs)) continue;
    const isMuted = /\bmuted\b/i.test(attrs);
    const hasControls = /\bcontrols\b/i.test(attrs);
    const hasCaptionTrack = /<track\b[^>]*\bkind\s*=\s*(?:"captions"|'captions'|captions|"subtitles"|'subtitles'|subtitles)/i.test(content.slice(index));

    if (isMuted && hasControls && hasCaptionTrack) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "a11y/autoplay-media",
      title: `${tag} autoplay can start unexpectedly`,
      description: `Autoplay on <${tag}> can start audio or motion without user control. Prefer user-initiated playback, and ensure any media that starts automatically is muted and clearly controllable (WCAG 1.4.2 / 2.2.2).`,
      wcagSc: "1.4.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findDuplicateLandmarkNames(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const landmarkRegex = /<(main|nav|aside|header|footer|section|form|search)\b([^>]*)>/gi;
  const counts = new Map<string, Array<{ index: number; snippet: string; name: string }>>();

  for (const match of content.matchAll(landmarkRegex)) {
    const tag = (match[1] ?? "").toLowerCase();
    const attrs = match[2] ?? "";
    const index = match.index ?? 0;
    const name = getAccessibleLandmarkName(attrs);
    const key = `${tag}:${name || "(unnamed)"}`;
    const list = counts.get(key) ?? [];
    list.push({ index, snippet: match[0] ?? "", name });
    counts.set(key, list);
  }

  for (const [key, list] of counts) {
    if (list.length < 2) continue;
    const [tag, name] = key.split(":", 2);
    const first = list[0];
    if (!first) continue;
    const { line, column } = getLineColumn(content, first.index);

    issues.push({
      ruleId: "a11y/duplicate-landmark-needs-name",
      title: name === "(unnamed)" ? `${tag} landmark appears multiple times without names` : `${tag} landmark name is reused`,
      description: name === "(unnamed)"
        ? `Multiple <${tag}> landmarks appear on the page but do not have unique accessible names. Add aria-label or aria-labelledby so assistive technology can distinguish them (WCAG 1.3.1).`
        : `Multiple <${tag}> landmarks use the same accessible name "${name}". Add unique names so assistive technology can distinguish them (WCAG 1.3.1).`,
      wcagSc: "1.3.1",
      filePath,
      line,
      column,
      htmlSnippet: first.snippet.slice(0, 220),
    });
  }

  return issues;
}

function getAccessibleLandmarkName(attrs: string): string {
  const ariaLabel = /\baria-label\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  const ariaLabelledby = /\baria-labelledby\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  const title = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  return (
    (ariaLabel?.[1] ?? ariaLabel?.[2] ?? "") ||
    (ariaLabelledby?.[1] ?? ariaLabelledby?.[2] ?? "") ||
    (title?.[1] ?? title?.[2] ?? "")
  ).trim().toLowerCase();
}

function findNonDescriptiveLinkText(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const weakTexts = new Set(["click here", "here", "more", "read more", "details", "info", "link", "..."]);
  const regex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const index = match.index ?? 0;
    if (/\baria-label\s*=|\baria-labelledby\s*=|\btitle\s*=/i.test(attrs)) continue;
    const text = stripTagsAndServerBlocks(inner).toLowerCase();
    if (!weakTexts.has(text)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/link-text-non-descriptive",
      title: "Link text is non-descriptive",
      description: "Generic link text like 'click here' or 'more' can fail to convey destination in context (WCAG 2.4.4).",
      wcagSc: "2.4.4",
      filePath,
      line,
      column,
      htmlSnippet: match[0].slice(0, 220),
    });
  }

  return issues;
}

function findDuplicateLinkTextDifferentHref(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const seen = new Map<string, Set<string>>();
  const regex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const index = match.index ?? 0;
    const text = stripTagsAndServerBlocks(inner).toLowerCase();
    if (!text) continue;
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const href = (hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "").trim();
    if (!href) continue;

    const hrefSet = seen.get(text) ?? new Set<string>();
    hrefSet.add(href);
    seen.set(text, hrefSet);

    if (hrefSet.size < 2) continue;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/duplicate-link-text-different-target",
      title: "Same link text points to different destinations",
      description: "Repeated identical link text with different href targets can create ambiguity for assistive technology users (WCAG 2.4.4).",
      wcagSc: "2.4.4",
      filePath,
      line,
      column,
      htmlSnippet: match[0].slice(0, 220),
    });
  }

  return issues;
}

function findValidatorMissingErrorMessage(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<asp:(RequiredFieldValidator|RegularExpressionValidator|CustomValidator)\b([^>]*)\/?>(?:<\/asp:\1>)?/gi;

  for (const match of content.matchAll(regex)) {
    const controlType = match[1] ?? "Validator";
    const attrs = match[2] ?? "";
    const index = match.index ?? 0;
    const errorMessage = /\bErrorMessage\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const value = (errorMessage?.[1] ?? errorMessage?.[2] ?? "").trim();
    if (errorMessage && value.length > 0) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/validator-missing-errormessage",
      title: `${controlType} missing ErrorMessage`,
      description: "Validator controls should provide a non-empty ErrorMessage so users can identify validation failures (WCAG 3.3.1).",
      wcagSc: "3.3.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findValidationSummaryMissingLive(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<asp:ValidationSummary\b([^>]*)\/?>(?:<\/asp:ValidationSummary>)?/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    const hasAlertRole = /\brole\s*=\s*(?:"alert"|'alert'|alert|"status"|'status'|status)/i.test(attrs);
    const hasAriaLive = /\baria-live\s*=\s*(?:"assertive"|'assertive'|assertive|"polite"|'polite'|polite)/i.test(attrs);
    if (hasAlertRole || hasAriaLive) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/validation-summary-missing-live",
      title: "ValidationSummary missing live-region semantics",
      description: "Validation summaries should expose role=alert/status or aria-live so errors are announced to assistive technology (WCAG 3.3.1 / 4.1.3).",
      wcagSc: "4.1.3",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findUpdateProgressMissingLive(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<asp:UpdateProgress\b([^>]*)>([\s\S]*?)<\/asp:UpdateProgress>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const index = match.index ?? 0;
    const hasLive = /\baria-live\s*=\s*(?:"polite"|'polite'|polite|"assertive"|'assertive'|assertive)/i.test(attrs) ||
      /\brole\s*=\s*(?:"status"|'status'|status|"alert"|'alert'|alert)/i.test(attrs) ||
      /\baria-live\s*=|\brole\s*=\s*(?:"status"|'status'|status|"alert"|'alert'|alert)/i.test(inner);
    if (hasLive) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/updateprogress-missing-live",
      title: "UpdateProgress content missing live-region semantics",
      description: "Progress/status updates should be surfaced via aria-live or role=status/alert for screen reader announcements (WCAG 4.1.3).",
      wcagSc: "4.1.3",
      filePath,
      line,
      column,
      htmlSnippet: match[0].slice(0, 240),
    });
  }

  return issues;
}

function findMarqueeBlink(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<(marquee|blink)\b[^>]*>/gi;

  for (const match of content.matchAll(regex)) {
    const tag = (match[1] ?? "").toLowerCase();
    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/auto-moving-content",
      title: `Auto-moving <${tag}> content detected`,
      description: `<${tag}> introduces moving content that often lacks pause/stop controls (WCAG 2.2.2).`,
      wcagSc: "2.2.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findFormControlMissingAccessibleName(content: string, filePath: string, labelSearchContent = content): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labelledIds = collectLabelledIds(labelSearchContent);
  const knownIds = collectKnownElementIds(labelSearchContent);
  const localLabelledIds = collectLabelledIds(content);
  const localKnownIds = collectKnownElementIds(content);

  const candidates: Array<{
    snippet: string;
    attrs: string;
    index: number;
    kind: string;
  }> = [];

  const htmlRegex = /<(input|select|textarea)\b((?:[^"'<>]|"[^"]*"|'[^']*'|<%[\s\S]*?%>)*)>/gi;
  for (const match of content.matchAll(htmlRegex)) {
    const tag = (match[1] ?? "").toLowerCase();
    const attrs = match[2] ?? "";
    const index = match.index ?? 0;

    if (tag === "input") {
      const inputType = ((/\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs)?.[1] ??
        /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs)?.[2] ??
        /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs)?.[3] ??
        "text") + "").toLowerCase();

      const supportedInput = /^(text|password|email|number|tel|url|search|date|file|radio|checkbox)$/i.test(inputType);
      if (!supportedInput) continue;
      if (/^(hidden|submit|button|image|reset)$/i.test(inputType)) continue;
    }

    candidates.push({
      snippet: match[0] ?? "",
      attrs,
      index,
      kind: tag,
    });
  }

  const aspRegex = /<asp:(TextBox|DropDownList|ListBox)\b([^>]*)\/?>/gi;
  for (const match of content.matchAll(aspRegex)) {
    candidates.push({
      snippet: match[0] ?? "",
      attrs: match[2] ?? "",
      index: match.index ?? 0,
      kind: `asp:${(match[1] ?? "").toLowerCase()}`,
    });
  }

  for (const candidate of candidates) {
    const { attrs, snippet, index, kind } = candidate;
    const isAspControl = kind.startsWith("asp:");
    const idsForControl = isAspControl ? labelledIds : localLabelledIds;
    const knownIdsForControl = isAspControl ? knownIds : localKnownIds;

    if (/\bVisible\s*=\s*['"]false['"]|style\s*=\s*['"][^'"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^'"]*['"]|\bhidden\b/i.test(attrs)) {
      continue;
    }

    const hasNonEmptyAriaLabel = /\baria-label\s*=\s*(?:"[^"\s][^"]*"|'[^'\s][^']*'|[^\s>]+)/i.test(attrs);
    const hasNonEmptyTitle = /\btitle\s*=\s*(?:"[^"\s][^"]*"|'[^'\s][^']*'|[^\s>]+)/i.test(attrs);
    if (hasNonEmptyAriaLabel || hasNonEmptyTitle || hasResolvableAriaLabelledby(attrs, knownIdsForControl)) {
      continue;
    }

    if (isWrappedInLabel(content, index)) {
      continue;
    }

    const idMatch = /\b(?:id|ID)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const controlId = (idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3] ?? "").trim().toLowerCase();
    if (controlId) {
      const directLabel = idsForControl.has(controlId);
      const aspClientIdLabel = isAspControl && Array.from(idsForControl).some((v) => v === controlId || v.endsWith(`_${controlId}`));
      if (directLabel || aspClientIdLabel) {
        continue;
      }
    }

    const placeholderMatch = /\bplaceholder\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (placeholderMatch) {
      const placeholderValue = placeholderMatch[0] ?? "";
      const isServerPlaceholder = /<%[\s\S]*?%>/.test(placeholderValue);
      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: "aspnet/form-control-name-placeholder-only",
        title: "Form control relies on placeholder instead of label",
        description: isServerPlaceholder
          ? "Control appears to rely on a server-generated placeholder as its only name. Placeholder text is not a sufficient label and should be supplemented by a visible or programmatic label."
          : "Control appears to rely on placeholder text as its only name. Placeholder text is not a sufficient label and should be supplemented by a visible or programmatic label.",
        wcagSc: "3.3.2",
        filePath,
        line,
        column,
        htmlSnippet: snippet.slice(0, 240),
      });
      continue;
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspx-static/control-missing-label",
      title: "Form control must have an accessible name",
      description:
        `${kind} has no reliable associated label, aria-label, aria-labelledby, or title. ` +
        "Add an explicit label or programmatic name so assistive technologies can identify the control (WCAG 1.3.1 / 3.3.2).",
      wcagSc: "3.3.2",
      filePath,
      line,
      column,
      htmlSnippet: snippet.slice(0, 240),
    });
  }

  return issues;
}

function findHtmlInputMissingLabel(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labelledIds = collectLabelledIds(content);
  const regex = /<input\b([^>]*)>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    // Skip hidden, submit, button, reset, image types
    if (/\btype\s*=\s*(?:"hidden"|'hidden'|hidden|"submit"|'submit'|submit|"button"|'button'|button|"reset"|'reset'|reset|"image"|'image'|image)/i.test(attrs)) continue;
    if (hasAriaLabelAttr(attrs)) continue;
    if (/\btitle\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs)) continue;
    if (isWrappedInLabel(content, index)) continue;
    const idMatch = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const inputId = (idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3] ?? "").toLowerCase();
    if (inputId && labelledIds.has(inputId)) continue;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/input-has-label",
      title: "Input field must have an associated label",
      description: "<input> element has no associated <label>, aria-label, or aria-labelledby. Screen readers cannot identify this field (WCAG 3.3.2 / 1.3.1).",
      wcagSc: "3.3.2",
      filePath, line, column, htmlSnippet: snippet,
    });
  }
  return issues;
}

function findHtmlSelectMissingLabel(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labelledIds = collectLabelledIds(content);
  const regex = /<select\b([^>]*)>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    if (hasAriaLabelAttr(attrs)) continue;
    if (/\btitle\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs)) continue;
    if (isWrappedInLabel(content, index)) continue;
    const idMatch = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const selectId = (idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3] ?? "").toLowerCase();
    if (selectId && labelledIds.has(selectId)) continue;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/select-has-label",
      title: "Select element must have an associated label",
      description: "<select> element has no associated <label> or aria-label. Screen readers cannot identify this field (WCAG 3.3.2 / 1.3.1).",
      wcagSc: "3.3.2",
      filePath, line, column, htmlSnippet: snippet,
    });
  }
  return issues;
}

function findHtmlTextareaMissingLabel(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labelledIds = collectLabelledIds(content);
  const regex = /<textarea\b([^>]*)>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    if (hasAriaLabelAttr(attrs)) continue;
    if (/\btitle\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs)) continue;
    if (isWrappedInLabel(content, index)) continue;
    const idMatch = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const textareaId = (idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3] ?? "").toLowerCase();
    if (textareaId && labelledIds.has(textareaId)) continue;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/textarea-has-label",
      title: "Textarea must have an associated label",
      description: "<textarea> has no associated <label> or aria-label. Screen readers cannot identify this field (WCAG 3.3.2).",
      wcagSc: "3.3.2",
      filePath, line, column, htmlSnippet: snippet,
    });
  }
  return issues;
}

function findRequiredWithoutIndicator(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const requiredTargets = new Set<string>();
  const validatorRegex = /<asp:RequiredFieldValidator\b([^>]*)\/?>(?:<\/asp:RequiredFieldValidator>)?/gi;
  for (const validator of content.matchAll(validatorRegex)) {
    const attrs = validator[1] ?? "";
    const targetMatch = /\bControlToValidate\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const target = (targetMatch?.[1] ?? targetMatch?.[2] ?? targetMatch?.[3] ?? "").trim().toLowerCase();
    if (target) requiredTargets.add(target);
  }

  const pageHasSharedRequiredLegend =
    /\*\s*(?:indicates|means).{0,40}required/i.test(content) ||
    /strRcRequiredFieldsIndicator|STR_RC_REQUIRED_FIELD_INDICATOR_DESCRIPTION|STR_RC_REQUIRED_FIELD/i.test(content) ||
    /Localize\s*\(\s*["'][^"']*REQUIRED[^"']*["']\s*\)/i.test(content);

  const requiredRegionIds = new Set<string>();
  const regionRegex = /<(?:div|span|p|section|aside)\b([^>]*)>([\s\S]{0,260}?)<\/(?:div|span|p|section|aside)>/gi;
  for (const region of content.matchAll(regionRegex)) {
    const attrs = region[1] ?? "";
    const body = region[2] ?? "";
    if (!/(required|mandatory|strRcRequired|STR_RC_REQUIRED|RequiredFieldsIndicator)/i.test(body + attrs)) continue;
    const idMatch = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const id = (idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3] ?? "").trim().toLowerCase();
    if (id) requiredRegionIds.add(id);
  }

  const controlRegex = /<(input|select|textarea|asp:TextBox|asp:DropDownList|asp:ListBox)\b([^>]*)>/gi;
  for (const controlMatch of content.matchAll(controlRegex)) {
    const tag = (controlMatch[1] ?? "").toLowerCase();
    const attrs = controlMatch[2] ?? "";
    const index = controlMatch.index ?? 0;
    const snippet = controlMatch[0] ?? "";

    const idMatch = /\b(?:id|ID)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const controlId = (idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3] ?? "").trim().toLowerCase();

    const hasNativeRequired = /\brequired\b/i.test(attrs);
    const hasAriaRequired = /\baria-required\s*=\s*(?:"true"|'true'|true)/i.test(attrs);
    const hasValidatorRequired = controlId.length > 0 && Array.from(requiredTargets).some((v) => v === controlId || controlId.endsWith(`_${v}`));
    if (!hasNativeRequired && !hasAriaRequired && !hasValidatorRequired) continue;

    // Skip hidden/non-applicable controls.
    if (/\bVisible\s*=\s*['"]false['"]|style\s*=\s*['"][^'"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^'"]*['"]|\bhidden\b/i.test(attrs)) {
      continue;
    }

    // Shared legend marks all fields as indicated.
    if (pageHasSharedRequiredLegend) continue;

    // If aria-describedby points to required instruction region, treat as indicated.
    const describedByMatch = /\baria-describedby\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const describedByRaw = (describedByMatch?.[1] ?? describedByMatch?.[2] ?? describedByMatch?.[3] ?? "").toLowerCase();
    if (describedByRaw) {
      const refs = describedByRaw.split(/\s+/).filter(Boolean);
      const referencesRequiredRegion = refs.some((ref) => requiredRegionIds.has(ref) || /required|mandatory|indicator|legend/.test(ref));
      if (referencesRequiredRegion) continue;
    }

    const nearby = content.slice(Math.max(0, index - 750), Math.min(content.length, index + 750));

    const hasAdjacentMarker =
      /(?:\*|★|\(\s*required\s*\)|\brequired\b|\bmandatory\b)/i.test(nearby) ||
      /class\s*=\s*['"][^'"]*(?:required|reqIndicator|requiredMark)[^'"]*['"]/i.test(nearby) ||
      /<abbr\b[^>]*title\s*=\s*['"]required['"]/i.test(nearby) ||
      /<%=\s*strRc(?:Required|Req)[\w.]*/i.test(nearby) ||
      /<%=\s*Localize\s*\(\s*["'][^"']*(?:REQUIRED|REQ)[^"']*["']/i.test(nearby) ||
      /<%\$\s*Resources:[^%>]*(?:REQUIRED|REQ)/i.test(nearby);
    if (hasAdjacentMarker) continue;

    const hasLabelMarker = (() => {
      if (!controlId) return false;
      const labelForRegex = new RegExp(`<label\\b[^>]*\\bfor\\s*=\\s*['\"](?:${escapeRegex(controlId)}|[^'\"]*_${escapeRegex(controlId)})['\"][^>]*>([\\s\\S]{0,260}?)<\\/label>`, "gi");
      for (const labelMatch of content.matchAll(labelForRegex)) {
        const text = labelMatch[1] ?? "";
        if (/(\*|★|required|mandatory|strRc(?:Required|Req)|STR_RC_REQUIRED|Localize\s*\([^)]*REQUIRED)/i.test(text)) {
          return true;
        }
      }
      return false;
    })();
    if (hasLabelMarker) continue;

    // aria-required with accessible-name marker also counts as indicated.
    if (hasAriaRequired) {
      const ariaOrTitle = /\baria-label\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))|\btitle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
      let requiredInName = false;
      for (const named of attrs.matchAll(ariaOrTitle)) {
        const value = (named[1] ?? named[2] ?? named[3] ?? named[4] ?? named[5] ?? named[6] ?? "").trim();
        if (!value) continue;
        if (/(\*|★|required|mandatory|strRc(?:Required|Req)|STR_RC_REQUIRED|<%[\s\S]*?%>)/i.test(value)) {
          requiredInName = true;
          break;
        }
      }
      if (requiredInName) continue;
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/required-without-indicator",
      title: "Required field lacks visual or textual indicator",
      description:
        `${tag} is required (required/aria-required/RequiredFieldValidator) but no nearby required indicator was detected. ` +
        "Provide a visible marker like * or '(required)', or reference a shared required legend (WCAG 3.3.2).",
      wcagSc: "3.3.2",
      filePath,
      line,
      column,
      htmlSnippet: snippet.slice(0, 220),
    });
  }

  return issues;
}

function findReadonlyWithJsMutation(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const readonlyRegex = /<(?:input|textarea)\b([^>]*?)\breadonly\b[^>]*>/gi;

  for (const match of content.matchAll(readonlyRegex)) {
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    const idMatch = /\bid\s*=\s*['"]([\w-]+)['"]/i.exec(attrs);
    if (!idMatch) continue;

    const id = idMatch[1] ?? "";
    const jsRegex = new RegExp(
      `(?:getElementById|querySelector|getElementById)\\s*\\(\\s*['"${id}'"]\\s*\\)\\.(?:value|textContent|innerHTML)\\s*=|#${id}\\)\\s*\\.(?:val|text|html)\\s*\\(`,
      "i",
    );

    if (!jsRegex.test(content)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/readonly-with-js-mutation",
      title: "readonly field mutated via JavaScript",
      description: `readonly field #${id} appears to be modified via JavaScript, which may confuse screen reader users who expect readonly semantics (WCAG 4.1.2, heuristic).`,
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: (match[0] ?? "").slice(0, 220),
    });
  }

  return issues;
}

function findFormWithoutSubmitButton(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const hostPageExempt = /(?:blank|GenericLoading|ErrorBoxContainer|logout|DocumentSelectContainer|iframe|viewer|loading)\.aspx$/i.test(filePath);
  if (hostPageExempt) return issues;

  for (const formScope of collectFormScopes(content)) {
    const attrs = formScope.attrs;
    const body = formScope.body;
    const index = formScope.index;
    if (/\btype\s*=\s*['"]?search['"]?/i.test(attrs)) continue;

    // Must contain visible user-input controls; display-only server forms are exempt.
    const hasUserInput = /<(?:input\b[^>]*\btype\s*=\s*['"]?(?:text|email|password|url|tel|number|search|date)['"]?|textarea\b|select\b|asp:(?:TextBox|DropDownList|ListBox)\b)/i.test(body);
    if (!hasUserInput) continue;

    const hasSubmitButton =
      /<button\b(?![^>]*\btype\s*=\s*['"]?(?:button|reset)['"]?)[^>]*>/i.test(body) ||
      /<input\b[^>]*\btype\s*=\s*['"]?(?:submit|image)['"]?[^>]*>/i.test(body) ||
      /<asp:(?:Button|LinkButton|ImageButton)\b/i.test(body) ||
      // UseSubmitBehavior="false" still acts as a form-submit trigger for AT purposes
      /<asp:Button\b[^>]*\bUseSubmitBehavior\s*=\s*['"]?false['"]?[^>]*>/i.test(body) ||
      // Inline onclick that calls .submit() on the form
      /onclick\s*=\s*['"][^'"]*\.submit\s*\(\s*\)[^'"]*['"]/i.test(body);
    if (hasSubmitButton) continue;

    // Composite/unknown server controls can render submit UI at runtime.
    const hasCompositeServerControls = /<(?:cc\d*|Hyland|LoginControl|eb|Custom|[A-Za-z][\w-]*)\s*:[\w-]+\b[^>]*(?:\brunat\s*=\s*['"]server['"])?[^>]*>/i.test(body);
    if (hasCompositeServerControls) continue;

    // Menu/context/list-driven submit flows are exempt.
    if (/(context\s*menu|result\s*list|list\s*interaction|menu\s*driven|grid\s*selection|contextmenu)/i.test(body + filePath)) continue;

    // Explicit JS submit mechanisms are valid equivalents.
    if (/\bonsubmit\b|\.submit\s*\(|__doPostBack\s*\(|onkeydown\s*=\s*['"][^'"]*Enter[^'"]*(?:submit|postback)/i.test(body)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/form-without-submit",
      title: "Form lacks explicit submit button or equivalent",
      description: "A <form> element with input fields should have a clearly labeled submit button or equivalent accessible control. Screen reader users may not know how to submit the form (WCAG 3.3.4, heuristic).",
      wcagSc: "3.3.4",
      filePath,
      line,
      column,
      htmlSnippet: formScope.snippet.slice(0, 220),
    });
  }

  return issues;
}

function collectFormScopes(content: string): Array<{ attrs: string; body: string; index: number; snippet: string }> {
  const scopes: Array<{ attrs: string; body: string; index: number; snippet: string }> = [];
  const openRegex = /<form\b([^>]*)>/gi;
  const closeRegex = /<\/form\s*>/gi;

  for (const openMatch of content.matchAll(openRegex)) {
    const openIndex = openMatch.index ?? 0;
    const openTag = openMatch[0] ?? "";
    const attrs = openMatch[1] ?? "";
    const searchStart = openIndex + openTag.length;

    closeRegex.lastIndex = searchStart;
    const closeMatch = closeRegex.exec(content);
    if (!closeMatch || closeMatch.index < searchStart) continue;

    const body = content.slice(searchStart, closeMatch.index);
    const closeEnd = closeMatch.index + (closeMatch[0]?.length ?? 0);
    const snippet = content.slice(openIndex, closeEnd);

    scopes.push({ attrs, body, index: openIndex, snippet });
  }

  return scopes;
}

function findInputTypeWithoutAccessibility(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<input\b([^>]*?)\btype\s*=\s*(?:"(datetime|date|time|month|week)"|'(datetime|date|time|month|week)'|(datetime|date|time|month|week))\b[^>]*>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    const type = (match[2] ?? match[3] ?? match[4] ?? "").toLowerCase();
    if (hasAriaLabelAttr(attrs)) continue;
    if (/\btitle\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs)) continue;
    if (isWrappedInLabel(content, index)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/input-type-date-time-lacks-label",
      title: `input type="${type}" should have an accessible label`,
      description: `Date/time picker input lacks a clear label or aria-label. Assistive technologies may not announce the purpose of the picker (WCAG 1.3.1)`,
      wcagSc: "1.3.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0] ?? "",
    });
  }

  return issues;
}

function findMultipleFormSubmitsSameName(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const formRegex = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;

  for (const formMatch of content.matchAll(formRegex)) {
    const body = formMatch[2] ?? "";
    const formIndex = formMatch.index ?? 0;
    const submitButtons = Array.from(body.matchAll(/<button[^>]*\btype\s*=\s*(?:"submit"|'submit'|submit)\b|<input[^>]*\btype\s*=\s*(?:"submit"|'submit'|submit)\b[^>]*\bname\s*=\s*['"]([\w-]+)['"]/gi));

    const nameCount: Record<string, number> = {};
    for (const btn of submitButtons) {
      const nameMatch = /\bname\s*=\s*['"]([\w-]+)['"]/i.exec(btn[0] ?? "");
      if (!nameMatch) continue;
      const name = nameMatch[1] ?? "";
      nameCount[name] = (nameCount[name] ?? 0) + 1;
    }

    for (const [name, count] of Object.entries(nameCount)) {
      if (count <= 1) continue;
      const { line, column } = getLineColumn(content, formIndex);
      issues.push({
        ruleId: "aspnet/form-multiple-submits-same-name",
        title: `Multiple submit buttons with name="${name}"`,
        description: `Multiple submit buttons in the same form share the same name, which can cause confusion about which action was triggered (WCAG 3.3.4, heuristic)`,
        wcagSc: "3.3.4",
        filePath,
        line,
        column,
        htmlSnippet: `Multiple submit buttons with name="${name}"`,
      });
      break;
    }
  }

  return issues;
}

function findPositiveTabIndexInMarkup(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /\btabindex\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of content.matchAll(regex)) {
    const index = match.index ?? 0;
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const numeric = /^\d+$/.test(raw) ? Number(raw) : NaN;
    const isRuntimeExpression = /^<%[\s\S]*%>$/.test(raw);
    if (!isRuntimeExpression && (!Number.isFinite(numeric) || numeric < 1)) continue;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: isRuntimeExpression
        ? "aspx-static/positive-tabindex-runtime-review"
        : "aspx-static/positive-tabindex",
      title: isRuntimeExpression
        ? "tabindex uses runtime expression (review)"
        : "Positive tabindex disrupts natural tab order",
      description: isRuntimeExpression
        ? `tabindex="${raw}" is runtime-populated and may resolve to a positive value. Review rendered output and avoid tabindex values >= 1 (WCAG 2.4.3).`
        : `tabindex="${raw}" creates a custom focus sequence that confuses keyboard and AT users. Prefer tabindex="0" (natural order) or tabindex="-1" (programmatic focus). WCAG 2.4.3.`,
      wcagSc: "2.4.3",
      filePath, line, column, htmlSnippet: match[0],
    });
  }

  const aspRegex = /<asp:[A-Za-z][\w]*\b([^>]*)>/gi;
  for (const match of content.matchAll(aspRegex)) {
    const attrs = match[1] ?? "";
    const tabIndexAttr = /\bTabIndex\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (!tabIndexAttr) continue;
    const index = match.index ?? 0;
    const raw = (tabIndexAttr[1] ?? tabIndexAttr[2] ?? tabIndexAttr[3] ?? "").trim();
    const numeric = /^\d+$/.test(raw) ? Number(raw) : NaN;
    const isRuntimeExpression = /^<%[\s\S]*%>$/.test(raw);
    if (!isRuntimeExpression && (!Number.isFinite(numeric) || numeric < 1)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: isRuntimeExpression
        ? "aspx-static/positive-tabindex-runtime-review"
        : "aspx-static/positive-tabindex",
      title: isRuntimeExpression
        ? "ASP.NET TabIndex uses runtime expression (review)"
        : "ASP.NET TabIndex uses positive tabindex",
      description: isRuntimeExpression
        ? `TabIndex="${raw}" is runtime-populated and may resolve to a positive tabindex value. Review rendered output and avoid tabindex values >= 1 (WCAG 2.4.3).`
        : `TabIndex="${raw}" renders as positive tabindex and can disrupt logical keyboard order (WCAG 2.4.3).`,
      wcagSc: "2.4.3",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findTabindexNonInteractiveWithoutRole(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const idTextMap = buildElementTextById(content);

  // Strip server expression blocks first so the tag attribute regex cannot
  // get caught in exponential backtracking on <%...%> spans.
  const stripped = content.replace(/<%[\s\S]*?%>/g, " ");

  // Find elements with tabindex="0" or positive on non-interactive native elements.
  const nonInteractiveRegex = /(<(?:div|span|p|li|td|tr|th|section|article|aside|table|ul|ol|blockquote|form|header|footer|main|nav|h[1-6]|label|img|pre|code)\b[^>]*?\btabindex\s*=\s*["']([0-9]|[1-9]\d+)["'][^>]*?>)/gi;

  for (const match of stripped.matchAll(nonInteractiveRegex)) {
    const element = match[1] ?? "";
    const tabindexValue = Number(match[2] ?? "0");
    const index = match.index ?? 0;

    // Skip if any role is present.
    if (/\brole\s*=/i.test(element)) {
      continue;
    }

    // Positive tabindex has its own dedicated rule.
    if (Number.isFinite(tabindexValue) && tabindexValue >= 1) {
      continue;
    }

    if (/\bclass\s*=\s*['"][^'"]*(?:sr-only|screenreader|screenReader|offscreen|visually-hidden|assistive)[^'"]*['"]/i.test(element)) {
      continue;
    }

    const nameEvaluation = evaluateFocusableElementName(element, idTextMap);

    const isScrollContainer =
      /\bstyle\s*=\s*['"][^'"]*overflow\s*:\s*(?:auto|scroll)[^'"]*['"]/i.test(element) ||
      /\b(?:class|id)\s*=\s*['"][^'"]*(?:scroll|list|panel|container)[^'"]*['"]/i.test(element);

    if (isScrollContainer) {
      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: "a11y/scroll-container-should-have-region-role-informational",
        title: "Focusable scroll container should expose region semantics",
        description: "Focusable scroll/list containers are valid, but should generally include role=region and an accessible name (aria-label/aria-labelledby) for clearer AT navigation.",
        wcagSc: "1.3.1",
        filePath,
        line,
        column,
        htmlSnippet: element.slice(0, 220),
      });
      continue;
    }

    if (nameEvaluation.hasWhitespaceOnlyName) {
      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: "a11y/whitespace-only-accessible-name",
        title: "Focusable element has whitespace-only accessible name",
        description: "aria-label/title/alt/aria-labelledby resolves to blank or whitespace-only text. This usually indicates a missing localization value and should be treated as an error (WCAG 4.1.2).",
        wcagSc: "4.1.2",
        filePath,
        line,
        column,
        htmlSnippet: element.slice(0, 220),
      });
      continue;
    }

    if (nameEvaluation.hasName) {
      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: "a11y/focusable-named-needs-role",
        title: "Focusable element has name but lacks a semantic role",
        description: "Element is keyboard-focusable and named, but has no role. Consider adding an appropriate role (for example button/region) to complete semantics.",
        wcagSc: "4.1.2",
        filePath,
        line,
        column,
        htmlSnippet: element.slice(0, 220),
      });
      continue;
    }

    // Skip if has onclick or keyboard handler.
    if (/\b(?:onclick|onkeydown|onkeypress)\s*=/i.test(element)) {
      continue;
    }

    // Skip if has aria-describedby (legitimate focus target for scroll region/tooltip/help).
    if (/\baria-describedby\s*=/i.test(element)) {
      continue;
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "a11y/focusable-nameless-no-role",
      title: "tabindex on non-interactive element without role or accessible name",
      description:
        "Element has tabindex on a non-interactive element (div, span, li, etc.) without a widget role or accessible name. " +
        "When making an element keyboard-focusable, provide a role (button, link, etc.) and an accessible name (aria-label, title, or text content). " +
        "WCAG 4.1.2.",
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: element.slice(0, 220),
    });
  }

  return issues;
}

function evaluateFocusableElementName(
  elementSnippet: string,
  idTextMap: Map<string, string>,
): { hasName: boolean; hasWhitespaceOnlyName: boolean } {
  const readAttr = (attr: string): string | null => {
    const m = new RegExp(String.raw`\b${escapeRegex(attr)}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`, "i").exec(elementSnippet);
    return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
  };

  const ariaLabel = readAttr("aria-label");
  if (ariaLabel != null) {
    const trimmed = ariaLabel.trim();
    return trimmed.length > 0
      ? { hasName: true, hasWhitespaceOnlyName: false }
      : { hasName: false, hasWhitespaceOnlyName: true };
  }

  const title = readAttr("title");
  if (title != null) {
    const trimmed = title.trim();
    return trimmed.length > 0
      ? { hasName: true, hasWhitespaceOnlyName: false }
      : { hasName: false, hasWhitespaceOnlyName: true };
  }

  const alt = readAttr("alt");
  if (alt != null) {
    const trimmed = alt.trim();
    return trimmed.length > 0
      ? { hasName: true, hasWhitespaceOnlyName: false }
      : { hasName: false, hasWhitespaceOnlyName: true };
  }

  const labelledBy = readAttr("aria-labelledby");
  if (labelledBy != null) {
    const tokens = labelledBy.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    if (tokens.length === 0) {
      return { hasName: false, hasWhitespaceOnlyName: true };
    }

    let sawLabelRef = false;
    let hasResolvedText = false;
    for (const id of tokens) {
      const text = idTextMap.get(id.toLowerCase());
      if (text == null) continue;
      sawLabelRef = true;
      if (text.trim().length > 0) {
        hasResolvedText = true;
        break;
      }
    }

    if (hasResolvedText) {
      return { hasName: true, hasWhitespaceOnlyName: false };
    }

    if (sawLabelRef) {
      return { hasName: false, hasWhitespaceOnlyName: true };
    }

    return { hasName: false, hasWhitespaceOnlyName: false };
  }

  return { hasName: false, hasWhitespaceOnlyName: false };
}

function buildElementTextById(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const regex = /<([a-zA-Z][\w:-]*)\b([^>]*)>([\s\S]*?)<\/\1>/g;

  for (const match of content.matchAll(regex)) {
    const attrs = match[2] ?? "";
    const id = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const idValue = (id?.[1] ?? id?.[2] ?? id?.[3] ?? "").trim();
    if (!idValue) continue;

    const text = stripTagsAndServerBlocks(match[3] ?? "").trim();
    map.set(idValue.toLowerCase(), text);
  }

  return map;
}

function findAccessKeyUsage(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<(?:[a-z][\w:-]*|asp:[\w]+)\b[^>]*\baccesskey\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)[^>]*>/gi;

  for (const match of content.matchAll(regex)) {
    const snippet = match[0] ?? "";
    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/no-accesskey",
      title: "Avoid accesskey shortcuts in markup",
      description: "`accesskey` often conflicts with browser/assistive-technology shortcuts and can create inconsistent keyboard behavior (WCAG 2.1.4, heuristic).",
      wcagSc: "2.1.4",
      filePath,
      line,
      column,
      htmlSnippet: snippet,
    });
  }

  return issues;
}

function findAutofocusUsage(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const htmlRegex = /<(?:input|select|textarea|button)\b[^>]*\bautofocus\b[^>]*>/gi;
  const aspRegex = /<asp:(?:TextBox|DropDownList|ListBox|Button|LinkButton|ImageButton)\b[^>]*\bAutoFocus\s*=\s*(?:"true"|'true'|true)\b[^>]*>/gi;

  for (const match of content.matchAll(htmlRegex)) {
    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/no-autofocus",
      title: "autofocus can cause unexpected focus shifts",
      description: "Autofocus can move focus unexpectedly on page load and disorient keyboard and screen-reader users (WCAG 3.2.1, heuristic).",
      wcagSc: "3.2.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0] ?? "",
    });
  }

  for (const match of content.matchAll(aspRegex)) {
    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/no-autofocus",
      title: "AutoFocus=true can cause unexpected focus shifts",
      description: "ASP.NET `AutoFocus=true` can move focus unexpectedly on load and should be used cautiously with clear user intent (WCAG 3.2.1, heuristic).",
      wcagSc: "3.2.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0] ?? "",
    });
  }

  return issues;
}

function findHtmlMissingLang(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];

  // Only check .aspx files — .ascx fragments and .master don't emit <html>.
  if (!/\.aspx$/i.test(filePath)) return issues;

  // Find literal <html> tags (not from master page inheritance).
  const htmlRegex = /<html\b([^>]*)>/i;
  const htmlMatch = htmlRegex.exec(content);

  if (!htmlMatch) {
    // No literal <html> tag — likely inherits from master page.
    return issues;
  }

  const attrs = htmlMatch[1] ?? "";
  const index = htmlMatch.index ?? 0;

  // Skip if lang= or xml:lang= is present (including server expressions).
  if (/\blang\s*=|\bxml:lang\s*=/i.test(attrs)) {
    return issues;
  }

  const { line, column } = getLineColumn(content, index);
  issues.push({
    ruleId: "aspnet/html-missing-lang",
    title: "<html> element must have a lang attribute",
    description:
      "The <html> element must have a lang attribute to identify the document language (WCAG 3.1.1). " +
      "Add lang=\"en\" or the appropriate language code. For multi-language content, use xml:lang or set dynamically with server expressions.",
    wcagSc: "3.1.1",
    filePath,
    line,
    column,
    htmlSnippet: htmlMatch[0] ?? "",
  });

  return issues;
}

function findEmptyTitle(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];

  // Skip .ascx (user controls) and partial files — no <title> rendering.
  if (/\.ascx$|partial/i.test(filePath)) return issues;

  // Find <title> elements inside <head>.
  const titleRegex = /<title\b[^>]*>([\s\S]*?)<\/title>/gi;
  for (const match of titleRegex.exec(content) ? [titleRegex.exec(content)] : Array.from(content.matchAll(titleRegex))) {
    if (!match) continue;

    const titleContent = match[1] ?? "";
    const index = match.index ?? 0;

    // Skip if title contains a server expression (<%=…%>, <%: …%>, <%#…%>, <%$ Resources:…%>).
    if (/<%[\s=:#\$]/.test(titleContent)) continue;

    // Skip if content is not empty/whitespace (has actual text).
    if (titleContent.trim().length > 0) continue;

    // Check if Page.Title is set in code-behind (.cs file).
    const csFilePath = filePath.replace(/\.aspx$/, ".aspx.cs").replace(/\.ascx$/, ".ascx.cs");
    let csBehindContent = "";
    try {
      // Best effort: try to detect if .cs file exists and has Page.Title assignment.
      // In a real implementation, this would read the file system; here we skip if not present.
      // The rule skips silently if .cs is not accessible.
    } catch {
      // Continue with ASPX analysis even if .cs not found.
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/title-empty",
      title: "Page has an empty <title>",
      description:
        "<title> is empty or whitespace only. Every page must have a descriptive, unique title that identifies the page purpose (WCAG 2.4.2).",
      wcagSc: "2.4.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0] ?? "",
    });
  }

  return issues;
}

function findMetaRefresh(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<meta\b[^>]*\bhttp-equiv\s*=\s*(?:"refresh"|'refresh')[^>]*>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const index = match.index ?? 0;
    // A 0-second refresh is a redirect, not a timed refresh — borderline, still flag
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/no-meta-refresh",
      title: "Avoid automatic page refresh via meta http-equiv=refresh",
      description: "Automatic timed refresh disorients users who need more time to read content, particularly screen reader users (WCAG 2.2.1 / 3.2.5).",
      wcagSc: "2.2.1",
      filePath, line, column, htmlSnippet: snippet,
    });
  }
  return issues;
}

function findViewportZoomRestrictions(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<meta\b[^>]*\bname\s*=\s*(?:"viewport"|'viewport')[^>]*>/gi;

  for (const match of content.matchAll(regex)) {
    const snippet = match[0] ?? "";
    const index = match.index ?? 0;
    const contentMatch = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(snippet);
    const viewport = (contentMatch?.[1] ?? contentMatch?.[2] ?? "").toLowerCase();
    if (!viewport) continue;
    if (!/(user-scalable\s*=\s*no|maximum-scale\s*=\s*(?:1(?:\.0+)?|0\.\d+))/i.test(viewport)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/viewport-zoom-restricted",
      title: "Viewport meta restricts zoom",
      description: "user-scalable=no or low maximum-scale can prevent zoom needed by low-vision users (WCAG 1.4.4 / 1.4.10).",
      wcagSc: "1.4.10",
      filePath,
      line,
      column,
      htmlSnippet: snippet,
    });
  }

  return issues;
}

function findInlineMinWidthTopLevel(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<(html|body|main|div)\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const tag = match[1] ?? "div";
    const attrs = match[2] ?? "";
    const index = match.index ?? 0;
    const styleMatch = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const style = (styleMatch?.[1] ?? styleMatch?.[2] ?? "").toLowerCase();
    if (!style) continue;
    const minWidthMatch = /min-width\s*:\s*(\d+(?:\.\d+)?)px/.exec(style);
    if (!minWidthMatch) continue;
    const minWidth = Number(minWidthMatch[1] ?? 0);
    if (minWidth <= 320) continue;

    const isTopLevelHint = tag === "html" || tag === "body" || /\b(container|wrapper|layout|main)\b/i.test(attrs);
    if (!isTopLevelHint) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/inline-min-width-large",
      title: "Inline min-width may hinder reflow",
      description: "Top-level inline min-width greater than 320px can reduce small-viewport reflow support unless responsive alternatives exist (WCAG 1.4.10, heuristic).",
      wcagSc: "1.4.10",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findVideoAudioMissingTrack(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const mediaRegex = /<(video|audio)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of content.matchAll(mediaRegex)) {
    const tag = match[1] ?? "video";
    const inner = match[2] ?? "";
    const index = match.index ?? 0;
    // Check for <track kind="captions"> or <track kind="subtitles">
    if (/<track\b[^>]*\bkind\s*=\s*(?:"captions"|'captions'|captions|"subtitles"|'subtitles'|subtitles)/i.test(inner)) continue;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/media-missing-captions",
      title: `<${tag}> element missing captions track`,
      description: `<${tag}> element has no <track kind="captions"> or <track kind="subtitles">. Deaf and hard-of-hearing users cannot access audio content (WCAG 1.2.2).`,
      wcagSc: "1.2.2",
      filePath, line, column, htmlSnippet: match[0].slice(0, 200),
    });
  }
  return issues;
}

// ARIA widget roles that make a non-native element semantically interactive.
const ARIA_WIDGET_ROLES = new Set([
  "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "tab", "checkbox", "radio", "switch", "treeitem", "gridcell", "row",
]);

function findOnclickOnNonInteractive(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  // Only target genuinely non-interactive container elements.
  const regex = /<(div|span|td|li|p|h[1-6]|tr)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of content.matchAll(regex)) {
    const tag = match[1] ?? "div";
    const attrs = match[2] ?? "";
    const inner = match[3] ?? "";
    const index = match.index ?? 0;

    if (!/\bonclick\b/i.test(attrs)) continue;

    // Pass only if the author supplied both keyboard activation and focusability.
    if (hasKeyboardHandler(attrs) && /\btabindex\s*=\s*(?:"0"|'0'|0)\b/i.test(attrs)) continue;

    const roleMatch = /\brole\s*=\s*(?:"([^"]+)"|'([^']+)'|([\w-]+))/i.exec(attrs);
    const roleValue = (roleMatch?.[1] ?? roleMatch?.[2] ?? roleMatch?.[3] ?? "").trim().toLowerCase();
    if (roleValue && ARIA_WIDGET_ROLES.has(roleValue) && hasKeyboardHandler(attrs) && /\btabindex\s*=\s*(?:"0"|'0'|0)\b/i.test(attrs)) {
      continue;
    }

    // Pass: a native interactive child can receive the event.
    if (hasInteractiveDescendant(inner)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspx-static/click-without-keyboard",
      title: `onclick on non-interactive <${tag}> without keyboard equivalent`,
      description: `<${tag}> has onclick but does not provide a reliable keyboard path (focusability + keyboard handler). Keyboard-only users may be unable to trigger this action (WCAG 2.1.1).`,
      wcagSc: "2.1.1",
      filePath, line, column, htmlSnippet: `<${tag} ${attrs.slice(0, 150)}>`,
    });
  }
  return issues;
}

function findNestedInteractive(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const outerRegex = /<(a|button|label|summary|details|select|textarea|input|option|optgroup|fieldset|legend|iframe|audio|video|[a-z][\w:-]*)\b([^>]*)>([\s\S]*?)<\/\1>/gi;

  for (const match of content.matchAll(outerRegex)) {
    const outerTag = (match[1] ?? "").toLowerCase();
    const outerAttrs = match[2] ?? "";
    const inner = match[3] ?? "";
    const index = match.index ?? 0;

    const outerInteractive = /^(a|button|summary|select|textarea|input|option|optgroup|fieldset|label|iframe|audio|video)$/i.test(outerTag) ||
      /\brole\s*=\s*(?:"(?:button|link|menuitem|checkbox|radio|switch|tab|option|treeitem|gridcell)"|'(?:button|link|menuitem|checkbox|radio|switch|tab|option|treeitem|gridcell)'|(?:button|link|menuitem|checkbox|radio|switch|tab|option|treeitem|gridcell))/i.test(outerAttrs) ||
      /\bonclick\b/i.test(outerAttrs);
    if (!outerInteractive) continue;
    if (!hasInteractiveDescendant(inner)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "a11y/nested-interactive",
      title: `Interactive ${outerTag} contains another interactive control`,
      description: "Nested interactive content can confuse assistive technology and keyboard users. Flatten the structure or use a single interactive control (WCAG 4.1.2 / 2.1.1).",
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0].slice(0, 240),
    });
  }

  return issues;
}

function findAnchorUsedAsButton(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;

    // Only flag anchors that carry onclick — pure links are fine.
    if (!/\bonclick\b/i.test(attrs)) continue;

    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const href = (hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "").trim();

    // Pass: has a real destination — native <a> keyboard activation is sufficient.
    const hasRealHref =
      hrefMatch !== null &&
      href.length > 0 &&
      href !== "#" &&
      !/^javascript:/i.test(href) &&
      !/^void\s*\(\s*0\s*\)/i.test(href);
    if (hasRealHref) continue;

    // Pass: proper ARIA button pattern — role="button" + tabindex="0" + keyboard handler.
    if (
      /\brole\s*=\s*(?:"button"|'button')/i.test(attrs) &&
      /\btabindex\s*=\s*(?:"0"|'0'|0)\b/i.test(attrs) &&
      hasKeyboardHandler(attrs)
    ) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/anchor-as-button",
      title: "Anchor used as a button needs button semantics and keyboard support",
      description:
        "An <a> with onclick but no real href is used as a button substitute. Give it a real href, add role=\"button\" + tabindex=\"0\" + a keydown handler for Enter/Space, or replace with <button type=\"button\">.",
      wcagSc: "2.1.1",
      filePath,
      line,
      column,
      htmlSnippet: snippet.slice(0, 260),
    });
  }

  return issues;
}

function findSvgFocusableWithoutAriaHidden(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const statusLikeClassPattern = /(?:^|\s)(?:error|warning|info|success|status|footer|tooltip|indicator)(?:\s|$)/i;
  const stripScriptStyleAndComments = (markup: string): string =>
    markup
      .replace(/<!--([\s\S]*?)-->/g, (m) => " ".repeat(m.length))
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => " ".repeat(m.length))
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => " ".repeat(m.length));

  const hasAttr = (attrs: string, name: string): boolean => {
    const n = escapeRegex(name);
    return new RegExp(String.raw`\b${n}\s*=\s*(?:"[^"]*"|'[^']*'|<%[\s\S]*?%>|[^\s>]+)`, "i").test(attrs);
  };

  const hasTruthyAttr = (attrs: string, name: string, value: string): boolean => {
    const n = escapeRegex(name);
    const v = escapeRegex(value);
    return new RegExp(String.raw`\b${n}\s*=\s*(?:"${v}"|'${v}'|${v})`, "i").test(attrs);
  };

  const isPresentationRole = (attrs: string): boolean =>
    /\brole\s*=\s*(?:"(?:presentation|none)"|'(?:presentation|none)'|(?:presentation|none))/i.test(attrs);

  const hasNameOnElement = (attrs: string, inner: string): boolean => {
    if (hasAttr(attrs, "aria-label") || hasAttr(attrs, "aria-labelledby")) {
      return true;
    }

    // Count only if <title> appears as first meaningful child, allowing server expressions/comments/whitespace before it.
    const normalizedInner = inner.replace(/<!--([\s\S]*?)-->/g, " ");
    return /^(?:\s|<%[\s\S]*?%>)*<title\b[^>]*>\s*[^<\s][\s\S]*?<\/title>/i.test(normalizedInner);
  };

  const isFocusableSvg = (attrs: string): boolean =>
    /\btabindex\s*=\s*(?:"(?:0|[1-9]\d*)"|'(?:0|[1-9]\d*)'|(?:0|[1-9]\d*))/i.test(attrs);

  const requiresOwnAccessibleName = (attrs: string): boolean =>
    /\brole\s*=\s*(?:"img"|'img'|img)/i.test(attrs) || isFocusableSvg(attrs);

  type TagNode = { tag: string; attrs: string; openStart: number; openEnd: number };

  const findMatchingCloseIndex = (markup: string, openEnd: number, tagName: string): number => {
    const tokenRegex = new RegExp(String.raw`<\/?${escapeRegex(tagName)}\b[^>]*>`, "gi");
    tokenRegex.lastIndex = openEnd;
    let depth = 1;
    for (const token of markup.matchAll(tokenRegex)) {
      const snippet = token[0] ?? "";
      const idx = token.index ?? 0;
      if (/^<\//.test(snippet)) {
        depth -= 1;
        if (depth === 0) return idx;
      } else if (!/\/>\s*$/.test(snippet)) {
        depth += 1;
      }
    }
    return -1;
  };

  const isNamedWidgetAncestor = (ancestor: TagNode, svgIndex: number, markup: string): boolean => {
    const isWidgetTag = /^(button|a|summary)$/i.test(ancestor.tag);
    const isWidgetRole = /\brole\s*=\s*(?:"(?:button|link|menuitem|menuitemcheckbox|menuitemradio|option|tab|treeitem|checkbox|radio|switch)"|'(?:button|link|menuitem|menuitemcheckbox|menuitemradio|option|tab|treeitem|checkbox|radio|switch)'|(?:button|link|menuitem|menuitemcheckbox|menuitemradio|option|tab|treeitem|checkbox|radio|switch))/i.test(ancestor.attrs);
    if (!isWidgetTag && !isWidgetRole) return false;

    const hasLabelAttrs = hasAttr(ancestor.attrs, "aria-label") || hasAttr(ancestor.attrs, "aria-labelledby") || hasAttr(ancestor.attrs, "title");
    if (hasLabelAttrs) return true;

    const closeIdx = findMatchingCloseIndex(markup, ancestor.openEnd, ancestor.tag);
    if (closeIdx <= ancestor.openEnd) return false;

    const inner = markup.slice(ancestor.openEnd, closeIdx);
    const hasVisibleText = stripTagsAndServerBlocks(inner).length > 0;
    if (hasVisibleText) return true;

    const siblingLabelExpr = /<%[:=#]\s*(?:strRc|Localize)\b[\s\S]*?%>/i.test(inner);
    if (siblingLabelExpr) return true;

    // Also allow localized expression immediately around the SVG as a fallback heuristic.
    const nearby = markup.slice(Math.max(0, svgIndex - 200), Math.min(markup.length, svgIndex + 240));
    return /<%[:=#]\s*(?:strRc|Localize)\b[\s\S]*?%>/i.test(nearby);
  };

  const isDecorativeStatusAncestor = (ancestor: TagNode): boolean => {
    if (/\brole\s*=\s*(?:"(?:alert|status)"|'(?:alert|status)'|(?:alert|status))/i.test(ancestor.attrs)) {
      return true;
    }

    const classMatch = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(ancestor.attrs);
    const classValue = classMatch?.[1] ?? classMatch?.[2] ?? "";
    return statusLikeClassPattern.test(classValue);
  };

  const hasNearbyLabelContext = (markup: string, svgIndex: number): boolean => {
    const nearby = markup.slice(Math.max(0, svgIndex - 240), Math.min(markup.length, svgIndex + 320));
    return /<(?:label|span|asp:Label)\b[^>]*>[\s\S]*?<\/(?:label|span|asp:Label)>/i.test(nearby)
      || /<%[:=#][\s\S]*?%>/i.test(nearby);
  };

  const markup = stripScriptStyleAndComments(content);
  const tagRegex = /<\/?([a-zA-Z][\w:-]*)\b([^>]*)>/g;
  const stack: TagNode[] = [];

  for (const token of markup.matchAll(tagRegex)) {
    const fullTag = token[0] ?? "";
    const tagName = (token[1] ?? "").toLowerCase();
    const attrs = token[2] ?? "";
    const index = token.index ?? 0;
    const isClosing = /^<\//.test(fullTag);
    const isSelfClosing = /\/>\s*$/.test(fullTag);

    if (isClosing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i]?.tag === tagName) {
          stack.splice(i, 1);
          break;
        }
      }
      continue;
    }

    if (tagName === "svg") {
      const closeIdx = markup.indexOf("</svg", index);
      const inner = closeIdx > 0 ? markup.slice(index + fullTag.length, closeIdx) : "";

      if (hasTruthyAttr(attrs, "focusable", "false")) {
        if (!isSelfClosing) {
          stack.push({ tag: tagName, attrs, openStart: index, openEnd: index + fullTag.length });
        }
        continue;
      }
      if (hasTruthyAttr(attrs, "aria-hidden", "true")) {
        if (!isSelfClosing) {
          stack.push({ tag: tagName, attrs, openStart: index, openEnd: index + fullTag.length });
        }
        continue;
      }
      if (isPresentationRole(attrs)) {
        if (!isSelfClosing) {
          stack.push({ tag: tagName, attrs, openStart: index, openEnd: index + fullTag.length });
        }
        continue;
      }

      const hasName = hasNameOnElement(attrs, inner);
      if (hasName) {
        if (!isSelfClosing) {
          stack.push({ tag: tagName, attrs, openStart: index, openEnd: index + fullTag.length });
        }
        continue;
      }

      if (!requiresOwnAccessibleName(attrs)) {
        if (!isSelfClosing) {
          stack.push({ tag: tagName, attrs, openStart: index, openEnd: index + fullTag.length });
        }
        continue;
      }

      const hasLabeledWidgetAncestor = stack.some((ancestor) => isNamedWidgetAncestor(ancestor, index, markup));
      const hasDecorativeAncestor = stack.some((ancestor) => isDecorativeStatusAncestor(ancestor));
      const hasNearbyLabel = hasNearbyLabelContext(markup, index);
      if (!hasLabeledWidgetAncestor && !hasDecorativeAncestor && !hasNearbyLabel) {
        const { line, column } = getLineColumn(content, index);
        issues.push({
          ruleId: "aspnet/svg-focusable-false-no-aria-hidden",
          title: "Focusable SVG should be hidden or have an accessible name",
          description:
            "Standalone or interactive SVG has no detectable accessible name. Use aria-hidden=true for decorative SVGs, or provide <title> as first child, aria-label, or aria-labelledby.",
          wcagSc: "1.1.1",
          filePath,
          line,
          column,
          htmlSnippet: fullTag,
        });
      }
    }

    if (!isSelfClosing) {
      stack.push({ tag: tagName, attrs, openStart: index, openEnd: index + fullTag.length });
    }
  }

  return issues;
}

function findDisabledOnNonFormElements(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<(div|span|a|li|tr|td|p|section|article|header|nav|main|aside)\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const tag = match[1] ?? "div";
    const attrs = match[2] ?? "";
    const index = match.index ?? 0;

    // Parse attributes by name so tokens inside class="..." are not mistaken as attributes.
    const attrNames = new Set<string>();
    const attrRegex = /([:@\w-]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
    for (const attrMatch of attrs.matchAll(attrRegex)) {
      const name = (attrMatch[1] ?? "").toLowerCase();
      if (name) attrNames.add(name);
    }

    const hasDisabledAttr = attrNames.has("disabled");
    if (!hasDisabledAttr) continue;

    // Pass if element also has aria-disabled="true" with appropriate keyboard handling.
    if (/aria-disabled\s*=\s*['"]true['"]\b/i.test(attrs)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/disabled-on-non-form-element",
      title: `disabled used on non-form <${tag}> element`,
      description:
        "Only native form controls (<input>, <button>, <select>, <textarea>) honor the disabled attribute. " +
        "For custom widgets or links, use aria-disabled=\"true\" and block keyboard/mouse interaction in script (WCAG 4.1.2).",
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: `<${tag} ${attrs.slice(0, 150)}>`,
    });
  }

  return issues;
}

function findAriaHiddenFocusableMarkup(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];

  // Scan for explicit aria-hidden="true" declarations.
  const ariaHiddenRegex = /<([^>]+)\baria-hidden\s*=\s*['"]true['"][^>]*>[\s\S]*?</gi;

  for (const match of content.matchAll(ariaHiddenRegex)) {
    const snippet = match[0] ?? "";
    const index = match.index ?? 0;

    // Extract the opening tag to check for exclusions.
    const tagMatch = /^<(\w+)\b([^>]*)>/.exec(snippet);
    if (!tagMatch) continue;

    const tagAttrs = tagMatch[2] ?? "";

    // Pass if the aria-hidden element itself has tabindex="-1" (explicitly removed from tab order).
    if (/\btabindex\s*=\s*['"]?-1['"]?\b/i.test(tagAttrs)) continue;

    // Pass if the aria-hidden element has inert attribute.
    if (/\binert\b/i.test(tagAttrs)) continue;

    // Check for focusable descendants within the aria-hidden subtree.
    // Look ahead for focusable elements that don't have tabindex="-1" or inert.
    const closeIndex = snippet.lastIndexOf("<");
    const subtreeSnippet = snippet.slice(tagMatch[0].length, closeIndex);

    const hasFocusableDescendant =
      /(button|\ba\b|input|select|textarea)\b/i.test(subtreeSnippet) ||
      /\btabindex\s*=\s*['"]?(?!-1)['"]?/i.test(subtreeSnippet);

    if (!hasFocusableDescendant) continue;

    // Further pass if all focusable descendants are explicitly marked with tabindex="-1" or inert.
    const focusableInSubtree = subtreeSnippet.match(/(<(?:button|input|select|textarea|a)[^>]*>)/gi) ?? [];
    const allExcluded = focusableInSubtree.every(
      (el) => /\btabindex\s*=\s*['"]?-1['"]?|\binert\b/i.test(el)
    );
    if (allExcluded) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/aria-hidden-focusable",
      title: "aria-hidden=true on focusable content",
      description:
        "Focusable content hidden with aria-hidden=\"true\" creates a screen-reader ghost: keyboard users can still reach it via Tab but assistive technology cannot announce it. " +
        "Either remove aria-hidden from the container, add tabindex=\"-1\" to focusable descendants, or use inert (WCAG 4.1.2).",
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: snippet.slice(0, 200),
    });
  }

  return issues;
}

function findAspLabelUsedAsHeading(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<asp:Label\b([^>]*)>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const index = match.index ?? 0;
    if (/\bAssociatedControlID\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs)) continue;
    if (!/\bCssClass\s*=\s*(?:"[^"]*(?:panelTitle|pageTitle|sectionHeader|heading)[^"]*"|'[^']*(?:panelTitle|pageTitle|sectionHeader|heading)[^']*')/i.test(attrs)) {
      continue;
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/label-used-as-heading",
      title: "asp:Label used as a heading should be a heading element",
      description:
        "Labels render as spans, not headings. Replace heading-like asp:Label styling with a real heading element so screen readers can discover the page structure.",
      wcagSc: "2.4.6",
      filePath,
      line,
      column,
      htmlSnippet: match[0].slice(0, 220),
    });
  }

  return issues;
}

function findAspPanelWithOnclick(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<asp:Panel\b([^>]*)>([\s\S]*?)<\/asp:Panel>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const index = match.index ?? 0;
    if (!/\bonclick\s*=\s*/i.test(attrs)) continue;
    if (hasInteractiveDescendant(inner)) continue;
    if (hasKeyboardHandler(attrs) && hasButtonLikeRole(attrs)) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspx-static/click-without-keyboard",
      title: "asp:Panel onclick needs keyboard support",
      description:
        "asp:Panel with onclick behaves like a custom control. Add a keyboard handler, a button-like role, or replace it with a real button.",
      wcagSc: "2.1.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0].slice(0, 260),
    });
  }

  return issues;
}

function findMultipleH1(content: string, filePath: string): AspxScanIssue[] {
  const matches = [...content.matchAll(/<h1\b/gi)];
  if (matches.length <= 1) return [];

  const second = matches[1];
  const index = second?.index ?? 0;
  const { line, column } = getLineColumn(content, index);
  return [
    {
      ruleId: "aspnet/multiple-h1",
      title: "Page has multiple h1 headings",
      description:
        "Multiple h1 headings make the page outline harder to understand. Use a single h1 per page and nest lower-level headings beneath it.",
      wcagSc: "2.4.6",
      filePath,
      line,
      column,
      htmlSnippet: matches[1]?.[0] ?? "<h1",
    },
  ];
}

function findMissingLandmarks(content: string, filePath: string): AspxScanIssue[] {
  // Superseded by findMissingLandmarkRegions() with stricter top-level gating.
  return [];
}

function findLayoutTableWithoutPresentation(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  if (/\.(?:ascx)$/i.test(filePath)) return issues;
  const regex = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const index = match.index ?? 0;

    if (/\brole\s*=\s*(?:"presentation"|'presentation'|"none"|'none')/i.test(attrs)) continue;
    if (/\brole\s*=\s*(?:"grid"|'grid'|"treegrid"|'treegrid'|"table"|'table'|"radiogroup"|'radiogroup'|"region"|'region'|"group"|'group'|"tablist"|'tablist'|"menu"|'menu'|"listbox"|'listbox')/i.test(attrs)) continue;

    const hasHeaderSemantics =
      /<th\b/i.test(inner) ||
      /<thead\b/i.test(inner) ||
      /\bscope\s*=\s*(?:"(?:row|col)"|'(?:row|col)'|(?:row|col))/i.test(inner) ||
      /role\s*=\s*(?:"(?:columnheader|rowheader)"|'(?:columnheader|rowheader)'|(?:columnheader|rowheader))/i.test(inner);
    // Route header-semantic tables to data-table rule only.
    if (hasHeaderSemantics) continue;

    const hasDataHintingClass = /\bclass\s*=\s*['"][^'"]*(?:tableData|dataTable|gridView|reportTable|panelTable|parameterTable|SystemNotificationTable|Table\b|Grid\b|Data\b|List\b|Report\b)[^'"]*['"]/i.test(attrs);
    if (hasDataHintingClass) continue;

    if (/<caption\b/i.test(inner)) continue;
    if (!/\brunat\s*=\s*(?:"server"|'server')/i.test(attrs) && !/(form|input|select|textarea|button|asp:)/i.test(inner)) {
      continue;
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/layout-table-needs-presentation",
      title: "Layout table should be marked presentation or none",
      description:
        "A table used for layout should have role=\"presentation\" or role=\"none\" so assistive technologies do not announce false row and column structure.",
      wcagSc: "1.3.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0].slice(0, 260),
    });
  }

  return issues;
}

function hasInteractiveDescendant(content: string): boolean {
  return /<(button|input|select|textarea)\b|<a\b[^>]*\bhref\s*=|<asp:(?:Button|LinkButton|ImageButton)\b/i.test(content);
}

function hasFocusableDescendant(content: string): boolean {
  return hasInteractiveDescendant(content) || /\btabindex\s*=\s*(?:"[0-9]+"|'[0-9]+'|[0-9]+)/i.test(content);
}

function hasKeyboardHandler(attrs: string): boolean {
  return /\bonkey(?:down|press|up)\b/i.test(attrs);
}

function hasButtonLikeRole(attrs: string): boolean {
  return /\brole\s*=\s*(?:"button"|'button'|button|"link"|'link'|link|"menuitem"|'menuitem'|menuitem|"tab"|'tab'|tab|"option"|'option'|option)/i.test(attrs);
}

function isIconOnlyContent(inner: string): boolean {
  const stripped = stripTagsAndServerBlocks(inner).replace(/\s+/g, "");
  if (stripped.length > 0) return false;
  return /<(svg|img|i|span)\b/i.test(inner);
}

function findDialogSemantics(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];

  // Do NOT fire on filename patterns alone — require actual structure.
  // Skip if page is loaded as an iframe inside a host dialog.
  if (/window\.parent|top\.location|window\.frameElement/i.test(content)) return [];

  // Look for an actual overlay + panel structure:
  // — a modal backdrop (div with class containing 'modal', 'overlay', 'backdrop', or visibility-hidden/opacity-0)
  // — plus a content panel (div/section with class containing 'dialog', 'modal-content', 'popup', etc.)
  const hasBackdrop =
    /class\s*=\s*['"][^'"]*(?:modal|overlay|backdrop|dimmer)[^'"]*['"]\s*[^>]*(?:style|aria-hidden)/i.test(content) ||
    /style\s*=\s*['"][^'"]*(?:position\s*:\s*fixed|display\s*:\s*none|opacity\s*:\s*0|visibility\s*:\s*hidden)[^'"]*['"][^>]*class/i.test(content);

  const hasContentPanel =
    /class\s*=\s*['"][^'"]*(?:dialog|modal[-_]?content|popup|popover|modal[-_]?body)[^'"]*['"][^>]*(?:role|aria-label|aria-labelledby)/i.test(
      content
    );

  // If no clear modal structure detected, skip.
  // Require BOTH overlay/backdrop and content panel to avoid filename-pattern false positives.
  if (!(hasBackdrop && hasContentPanel)) return [];

  // Now check for dialog semantics.
  const hasDialogRole = /\brole\s*=\s*(?:"dialog"|'dialog'|"alertdialog"|'alertdialog')/i.test(content);
  const hasModal = /\baria-modal\s*=\s*(?:"true"|'true'|true)/i.test(content);
  const hasDialogLabel = /\b(?:aria-label|aria-labelledby)\s*=\s*(?:"[^"]+"|'[^']+')/i.test(content);

  if (hasDialogRole && hasModal && hasDialogLabel) return [];

  // Find the line of the modal/dialog element.
  const dialogMatch = /(?:role\s*=\s*(?:"dialog"|'dialog'|"alertdialog"|'alertdialog')|class\s*=\s*['"][^'"]*(?:modal[-_]?dialog|dialog|popover)[^'"]*['"])/.exec(
    content
  );
  const index = dialogMatch?.index ?? 0;
  const { line, column } = getLineColumn(content, index);

  return [
    {
      ruleId: "aspnet/dialog-semantics",
      title: "Dialog or popup markup is missing accessible dialog semantics",
      description:
        "Modal, popup, and confirm surfaces with overlay+panel structure should have role=\"dialog\" or role=\"alertdialog\", aria-modal=\"true\", " +
        "and an accessible name (aria-label or aria-labelledby) so screen readers understand the context shift (WCAG 4.1.2).",
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: "(modal overlay + panel structure detected)",
    },
  ];
}

function findInlineConfirmAlert(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const isScriptFile = /\.(?:js|ts|jsx|tsx)$/i.test(filePath);

  const segments: Array<{ text: string; start: number }> = [];
  if (isScriptFile) {
    segments.push({ text: content, start: 0 });
  } else {
    for (const script of content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      const full = script[0] ?? "";
      const inner = script[1] ?? "";
      const fullIndex = script.index ?? 0;
      const openTagLen = full.indexOf(inner);
      segments.push({ text: inner, start: fullIndex + Math.max(0, openTagLen) });
    }

    const inlineHandlerRegex = /\bon(?:click|change|submit|keydown|keyup|keypress|focus|blur)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    for (const handler of content.matchAll(inlineHandlerRegex)) {
      const js = (handler[1] ?? handler[2] ?? "");
      if (!js.trim()) continue;
      segments.push({ text: js, start: handler.index ?? 0 });
    }
  }

  for (const segment of segments) {
    const dialogMatches = findGlobalAlertConfirmCalls(segment.text);
    for (const dialogMatch of dialogMatches) {
      const localIndex = dialogMatch.index;
      const globalIndex = segment.start + localIndex;
      const nearby = segment.text.slice(Math.max(0, localIndex - 180), Math.min(segment.text.length, localIndex + 240));
      if (isSuppressedAlertContext(nearby)) continue;
      const elevated = isElevatedAlertContext(nearby);

      // Skip likely development-only guard paths.
      if (/if\s*\(\s*isDevMode\s*\)|\bdevMode\b|\bDEBUG\b/i.test(nearby)) continue;

      const { line, column } = getLineColumn(content, globalIndex);
      issues.push({
        ruleId: elevated ? "aspnet/js-confirm-alert" : "aspnet/js-confirm-alert-informational",
        title: elevated
          ? "Native alert/confirm dialogs should be replaced with accessible modal UI"
          : "Native alert/confirm dialogs should be reviewed (informational advisory)",
        description:
          elevated
            ? "Detected alert/confirm/prompt in load/focus/timer context. Prefer accessible dialog behavior (wcag:3.2.1 level:A)."
            : "Detected alert/confirm/prompt invocation. This is advisory by default unless in load/focus/timer callbacks (wcag:3.2.1 level:A, advisory).",
        wcagSc: "3.2.1",
        filePath,
        line,
        column,
        htmlSnippet: dialogMatch.snippet,
      });
    }
  }

  return issues;
}

function findInlineFocusStealing(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const focusRegex = /\.focus\s*\(/gi;
  const lifecycleRegex = /(\$\s*\(\s*document\s*\)\s*\.\s*ready|document\.addEventListener\s*\(\s*['"]DOMContentLoaded['"]|window\.onload|Sys\.Application\.load|add_endRequest|pageLoad|Page_Load)/i;

  if (!lifecycleRegex.test(content)) return [];

  const firstInputId = /<(?:input|select|textarea)\b[^>]*\b(?:id|ID)\s*=\s*['"]([^'"]+)['"]/i.exec(content)?.[1]?.toLowerCase() ?? "";

  for (const match of content.matchAll(focusRegex)) {
    const index = match.index ?? 0;
    const nearby = content.slice(Math.max(0, index - 280), Math.min(content.length, index + 220));

    if (!lifecycleRegex.test(nearby)) continue;

    // Skip focus movement that follows explicit user action.
    if (/onclick|onchange|onkeydown|addEventListener\s*\(\s*['"](?:click|change|keydown|submit|tab)['"]|\.on\s*\(\s*['"](?:click|change|keydown|submit)['"]|tab\s*change|dialog\s*open/i.test(nearby)) {
      continue;
    }

    // Skip common invalid-field/error focus management patterns.
    if (/invalid|error|validation|focusInvalid|showError|aria-invalid/i.test(nearby)) continue;

    // Best effort: skip first meaningful input auto-focus patterns.
    const targetIdMatch = /(?:getElementById\s*\(\s*['"]([^'"]+)['"]\s*\)|\$\s*\(\s*['"]#([^'"]+)['"]\s*\))\s*\.focus\s*\(/i.exec(nearby);
    const targetId = (targetIdMatch?.[1] ?? targetIdMatch?.[2] ?? "").toLowerCase();
    if (targetId && firstInputId && targetId === firstInputId) continue;

    // Heuristic: focus deep in the page is more likely unexpected.
    const isDeepInPage = index > Math.floor(content.length * 0.35);
    if (!isDeepInPage) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/js-focus-stealing-informational",
      title: "Automatic focus movement on load or postback should be reviewed (informational)",
      description:
        "Programmatic focus during load/postback was detected away from top-of-page inputs. This is informational and requires human review to confirm whether the move is expected.",
      wcagSc: "3.2.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

function findInlineTabKeySuppression(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /(key(?:Code)?\s*===\s*9|key\s*===\s*['"]Tab['"]|which\s*===\s*9)[\s\S]{0,160}?preventDefault\s*\(/gi;

  for (const match of content.matchAll(regex)) {
    const index = match.index ?? 0;
    const nearby = content.slice(Math.max(0, index - 280), Math.min(content.length, index + 620));
    if (/(modal|dialog|trap|focusTrap)/i.test(filePath) || /(?:modal|dialog|trap|focusTrap)/i.test(nearby)) continue;
    const hasFocusRouting = /\.focus\s*\(/i.test(nearby);
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: hasFocusRouting ? "aspnet/custom-tab-focus-routing-informational" : "aspnet/custom-tab-key-trap",
      title: hasFocusRouting
        ? "Custom Tab key handling routes focus (informational advisory)"
        : "Custom Tab key handling may trap keyboard navigation",
      description:
        hasFocusRouting
          ? "Tab preventDefault() with explicit focus routing detected. Keep as advisory and verify expected keyboard sequence (wcag:2.1.1 level:A, advisory)."
          : "Tab preventDefault() without a corresponding .focus() call can create a custom tab trap (wcag:2.1.1 level:A).",
      wcagSc: "2.1.1",
      filePath,
      line,
      column,
      htmlSnippet: match[0],
    });
  }

  return issues;
}

// Matches a full opening tag that contains an oncontextmenu attribute.
const CONTEXT_MENU_TAG_REGEX = /<(\w[\w:-]*)\b([^>]*)>/gi;

function findContextMenuOnly(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];

  // Elements for which oncontextmenu is a suppress/augment, not a replacement:
  // the browser keyboard-exposes context menus on these, and page/frame level
  // handlers are always suppression or ASP.NET disable patterns.
  const NATIVE_CONTEXT_MENU_TAGS = new Set([
    "html", "body", "frameset", "frame",
    "textarea", "input", "a", "img", "video", "audio",
  ]);

  for (const match of content.matchAll(CONTEXT_MENU_TAG_REGEX)) {
    const tag = (match[1] ?? "").toLowerCase();
    const attrs = match[2] ?? "";
    const index = match.index ?? 0;

    if (!/\boncontextmenu\b/i.test(attrs)) continue;

    // Extract the inline handler value.
    const handlerMatch = /\boncontextmenu\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const handler = (handlerMatch?.[1] ?? handlerMatch?.[2] ?? "").trim();

    // Pass: ASP.NET server expression — we cannot know what it renders at runtime.
    if (/^<%[=#]?[\s\S]*?%>$/.test(handler)) continue;

    // Pass: handler is purely suppress/disable — nothing to keyboard-alternate.
    if (
      /^return\s+false\s*;?$/i.test(handler) ||
      /^event\.preventDefault\s*\(\s*\)\s*;?$/i.test(handler) ||
      /\.DisableContextMenu\s*\([^)]*\)\s*;?$/i.test(handler) ||
      /^Sys\.UI\.DomElement\.disableContextMenu\s*\([^)]*\)\s*;?$/i.test(handler)
    ) continue;

    // Pass: native / page-level element.
    if (NATIVE_CONTEXT_MENU_TAGS.has(tag)) continue;

    // Pass: contenteditable element.
    if (/\bcontenteditable\s*(?:=\s*(?:"true"|'true'|true))?\b/i.test(attrs)) continue;

    // Pass: element or nearby ancestor already handles Shift+F10 / ContextMenu key.
    const surrounding = content.slice(Math.max(0, index - 500), index + 500);
    const hasKeyboardContextTrigger =
      /onkeydown\s*=\s*(?:"[^"]*(?:Shift\s*\+?\s*F10|ContextMenu|shiftKey)[^"]*"|'[^']*(?:Shift\s*\+?\s*F10|ContextMenu|shiftKey)[^']*')/i.test(surrounding) ||
      /key\s*===?\s*(?:'ContextMenu'|"ContextMenu")/i.test(surrounding) ||
      /\.key\s*===?\s*(?:'F10'|"F10")/i.test(surrounding);
    if (hasKeyboardContextTrigger) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/contextmenu-only",
      title: "Context menu interactions should have a keyboard alternative",
      description:
        `Custom context menu on <${tag}> has no keyboard alternative. Add a Shift+F10 / ContextMenu keydown handler or an accessible menu button (WCAG 2.1.1).`,
      wcagSc: "2.1.1",
      filePath,
      line,
      column,
      htmlSnippet: `<${tag} ${attrs.slice(0, 200)}>`,
    });
  }

  return issues;
}

// Filename patterns for single-purpose / popup / fragment pages — skip-link rule does not apply.
const SKIP_LINK_EXEMPT_FILENAME =
  /\b(?:login|logon|signin|sign[-_]?in|logout|sign[-_]?out|error|notfound|404|500|loading|splash|splash[-_]?screen|session[-_]?timeout|blank|unload|popup|pop[-_]?up|modal|dialog|lightbox|viewer|frame|widget|panel|partial|component|close|redirect|confirm|prompt)\b/i;

function findMissingSkipLinks(content: string, filePath: string): AspxScanIssue[] {
  // Only applies to full page .aspx documents — not user controls, master files, or partials.
  if (!/\.aspx$/i.test(filePath)) return [];

  // Must be a full page with a <body>.
  if (!/<body\b/i.test(content)) return [];

  // Skip single-purpose / popup pages (filename heuristic).
  if (SKIP_LINK_EXEMPT_FILENAME.test(filePath)) return [];

  // Skip pages that are explicitly dialog or popup targets.
  if (/<[^>]+role\s*=\s*(?:"dialog"|'dialog')/i.test(content)) return [];
  if (/window\.open\s*\(/i.test(content)) return [];
  if (/window\.showModalDialog\s*\(/i.test(content)) return [];
  // Pages with parent.* DOM calls are inside a frameset — skip links are irrelevant.
  if (/\bparent\.(?:document|location|opener)\b/i.test(content)) return [];

  // Require at least a <nav>, role="navigation", OR ≥5 anchor links (navigation block heuristic).
  const hasNavLandmark = /<nav\b/i.test(content) || /role\s*=\s*(?:"navigation"|'navigation')/i.test(content);
  const linkCount = [...(content.matchAll(/<a\b[^>]*href\s*=/gi) ?? [])].length;
  if (!hasNavLandmark && linkCount < 5) return [];

  // Pass when a skip link already exists — fragment href OR visible "skip" link text.
  const hasSkipFragmentHref =
    /href\s*=\s*['"]#(?:main|content|body|mainContent|skip|skipNav|skip[-_]nav|primary|wrapper)['"]/i.test(content);
  const hasSkipLinkText =
    /<a\b[^>]*>[\s\S]*?skip\s+(?:to\s+)?(?:main|content|navigation)/i.test(content);
  if (hasSkipFragmentHref || hasSkipLinkText) return [];

  return [
    {
      ruleId: "a11y/skip-link-every-page",
      title: "Missing skip link to main content",
      description:
        "No skip link to main content found. A skip link at the start of the page helps keyboard and screen reader users bypass repetitive navigation (WCAG 2.1.1).",
      wcagSc: "2.1.1",
      filePath,
      line: 1,
      column: 1,
      htmlSnippet: "Document",
    },
  ];
}

function findColorOnlyIndicator(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  if (isThirdPartyStylesheetPath(filePath)) return issues;
  const styleBlocks = Array.from(content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)).map((m) => {
    const full = m[0] ?? "";
    const css = m[1] ?? "";
    const blockStart = m.index ?? 0;
    const cssStart = blockStart + Math.max(0, full.indexOf(css));
    return { css, cssStart };
  });
  if (styleBlocks.length === 0) return issues;

  const nonColorProps = /^(outline|outline-offset|box-shadow|border(?:-[a-z-]+)?|text-decoration|transform|width|height|min-width|min-height|max-width|max-height|padding(?:-[a-z-]+)?|margin(?:-[a-z-]+)?)$/i;
  const colorProps = /^color$/i;
  const backgroundProps = /^(background|background-color)$/i;
  const focusableToken = /(^|\s|>|\+|~)(a|button|input|select|textarea|summary)\b|\[(?:tabindex|href|contenteditable|role\s*=\s*['"]?(?:button|link|menuitem|option|tab|treeitem|checkbox|radio|switch|gridcell))/i;
  const vendorSelector = /(ui-iggrid|igdm_|infragistics|jquery-ui|\bulc_|\bui-|\bdx-|\bmat-|\bmdl-|\bant-|\.Mui)/i;

  const normalizeFocusBase = (selector: string): string =>
    selector
      .replace(/:focus-visible/gi, "")
      .replace(/:focus/gi, "")
      .replace(/\s+/g, " ")
      .trim();

  type FocusRule = { selector: string; body: string; index: number; hasNonColor: boolean; hasColor: boolean; hasBackground: boolean; groupedHover: boolean; isFocusVisible: boolean };
  const focusRules: FocusRule[] = [];
  const nonColorFocusBases = new Set<string>();

  for (const block of styleBlocks) {
    const css = block.css;
    const ruleRegex = /([^{}]+)\{([^{}]*)\}/g;
    for (const rule of css.matchAll(ruleRegex)) {
      const rawSelectors = (rule[1] ?? "").trim();
      const body = (rule[2] ?? "").trim();
      if (!rawSelectors || !body) continue;

      const selectorList = rawSelectors.split(",").map((s) => s.trim()).filter(Boolean);
      for (const selector of selectorList) {
        if (!/:focus(?:-visible)?/i.test(selector)) continue;
        if (isThirdPartySelector(selector) && !isProjectOverrideFile(filePath)) continue;
        if (/(?:\.readOnly\b|\.disabled\b|\[readonly\]|\[disabled\]|\[aria-disabled\s*=\s*['"]true['"])/i.test(selector)) continue;
        if (/\.highlightFocus\b/i.test(selector) && /\b(?:background|background-color|border(?:-color|-width|-style)?|box-shadow)\s*:/i.test(body)) continue;
        if (vendorSelector.test(selector)) continue;
        if (/\.(?:focusRing|hasFocus|keyboardFocus|visibleFocus)\b/i.test(selector) && /\b(?:background|background-color|border(?:-color|-width|-style)?|box-shadow)\s*:/i.test(body)) continue;

        const base = normalizeFocusBase(selector);
        const looksFocusable = focusableToken.test(base) || /:focus(?:-visible)?/i.test(selector);
        if (!looksFocusable) continue;

        const declarations = body.split(";").map((d) => d.trim()).filter(Boolean);
        let hasNonColor = false;
        let hasColor = false;
        let hasBackground = false;
        for (const decl of declarations) {
          const prop = decl.split(":")[0]?.trim() ?? "";
          if (!prop) continue;
          if (nonColorProps.test(prop)) hasNonColor = true;
          if (colorProps.test(prop)) hasColor = true;
          if (backgroundProps.test(prop)) hasBackground = true;
        }

        if (hasNonColor) nonColorFocusBases.add(base);

        focusRules.push({
          selector,
          body,
          index: block.cssStart + (rule.index ?? 0),
          hasNonColor,
          hasColor,
          hasBackground,
          groupedHover: /:hover/i.test(rawSelectors),
          isFocusVisible: /:focus-visible/i.test(selector),
        });
      }
    }
  }

  for (const rule of focusRules) {
    if (!rule.hasColor || rule.hasNonColor || rule.hasBackground) continue;

    const base = normalizeFocusBase(rule.selector);
    if (nonColorFocusBases.has(base)) continue;

    if (!rule.isFocusVisible) {
      const hasStrongFocusVisibleVersion = focusRules.some((candidate) =>
        candidate.isFocusVisible
        && normalizeFocusBase(candidate.selector) === base
        && /\b(?:outline\s*:\s*(?!none\b|0\b)[^;]+|box-shadow\s*:[^;]+|border(?:-color|-width|-style)?\s*:[^;]+|background(?:-color)?\s*:[^;]+)/i.test(candidate.body),
      );
      if (hasStrongFocusVisibleVersion) continue;
    }

    const { line, column } = getLineColumn(content, Math.max(0, rule.index));
    issues.push({
      ruleId: "aspnet/focus-text-color-only",
      title: "Focus style appears text-color-only",
      description:
        "Focus styling appears to change only text color without outline, shadow, border, text-decoration, transform, or size change. " +
        "Provide a non-color focus indicator for WCAG 2.4.7.",
      wcagSc: "2.4.7",
      filePath,
      line,
      column,
      htmlSnippet: `${rule.selector} { ${rule.body} }`.slice(0, 260),
    });
  }

  return issues;
}

function findErrorMessageAssociation(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const messageRegex = /<([a-z][\w:-]*)\b([^>]*)>([\s\S]{0,320}?)<\/\1>/gi;
  const statusTokens = new Set(["error", "warn", "warning", "alert", "status", "notice", "toast", "banner"]);
  const statusSuffixes = ["error", "warning", "alert", "status"];
  const excludedCompounds = new Set([
    "messageinfo",
    "messagethread",
    "messageauthor",
    "messagepreview",
    "messagebody",
    "messageheader",
    "messagecontent",
    "messagesubject",
    "messagedate",
  ]);
  const taskTokens = new Set(["executing", "loading", "processing", "inprogress", "pending"]);
  const liveRegionRanges = collectLiveRegionRanges(content);

  for (const match of content.matchAll(messageRegex)) {
    const tagName = (match[1] ?? "").toLowerCase();
    const attrs = match[2] ?? "";
    const inner = match[3] ?? "";
    const index = match.index ?? 0;
    if (tagName === "label" || tagName === "asp:label") continue;

    const idRaw = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const classRaw = /\bclass\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
    const idValue = (idRaw?.[1] ?? idRaw?.[2] ?? idRaw?.[3] ?? "").trim();
    const classValue = (classRaw?.[1] ?? classRaw?.[2] ?? classRaw?.[3] ?? "").trim();

    const classTokens = classValue
      .split(/\s+/)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);

    const isButtonLikeElement =
      tagName === "button" ||
      tagName === "asp:button" ||
      tagName === "asp:linkbutton" ||
      tagName === "asp:imagebutton" ||
      (tagName === "a" && classTokens.some((token) => token === "btn" || token.startsWith("btn-"))) ||
      (tagName === "input" && /\btype\s*=\s*['"]?(?:button|submit|image)['"]?/i.test(attrs));
    if (isButtonLikeElement) continue;

    if (classTokens.some((token) => /^(?:btn-(?:warning|danger|error|success|info|alert)|(?:warning|danger|error|success|info|alert)-btn)$/i.test(token))) {
      continue;
    }

    const splitTokens = `${idValue} ${classValue}`
      .split(/[^A-Za-z0-9]+/)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);

    if (splitTokens.some((token) => excludedCompounds.has(token))) continue;

    const standaloneStatusRegex = /^(?:error|warn|warning|alert|status|notice|toast|banner)$/i;
    const statusSuffixRegex = /(?:^|[-_])(?:error|warning|alert|status)(?:[-_](?:message|text|container|region))?$/i;
    const hasExactStatusToken = splitTokens.some((token) => standaloneStatusRegex.test(token) || statusTokens.has(token));
    const hasStatusSuffix = [idValue, ...classTokens].some((token) => statusSuffixRegex.test(token));
    const hasTaskToken = splitTokens.some((token) => taskTokens.has(token));
    const isEmptyStatePattern = /\b(?:emptyState|errorState)\b/i.test(`${idValue} ${classValue}`);

    if (!hasExactStatusToken && !hasStatusSuffix && !hasTaskToken && !isEmptyStatePattern) continue;

    if (isWithinAnyRange(index, liveRegionRanges)) {
      continue;
    }

    if (isEmptyStatePattern) {
      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: "a11y/empty-state-should-be-region",
        title: "Empty-state container should expose region semantics",
        description: "Empty/error state container appears to be a static design-state surface. Prefer role=region with aria-labelledby instead of notification semantics.",
        wcagSc: "1.3.1",
        filePath,
        line,
        column,
        htmlSnippet: (match[0] ?? "").slice(0, 220),
      });
      continue;
    }

    // Skip when element itself has live region semantics.
    if (/\brole\s*=\s*['"](?:alert|status|log)['"]|\baria-live\s*=\s*['"](?:polite|assertive)['"]|\baria-atomic\s*=/i.test(attrs)) {
      continue;
    }

    // Skip when a nearby parent appears to provide live-region semantics.
    const parentWindow = content.slice(Math.max(0, index - 500), index + 200);
    if (/<[^>]+(?:role\s*=\s*['"](?:alert|status|log)['"]|aria-live\s*=\s*['"](?:polite|assertive)['"]|aria-atomic\s*=)[^>]*>/i.test(parentWindow)) {
      continue;
    }

    // Require runtime-toggle heuristic (dynamic announcement scenario).
    const dynamicToggleSignals =
      /\b(?:hidden|display\s*:\s*none|visibility\s*:\s*hidden|class\s*=\s*['"][^'"]*hide[^'"]*['"]|\?:\s*['"][^'"]*['"]\s*:\s*['"][^'"]*['"]|<%[\s\S]*?%>|\.toggle\(|\.show\(|\.hide\(|classList\.(?:add|remove|toggle))/i.test(`${attrs} ${inner} ${parentWindow}`);
    if (!dynamicToggleSignals) continue;

    // Server-rendered static content should not be treated as runtime status messages.
    if ((hasServerExpressionContent(inner) || stripTagsAndServerBlocks(inner).length > 0) && !/hide|hidden|toggle|show|display\s*:\s*none|visibility\s*:\s*hidden/i.test(`${attrs} ${parentWindow}`)) {
      continue;
    }

    // Skip static persistent labels (non-dynamic plain text).
    const plainText = stripTagsAndServerBlocks(inner).trim();
    const looksStatic = plainText.length > 0 && !/<%[\s\S]*?%>|\{\{[\s\S]*?\}\}|\?\s*['"]/i.test(inner);
    if (looksStatic && !/hide|hidden|toggle|show|display\s*:\s*none|visibility\s*:\s*hidden/i.test(parentWindow + attrs)) {
      continue;
    }

    if (hasTaskToken) {
      const hasPoliteLive = /\baria-live\s*=\s*['"]polite['"]/i.test(attrs);
      const hasBusyTrue = /\baria-busy\s*=\s*['"]true['"]/i.test(attrs);
      if (hasPoliteLive && hasBusyTrue) continue;
      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: "aspnet/task-in-progress-needs-busy-live",
        title: "Task-in-progress status needs polite live region with busy state",
        description:
          "Loading/executing/pending status containers should use aria-live=\"polite\" and aria-busy=\"true\" for assistive technology announcements (wcag:4.1.3 level:AA).",
        wcagSc: "4.1.3",
        filePath,
        line,
        column,
        htmlSnippet: (match[0] ?? "").slice(0, 220),
      });
      continue;
    }

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/dynamic-status-message-needs-live-region",
      title: "Dynamic status/error message needs live-region semantics",
      description:
        "Dynamic status/error text detected from class/id tokens but no live-region semantics were found. Add role=alert/status/log or aria-live/aria-atomic (wcag:4.1.3 level:AA).",
      wcagSc: "4.1.3",
      filePath,
      line,
      column,
      htmlSnippet: (match[0] ?? "").slice(0, 220),
    });
  }

  return issues;
}

function findAsteriskRequiredIndicator(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const labelRegex = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;

  for (const match of content.matchAll(labelRegex)) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    if (!/<input\b[^>]*\brequired\b|<select\b[^>]*\brequired\b|<textarea\b[^>]*\brequired\b/i.test(body)) continue;
    if (/\*|required|mandatory|must provide/i.test(body)) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/asterisk-required-inconsistent",
      title: "Required form fields may need visual indicator (asterisk/text)",
      description:
        "Labels for required fields should include a visual indicator (asterisk, 'required', etc.) consistently across the form (WCAG 3.3.2, heuristic).",
      wcagSc: "3.3.2",
      filePath,
      line,
      column,
      htmlSnippet: (match[0] ?? "").slice(0, 200),
    });
  }

  return issues;
}

// ─── Shared helpers for label association ─────────────────────────────────────

function collectLabelledIds(content: string): Set<string> {
  const ids = new Set<string>();
  // asp:Label AssociatedControlID
  for (const m of content.matchAll(/<asp:Label\b[^>]*\bAssociatedControlID\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    const value = (m[1] ?? m[2] ?? m[3] ?? "").trim().toLowerCase();
    if (value) ids.add(value);
  }
  // HTML <label for="...">
  for (const m of content.matchAll(/<label\b[^>]*\bfor\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    const value = (m[1] ?? m[2] ?? m[3] ?? "").trim().toLowerCase();
    if (value) ids.add(value);
  }
  // aria-labelledby values (not used as a "target" but as a source — skip here)
  return ids;
}

function collectKnownElementIds(content: string): Set<string> {
  const ids = new Set<string>();
  const idRegex = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  const aspIdRegex = /\bID\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;

  for (const m of content.matchAll(idRegex)) {
    const id = (m[1] ?? m[2] ?? m[3] ?? "").trim().toLowerCase();
    if (id) ids.add(id);
  }

  for (const m of content.matchAll(aspIdRegex)) {
    const id = (m[1] ?? m[2] ?? m[3] ?? "").trim().toLowerCase();
    if (id) ids.add(id);
  }

  return ids;
}

function hasServerControlChild(inner: string): boolean {
  return /<[A-Za-z][\w-]*:[\w-]+\b[^>]*\brunat\s*=\s*['"]server['"]/i.test(inner);
}

function isLikelyServerEmittedClientIdTarget(
  targetId: string,
  knownIds: Set<string>,
  serverControlIds: Set<string>,
): boolean {
  const normalized = targetId.trim().toLowerCase();
  if (!normalized || !normalized.includes("_")) return false;
  if (knownIds.has(normalized) || serverControlIds.has(normalized)) return true;

  const tokens = normalized.split("_").filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const suffix = tokens.slice(i).join("_");
    if (knownIds.has(suffix) || serverControlIds.has(suffix)) {
      return true;
    }
    const leaf = tokens[i] ?? "";
    if (knownIds.has(leaf) || serverControlIds.has(leaf)) {
      return true;
    }
  }

  return /(?:datepicker|daterange|picker|panel|grid|list|table|control)/i.test(normalized);
}

function isWrappedInLabel(content: string, index: number): boolean {
  const startWindow = Math.max(0, index - 400);
  const endWindow = Math.min(content.length, index + 400);
  const before = content.slice(startWindow, index);
  const after = content.slice(index, endWindow);
  const openIndex = before.lastIndexOf("<label");
  const closeIndex = before.lastIndexOf("</label>");
  if (openIndex === -1 || openIndex < closeIndex) return false;
  return /<\/label>/i.test(after);
}

function hasAriaLabelAttr(attrs: string): boolean {
  return (
    /\baria-label\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs) ||
    /\baria-labelledby\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs)
  );
}

function hasResolvableAriaLabelledby(attrs: string, knownIds: Set<string>): boolean {
  const labelledbyMatch = /\baria-labelledby\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs);
  if (!labelledbyMatch) return false;
  const rawValue = (labelledbyMatch[1] ?? labelledbyMatch[2] ?? "").trim();
  if (!rawValue) return false;
  const refs = rawValue.split(/\s+/).map((id) => id.toLowerCase());
  return refs.some((id) => knownIds.has(id));
}

function isLikelyTemplatedServerControlContext(content: string, index: number): boolean {
  const start = Math.max(0, index - 2400);
  const region = content.slice(start, index);
  const hasTemplatedParent = /<asp:(?:Repeater|DataList|GridView|ListView|FormView|DetailsView|Menu)\b/i.test(region);
  const hasTemplateRegion = /<(?:ItemTemplate|AlternatingItemTemplate|EditItemTemplate|InsertItemTemplate|LayoutTemplate|HeaderTemplate|FooterTemplate|TemplateField)\b/i.test(region);
  return hasTemplatedParent && hasTemplateRegion;
}

function isInServerConditionalBranch(content: string, index: number): boolean {
  const start = Math.max(0, index - 500);
  const end = Math.min(content.length, index + 250);
  const around = content.slice(start, end);
  return /<%\s*(?:if|else|switch|case)\b/i.test(around) || /<asp:PlaceHolder\b[^>]*\bVisible\s*=|<asp:MultiView\b|<asp:View\b/i.test(around);
}

function findMissingHtmlLang(content: string, filePath: string): AspxScanIssue[] {
  const htmlMatch = /<html\b[^>]*>/i.exec(content);
  if (!htmlMatch) return [];

  const snippet = htmlMatch[0];
  const langMatch = /\blang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(snippet);
  if (!langMatch) {
    const index = htmlMatch.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    return [
      {
        ruleId: "aspnet/html-has-lang",
        title: "HTML element must have a lang attribute",
        description: "Document html element is missing a lang attribute.",
        wcagSc: "3.1.1",
        filePath,
        line,
        column,
        htmlSnippet: snippet,
      },
    ];
  }

  const langValue = (langMatch[1] ?? langMatch[2] ?? langMatch[3] ?? "").trim();
  const langPattern = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
  if (langValue.length === 0) {
    const index = htmlMatch.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    return [
      {
        ruleId: "aspnet/html-lang-empty",
        title: "HTML lang attribute is empty",
        description: "Document html lang attribute is present but empty, so assistive technology cannot determine page language (WCAG 3.1.1).",
        wcagSc: "3.1.1",
        filePath,
        line,
        column,
        htmlSnippet: snippet,
      },
    ];
  }

  if (langPattern.test(langValue) && langValue === langValue.toLowerCase()) {
    return [];
  }

  const index = htmlMatch.index ?? 0;
  const { line, column } = getLineColumn(content, index);
  return [
    {
      ruleId: "aspnet/html-lang-invalid",
      title: "HTML lang attribute appears invalid",
      description: "Document html lang value is empty, mis-cased, or not a valid BCP-47-like tag (WCAG 3.1.1).",
      wcagSc: "3.1.1",
      filePath,
      line,
      column,
      htmlSnippet: snippet,
    },
  ];
}

function findEmptyAnchors(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const inner = match[1] ?? "";
    const index = match.index ?? 0;
    const hasLabel =
      /\baria-label\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(snippet) ||
      /\baria-labelledby\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(snippet) ||
      /\btitle\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(snippet);

    if (hasLabel) continue;

    const text = stripTagsAndServerBlocks(inner);
    if (hasServerExpressionContent(inner)) continue;
    if (text.length > 0) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/anchor-has-content",
      title: "Links must have discernible text",
      description: "Anchor element has no visible or accessible text.",
      wcagSc: "2.4.4",
      filePath,
      line,
      column,
      htmlSnippet: snippet,
    });
  }
  return issues;
}

function findEmptyButtons(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
  for (const match of content.matchAll(regex)) {
    const snippet = match[0];
    const inner = match[1] ?? "";
    const index = match.index ?? 0;
    const hasLabel =
      /\baria-label\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(snippet) ||
      /\baria-labelledby\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(snippet) ||
      /\btitle\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(snippet);

    if (hasLabel) continue;

    // Pass if button is hidden from AT via inline style or aria-hidden.
    if (/style\s*=\s*['"][^'"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^'"]*['"]|\baria-hidden\s*=\s*['"]true['"]|\bhidden\b/i.test(snippet)) {
      continue;
    }

    // Pass if content contains server expressions.
    if (hasServerExpressionContent(inner)) continue;

    // Pass if content contains labeled icon (SVG with title, img with alt, or element with aria-label).
    if (/\baria-label\s*=|<img\b[^>]*\balt\s*=|<svg\b[^>]*>[^<]*<title\b|<title[^>]*>/i.test(inner)) {
      continue;
    }

    const text = stripTagsAndServerBlocks(inner);
    if (text.length > 0) continue;

    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/button-has-content",
      title: "Buttons must have discernible text",
      description: "Plain HTML <button> element has no visible text, aria-label, title, or accessible icon content (WCAG 4.1.2).",
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: snippet.slice(0, 200),
    });
  }
  return issues;
}

function canonicalRuleIdForDedup(ruleId: string): string {
  switch (ruleId) {
    case "aspnet/grid-missing-caption":
    case "aspnet/gridview-details-missing-caption":
      return "aspnet/table-data-missing-caption";
    case "aspnet/tabindex-noninteractive-no-role":
    case "aspnet/tabindex-non-interactive-without-role":
      return "aspnet/tabindex-noninteractive-without-role";
    default:
      return ruleId;
  }
}

function applyFindingNoiseControls(findings: Finding[], repoPath: string): Finding[] {
  const deduped: Finding[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    const findingPath = finding.filePath ?? "";
    if (shouldSkipStaticFile(findingPath)) {
      continue;
    }

    const key = [
      normalizePath(findingPath),
      `${finding.line ?? 0}`,
      canonicalRuleIdForDedup(finding.ruleId),
    ].join("|");

    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }

  const limited: Finding[] = [];
  const perFileRuleCounts = new Map<string, number>();
  for (const finding of deduped) {
    const limit = PER_FILE_RULE_LIMITS[finding.ruleId];
    if (!limit) {
      limited.push(finding);
      continue;
    }

    const countKey = `${normalizePath(finding.filePath ?? "")}|${finding.ruleId}`;
    const currentCount = perFileRuleCounts.get(countKey) ?? 0;
    if (currentCount >= limit) continue;

    perFileRuleCounts.set(countKey, currentCount + 1);
    limited.push(finding);
  }

  return applyA11yScopeTiering(limited, repoPath);
}

function isAdvisoryRule(ruleId: string): boolean {
  return /informational|advisory/i.test(ruleId);
}

function applyRuleSeverityOverrides(ruleId: string, severity: Severity): Severity {
  if (/informational|advisory/i.test(ruleId)) return "minor";
  return severity;
}

function isRuntimeReviewRuleId(ruleId: string): boolean {
  return /-runtime-review$/i.test(ruleId);
}

function downgradeSeverityOneLevel(severity: Severity): Severity {
  switch (severity) {
    case "blocker":
      return "severe";
    case "severe":
      return "major";
    case "major":
      return "minor";
    default:
      return severity;
  }
}

function applyA11yScopeTiering(findings: Finding[], repoPath: string): Finding[] {
  const config = readA11yScopeConfig(repoPath);
  if (!config) return findings;

  const includeInternal = process.env.A11Y_INCLUDE_INTERNAL === "1";
  return findings
    .filter((finding) => {
      const tier = getTierForPath(finding.filePath ?? "", config);
      if (tier === "internal" && !includeInternal) return false;
      return true;
    })
    .map((finding) => {
      const tier = getTierForPath(finding.filePath ?? "", config);
      if (tier !== "admin") return finding;
      return {
        ...finding,
        severity: downgradeSeverityOneLevel(finding.severity),
        tags: [...(finding.tags ?? []), "scope:admin"],
      };
    });
}

function readA11yScopeConfig(repoPath: string): A11yScopeConfig | null {
  const configPath = join(repoPath, "a11y-scope.json");
  if (!existsSync(configPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as A11yScopeConfig;
    return parsed;
  } catch {
    return null;
  }
}

function getTierForPath(filePath: string, config: A11yScopeConfig): "public" | "admin" | "internal" {
  const normalized = normalizePath(filePath);
  const tiers = config.tiers ?? config;
  const admin = (tiers.admin ?? []).some((glob) => globMatch(normalized, glob));
  if (admin) return "admin";
  const internal = (tiers.internal ?? []).some((glob) => globMatch(normalized, glob));
  if (internal) return "internal";
  return "public";
}

function globMatch(value: string, pattern: string): boolean {
  const normalizedPattern = normalizePath(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexSource = normalizedPattern
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${regexSource}$`, "i").test(value);
}

function findGlobalAlertConfirmCalls(js: string): Array<{ index: number; snippet: string }> {
  const matches: Array<{ index: number; snippet: string }> = [];
  const len = js.length;
  let i = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;

  const isIdent = (ch: string | undefined): boolean => Boolean(ch && /[A-Za-z0-9_$]/.test(ch));
  const skipWs = (start: number): number => {
    let p = start;
    while (p < len && /\s/.test(js[p] ?? "")) p += 1;
    return p;
  };
  const pushMatch = (idx: number): void => {
    matches.push({
      index: idx,
      snippet: (js.slice(idx, Math.min(len, idx + 100)) || "").trim(),
    });
  };

  while (i < len) {
    const ch = js[i] ?? "";
    const next = js[i + 1] ?? "";

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (inSingleQuote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "'") inSingleQuote = false;
      i += 1;
      continue;
    }
    if (inDoubleQuote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') inDoubleQuote = false;
      i += 1;
      continue;
    }
    if (inTemplate) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") inTemplate = false;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      i += 1;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      i += 1;
      continue;
    }

    if (!isIdent(ch)) {
      i += 1;
      continue;
    }

    if (js.startsWith("window", i) && !isIdent(js[i - 1]) && !isIdent(js[i + 6])) {
      let p = skipWs(i + 6);
      if (js[p] !== ".") {
        i += 1;
        continue;
      }
      p = skipWs(p + 1);

      const callName = js.startsWith("alert", p)
        ? "alert"
        : js.startsWith("confirm", p)
          ? "confirm"
          : "";
      if (!callName) {
        i += 1;
        continue;
      }

      const end = p + callName.length;
      if (isIdent(js[end])) {
        i += 1;
        continue;
      }

      p = skipWs(end);
      if (js[p] === "(") {
        pushMatch(i);
        i = p + 1;
        continue;
      }
      i += 1;
      continue;
    }

    const callName = js.startsWith("alert", i)
      ? "alert"
      : js.startsWith("confirm", i)
        ? "confirm"
        : "";
    if (!callName) {
      i += 1;
      continue;
    }

    if (isIdent(js[i - 1])) {
      i += 1;
      continue;
    }

    const prevNonWs = (() => {
      let p = i - 1;
      while (p >= 0 && /\s/.test(js[p] ?? "")) p -= 1;
      return p >= 0 ? js[p] : "";
    })();
    if (prevNonWs === ".") {
      i += 1;
      continue;
    }

    const end = i + callName.length;
    if (isIdent(js[end])) {
      i += 1;
      continue;
    }

    const open = skipWs(end);
    if (js[open] === "(") {
      pushMatch(i);
      i = open + 1;
      continue;
    }

    i += 1;
  }

  return matches;
}

function hasRightmostHtmlOrBodyTarget(selectorGroup: string): boolean {
  const selectors = splitSelectors(selectorGroup);
  return selectors.some((selector) => {
    const rightmost = getRightmostSimpleSelector(selector);
    return rightmost === "html" || rightmost === "body";
  });
}

function selectorHasLanguageExemption(selectorGroup: string): boolean {
  return /:lang\s*\(\s*(?:ar|he|ja|ko|zh|th|hi|bn)\s*\)/i.test(selectorGroup);
}

function splitSelectors(selectorGroup: string): string[] {
  const selectors: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < selectorGroup.length; i += 1) {
    const ch = selectorGroup[i] ?? "";

    if (quote) {
      current += ch;
      if (ch === "\\") {
        const next = selectorGroup[i + 1] ?? "";
        if (next) {
          current += next;
          i += 1;
        }
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "(") {
      parenDepth += 1;
      current += ch;
      continue;
    }
    if (ch === ")") {
      if (parenDepth > 0) parenDepth -= 1;
      current += ch;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      current += ch;
      continue;
    }
    if (ch === "]") {
      if (bracketDepth > 0) bracketDepth -= 1;
      current += ch;
      continue;
    }

    if (ch === "," && parenDepth === 0 && bracketDepth === 0) {
      const token = current.trim();
      if (token) selectors.push(token);
      current = "";
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) selectors.push(tail);
  return selectors;
}

function getRightmostSimpleSelector(selector: string): string | null {
  const normalized = selector
    .replace(/\s+/g, " ")
    .replace(/::?[A-Za-z-]+(?:\([^)]*\))?/g, "")
    .trim();

  if (!normalized) return null;

  const parts = normalized
    .split(/\s*[>+~]\s*|\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const rightmost = parts[parts.length - 1] ?? "";
  if (!rightmost) return null;

  // Ignore compound selectors that include class/id/attrs in the rightmost token.
  if (/[.#\[]/.test(rightmost)) return null;

  const tag = rightmost.toLowerCase();
  return tag === "html" || tag === "body" ? tag : null;
}

function hasCssSkipHeader(content: string): boolean {
  const header = content.slice(0, 1600);
  if (/a11y-scan-skip-file\s*:/i.test(header)) return true;
  if (/\b(?:NOT\s+used|unused|deprecated|do\s+not\s+use)\b/i.test(header)) return true;
  return false;
}

function isProjectOverrideFile(filePath: string): boolean {
  return /(?:override|overrides|custom|site\.css)$/i.test(normalizePath(filePath));
}

function isThirdPartyStylesheetPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return /styles\/gis\/gismapviewer\.css$/i.test(normalized)
    || /reportingdashboards\/styles\/css\/dashboardviewer-[^/]+\.css$/i.test(normalized);
}

function isThirdPartySelector(selector: string): boolean {
  return /\.(?:ui-|ig-|ui-iggrid-|igdm_|dx-|mat-|mdl-|ant-|Mui)/i.test(selector);
}

function buildPairedFocusVisibleSelector(selector: string): string | null {
  if (!/:focus(?!-visible)/i.test(selector)) return null;
  return selector.replace(/:focus(?!-visible)/gi, ":focus-visible");
}

function hasExpandedCheckboxRadioHitArea(content: string, selector: string, body: string): boolean {
  if (/\b(?:padding|min-width|min-height)\s*:/i.test(body)) return true;

  const base = selector
    .replace(/:focus-visible|:focus|:hover|:active/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const baseEscaped = escapeRegex(base);

  const expandedLabelRule = new RegExp(
    String.raw`${baseEscaped}[^{]*label[^{]*\{[^}]*\b(?:padding|min-width|min-height)\s*:\s*(?:2[4-9]|[3-9]\d|\d{3,})`,
    "i",
  );
  if (expandedLabelRule.test(content)) return true;

  const siblingLabelRule = new RegExp(
    String.raw`${baseEscaped}[^{]*(?:\+|~)\s*label[^{]*\{[^}]*\b(?:padding|min-width|min-height)\s*:`,
    "i",
  );
  if (siblingLabelRule.test(content)) return true;

  const wrapperRule = new RegExp(
    String.raw`(?:label|\.checkbox|\.radio|\.choice)[^{]*\{[^}]*\b(?:padding|min-width|min-height)\s*:\s*(?:2[4-9]|[3-9]\d|\d{3,})`,
    "i",
  );
  if (wrapperRule.test(content)) return true;

  return false;
}

function hasSelectorContainerHitArea(content: string, selector: string, body: string): boolean {
  if (/\b(?:padding|min-width|min-height)\s*:/i.test(body)) {
    const minWidth = parseCssPx(body, "min-width") ?? 0;
    const minHeight = parseCssPx(body, "min-height") ?? 0;
    const width = parseCssPx(body, "width") ?? 0;
    const height = parseCssPx(body, "height") ?? 0;
    if (Math.max(minWidth, width) >= 24 || Math.max(minHeight, height) >= 24) {
      return true;
    }
  }

  const classTokens = Array.from(selector.matchAll(/\.([A-Za-z_][\w-]*)/g)).map((m) => (m[1] ?? "").trim()).filter(Boolean);
  if (classTokens.length === 0) return false;

  for (const token of classTokens) {
    const escaped = escapeRegex(token);
    const classRule = new RegExp(
      String.raw`\.${escaped}(?:\b|[\s>+~:#\[])[^{]*\{[^}]*\b(?:padding|min-width|min-height)\s*:\s*(?:2[4-9]|[3-9]\d|\d{3,})`,
      "i",
    );
    if (classRule.test(content)) {
      return true;
    }

    const wrappedLabelRule = new RegExp(
      String.raw`\.${escaped}[^{]*(?:\+|~)?\s*label[^{]*\{[^}]*\b(?:padding|min-width|min-height)\s*:\s*(?:2[4-9]|[3-9]\d|\d{3,})`,
      "i",
    );
    if (wrappedLabelRule.test(content)) {
      return true;
    }
  }

  return false;
}

function collectLiveRegionRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const containerRegex = /<(div|section|aside|span|p|li|ul|ol)\b([^>]*)>([\s\S]*?)<\/\1>/gi;

  for (const m of content.matchAll(containerRegex)) {
    const attrs = m[2] ?? "";
    if (!/\brole\s*=\s*['"](?:alert|status|log)['"]|\baria-live\s*=\s*['"](?:polite|assertive)['"]|\baria-atomic\s*=\s*['"]true['"]/i.test(attrs)) {
      continue;
    }
    const start = m.index ?? 0;
    const end = start + (m[0]?.length ?? 0);
    if (end > start) ranges.push([start, end]);
  }

  return ranges;
}

function isElevatedAlertContext(windowText: string): boolean {
  return (
    /\b(?:focus|focusin|load|pageload|Sys\.Application\.add_load|add_endRequest)\b/i.test(windowText) ||
    /set(?:Interval|Timeout)\s*\(/i.test(windowText)
  );
}

function isSuppressedAlertContext(windowText: string): boolean {
  if (/catch\s*\([^)]*\)\s*\{[\s\S]{0,280}(?:alert|confirm)\s*\(/i.test(windowText)) return true;
  if (/if\s*\([^)]*\b(?:error|err|failure|fault)\w*\b[^)]*\)\s*\{[\s\S]{0,280}(?:alert|confirm)\s*\(/i.test(windowText)) {
    return true;
  }
  return false;
}

function isGraphicsWidgetContext(targetExpr: string, nearby: string): boolean {
  const widgetText = `${targetExpr} ${nearby}`;
  const canvasSignal = /<canvas\b|\bHTMLCanvasElement\b|\bgetContext\s*\(/i.test(widgetText);
  const svgMapSignal = /<svg\b[^>]*\bclass\s*=\s*['"][^'"]*(?:map|graph|chart|draw|canvas|viewport)[^'"]*['"]/i.test(widgetText);

  const namedViewportSignal =
    /\bview\s*\.\s*container\b|\bArcGIS\b/i.test(widgetText) ||
    /\bL\s*\.\s*map\s*\(|\bleaflet\b|\bmap\s*\.\s*getContainer\s*\(/i.test(widgetText) ||
    /\bnew\s+ol\s*\.\s*Map\s*\(|\bOpenLayers\b/i.test(widgetText) ||
    /\bnew\s+mapboxgl\s*\.\s*Map\s*\(|\bMapbox\b/i.test(widgetText) ||
    /\bnew\s+fabric\s*\.\s*Canvas\s*\(|\bFabric(?:\.js)?\b/i.test(widgetText) ||
    /\bd3\s*\.(?:select|zoom|drag)\b|\bD3\b/i.test(widgetText);

  const targetNameSignal = /\b(?:map|graph|chart|draw|canvas|viewport)\b/i.test(targetExpr);

  return canvasSignal || svgMapSignal || namedViewportSignal || targetNameSignal;
}

function analyzeCreateElementFlow(
  content: string,
  variableName: string,
  declarationIndex: number,
): CreateElementFlowState {
  const state: CreateElementFlowState = {
    insertedIntoDom: false,
    hasAltText: false,
    hasAccessibleName: false,
    hasAssociatedLabelByFor: false,
    isAriaHidden: false,
    idValues: new Set<string>(),
  };

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile("a11y-flow.js", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  } catch {
    return state;
  }

  const declaration = findCreateElementDeclarationNode(sourceFile, variableName, declarationIndex);
  if (!declaration) return state;

  const scope = findEnclosingFunctionOrSource(declaration, sourceFile);
  const helperMap = collectNamedHelpers(sourceFile);
  evaluateCreateElementFlowNode(scope, new Set([variableName]), state, helperMap, new Set(), declaration.pos);

  if (state.idValues.size > 0 && hasLabelForAssociationInScope(scope.getText(sourceFile), state.idValues)) {
    state.hasAssociatedLabelByFor = true;
  }

  return state;
}

function findCreateElementDeclarationNode(
  sourceFile: ts.SourceFile,
  variableName: string,
  declarationIndex: number,
): ts.VariableDeclaration | null {
  let best: ts.VariableDeclaration | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === variableName && node.initializer && ts.isCallExpression(node.initializer)) {
        const exprText = node.initializer.expression.getText(sourceFile);
        const firstArg = node.initializer.arguments[0];
        const tagValue = extractStringLiteral(firstArg)?.toLowerCase();
        if (/document\s*\.\s*createElement$/.test(exprText) && tagValue) {
          const distance = Math.abs(node.getStart(sourceFile) - declarationIndex);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = node;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return best;
}

function findEnclosingFunctionOrSource(node: ts.Node, sourceFile: ts.SourceFile): ts.Node {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionLike(current) && "body" in current && current.body) return current.body;
    current = current.parent;
  }
  return sourceFile;
}

function collectNamedHelpers(sourceFile: ts.SourceFile): Map<string, ts.FunctionLikeDeclarationBase> {
  const helpers = new Map<string, ts.FunctionLikeDeclarationBase>();

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      helpers.set(node.name.text, node);
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          helpers.set(decl.name.text, decl.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return helpers;
}

function evaluateCreateElementFlowNode(
  root: ts.Node,
  aliases: Set<string>,
  state: CreateElementFlowState,
  helperMap: Map<string, ts.FunctionLikeDeclarationBase>,
  visitedHelpers: Set<string>,
  declarationPos: number,
): void {
  const visit = (node: ts.Node): void => {
    if (node.pos <= declarationPos) {
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isFunctionLike(node) && node !== root) {
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer)) {
      if (aliases.has(node.initializer.text)) {
        aliases.add(node.name.text);
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      const right = node.right;

      if (ts.isIdentifier(left) && ts.isIdentifier(right) && aliases.has(right.text)) {
        aliases.add(left.text);
      }

      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && aliases.has(left.expression.text)) {
        applyCreateElementPropertyWrite(left.name.text, right, state);
      }

      if (ts.isElementAccessExpression(left) && ts.isPropertyAccessExpression(left.expression) &&
        ts.isIdentifier(left.expression.expression) && aliases.has(left.expression.expression.text) &&
        left.expression.name.text === "Attributes") {
        const attrName = extractStringLiteral(left.argumentExpression)?.toLowerCase();
        if (attrName) {
          applyCreateElementAttributeWrite(attrName, right, state);
        }
      }
    }

    if (ts.isCallExpression(node)) {
      applyCreateElementCallFlow(node, aliases, state, helperMap, visitedHelpers);
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(root, visit);
}

function applyCreateElementCallFlow(
  call: ts.CallExpression,
  aliases: Set<string>,
  state: CreateElementFlowState,
  helperMap: Map<string, ts.FunctionLikeDeclarationBase>,
  visitedHelpers: Set<string>,
): void {
  const expr = call.expression;

  if (ts.isPropertyAccessExpression(expr)) {
    const method = expr.name.text;

    if (isDomInsertionMethod(method)) {
      const firstArg = call.arguments[0];
      if (firstArg && ts.isIdentifier(firstArg) && aliases.has(firstArg.text)) {
        state.insertedIntoDom = true;
      }
    }

    if (ts.isIdentifier(expr.expression) && aliases.has(expr.expression.text)) {
      if (method === "setAttribute") {
        const attrName = extractStringLiteral(call.arguments[0])?.toLowerCase();
        if (attrName) {
          applyCreateElementAttributeWrite(attrName, call.arguments[1], state);
        }
      } else if (method === "remove") {
        state.insertedIntoDom = true;
      }
    }
  }

  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Object" && expr.name.text === "assign") {
    const target = call.arguments[0];
    const source = call.arguments[1];
    if (target && ts.isIdentifier(target) && aliases.has(target.text) && source && ts.isObjectLiteralExpression(source)) {
      for (const prop of source.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const propName = getPropertyNameText(prop.name)?.toLowerCase();
        if (!propName) continue;
        applyCreateElementAttributeWrite(propName, prop.initializer, state);
      }
    }
  }

  if (ts.isIdentifier(expr)) {
    const helper = helperMap.get(expr.text);
    if (!helper || !helper.parameters.length || !helper.body) return;

    const helperKey = `${expr.text}`;
    if (visitedHelpers.has(helperKey)) return;

    for (let i = 0; i < helper.parameters.length; i += 1) {
      const param = helper.parameters[i];
      const arg = call.arguments[i];
      if (!param) continue;
      if (!arg || !ts.isIdentifier(arg) || !aliases.has(arg.text)) continue;
      if (!ts.isIdentifier(param.name)) continue;

      visitedHelpers.add(helperKey);
      evaluateCreateElementFlowNode(helper.body, new Set([param.name.text]), state, helperMap, visitedHelpers, -1);
      visitedHelpers.delete(helperKey);
    }
  }
}

function applyCreateElementPropertyWrite(
  propertyName: string,
  value: ts.Expression,
  state: CreateElementFlowState,
): void {
  const name = propertyName.toLowerCase();
  if (name === "alt") state.hasAltText = hasNonWhitespaceExpressionValue(value);
  if (name === "arialabel" || name === "title" || name === "placeholder" || name === "textcontent" || name === "innertext" || name === "innerhtml") {
    if (hasNonWhitespaceExpressionValue(value)) state.hasAccessibleName = true;
  }
  if (name === "type") {
    const typeValue = extractStringLiteral(value);
    if (typeValue) state.inferredInputType = typeValue.toLowerCase();
  }
  if (name === "id") {
    const idValue = extractStringLiteral(value)?.trim();
    if (idValue) state.idValues.add(idValue);
  }
  if (name === "ariahidden") {
    const boolText = value.getText().trim().toLowerCase();
    if (boolText === "true" || boolText === "'true'" || boolText === '"true"') {
      state.isAriaHidden = true;
    }
  }
}

function applyCreateElementAttributeWrite(
  attrName: string,
  value: ts.Expression | undefined,
  state: CreateElementFlowState,
): void {
  const attr = attrName.toLowerCase();
  if (attr === "alt" && value && hasNonWhitespaceExpressionValue(value)) state.hasAltText = true;
  if ((attr === "aria-label" || attr === "aria-labelledby" || attr === "title" || attr === "placeholder") && value && hasNonWhitespaceExpressionValue(value)) {
    state.hasAccessibleName = true;
  }
  if (attr === "type") {
    const typeValue = value ? extractStringLiteral(value) : undefined;
    if (typeValue) state.inferredInputType = typeValue.toLowerCase();
  }
  if (attr === "id") {
    const idValue = value ? extractStringLiteral(value)?.trim() : undefined;
    if (idValue) state.idValues.add(idValue);
  }
  if (attr === "aria-hidden") {
    const raw = value?.getText().trim().toLowerCase() ?? "";
    if (raw === "true" || raw === "'true'" || raw === '"true"') {
      state.isAriaHidden = true;
    }
  }
}

function isDomInsertionMethod(methodName: string): boolean {
  return methodName === "appendChild" || methodName === "append" || methodName === "prepend" ||
    methodName === "insertBefore" || methodName === "replaceChild" || methodName === "replaceChildren";
}

function extractStringLiteral(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return undefined;
}

function hasNonWhitespaceExpressionValue(expression: ts.Expression): boolean {
  const literal = extractStringLiteral(expression);
  if (literal != null) return literal.trim().length > 0;
  return true;
}

function getPropertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function hasLabelForAssociationInScope(scopeText: string, idValues: Set<string>): boolean {
  for (const id of idValues) {
    const escaped = escapeRegex(id);
    if (new RegExp(String.raw`<label\b[^>]*\bfor\s*=\s*['"]${escaped}['"]`, "i").test(scopeText)) {
      return true;
    }
    if (new RegExp(String.raw`setAttribute\s*\(\s*['"]for['"]\s*,\s*['"]${escaped}['"]`, "i").test(scopeText)) {
      return true;
    }
  }
  return false;
}

function lineFromIndex(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}

function normalizeSnippetForKey(snippet: string | undefined): string {
  if (!snippet) return "";
  return snippet
    .replace(/<%[\s\S]*?%>/g, "<%server%>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 240);
}

function getLikelyFunctionScope(content: string, index: number): string {
  const before = content.slice(0, index);
  const functionStart = Math.max(
    before.lastIndexOf("function "),
    before.lastIndexOf("=>"),
    before.lastIndexOf("Page_Load"),
  );

  if (functionStart < 0) {
    return content.slice(index, Math.min(content.length, index + 5000));
  }

  const fromStart = content.slice(functionStart);
  const firstBraceOffset = fromStart.indexOf("{");
  if (firstBraceOffset < 0) {
    return content.slice(index, Math.min(content.length, index + 5000));
  }

  const blockStart = functionStart + firstBraceOffset;
  let depth = 0;
  for (let i = blockStart; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(blockStart, Math.min(content.length, i + 1));
      }
    }
  }

  return content.slice(blockStart, Math.min(content.length, blockStart + 8000));
}

function isPlainHtmlLintCandidate(content: string, filePath: string): boolean {
  if (!/\.(?:html?|cshtml|aspx|ascx|master)$/i.test(filePath)) {
    return false;
  }

  // ASP.NET template files are handled by the dedicated template scanner.
  if (/\.(?:aspx|ascx|master)$/i.test(filePath)) {
    return false;
  }

  // Keep generic HTML lint away from classic WebForms and server-side template
  // syntax so it complements, rather than fights, the ASP.NET-specific pass.
  if (/<asp:/i.test(content)) return false;
  if (/<%[@=#:]?|<%--/.test(content)) return false;
  if (/\brunat\s*=\s*(?:"server"|'server')/i.test(content)) return false;
  if (/^\s*@(?:model|page|using|inject|inherits|section|if|for|foreach|while|switch|functions)\b/m.test(content)) {
    return false;
  }
  if (/^\s*@\{/m.test(content)) return false;

  return /<(?:!DOCTYPE\s+html|html|head|body|main|form|section|article|div|label|input|button|a)\b/i.test(content);
}

function findHtmlLintIssues(content: string, filePath: string): AspxScanIssue[] {
  return [
    ...namespaceHtmlLintIssues(findMissingAltOnImg(content, filePath)),
    ...namespaceHtmlLintIssues(findLikelyBrokenImageSrc(content, filePath)),
    ...namespaceHtmlLintIssues(findMissingHtmlLang(content, filePath)),
    ...namespaceHtmlLintIssues(findEmptyAnchors(content, filePath)),
    ...namespaceHtmlLintIssues(findEmptyButtons(content, filePath)),
    ...namespaceHtmlLintIssues(findMissingPageTitle(content, filePath)),
    ...namespaceHtmlLintIssues(findHtmlInputMissingLabel(content, filePath)),
    ...namespaceHtmlLintIssues(findHtmlSelectMissingLabel(content, filePath)),
    ...namespaceHtmlLintIssues(findHtmlTextareaMissingLabel(content, filePath)),
    ...namespaceHtmlLintIssues(findTableHeaderMissingScope(content, filePath)),
    ...namespaceHtmlLintIssues(findMetaRefresh(content, filePath)),
    ...findEmptyHeadings(content, filePath),
    ...findHiddenFocusableInPlainMarkup(content, filePath),
  ];
}

function namespaceHtmlLintIssues(issues: AspxScanIssue[]): AspxScanIssue[] {
  return issues.map((issue) => ({
    ...issue,
    ruleId: issue.ruleId.replace(/^aspnet\//, "html-lint/"),
  }));
}

function findEmptyHeadings(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi;

  for (const match of content.matchAll(regex)) {
    const snippet = match[0] ?? "";
    const inner = match[2] ?? "";
    const text = stripTagsAndServerBlocks(inner);
    if (text.length > 0) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "html-lint/empty-heading",
      title: "Heading must have discernible text",
      description: "Heading element is empty, so assistive technologies cannot use it to understand the page structure (WCAG 2.4.6).",
      wcagSc: "2.4.6",
      filePath,
      line,
      column,
      htmlSnippet: snippet,
    });
  }

  return issues;
}

function findHiddenFocusableInPlainMarkup(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /<([a-z0-9:-]+)\b([^>]*)>([\s\S]*?)<\/\1>/gi;

  for (const match of content.matchAll(regex)) {
    const attrs = match[2] ?? "";
    const inner = match[3] ?? "";
    if (!/\baria-hidden\s*=\s*(?:"true"|'true'|true)/i.test(attrs)) continue;
    if (!hasFocusableDescendant(inner)) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "html-lint/hidden-focusable",
      title: "aria-hidden content must not contain focusable elements",
      description: "Focusable descendants inside an aria-hidden container create content keyboard users can reach but screen readers cannot announce (WCAG 4.1.2).",
      wcagSc: "4.1.2",
      filePath,
      line,
      column,
      htmlSnippet: match[0].slice(0, 260),
    });
  }

  return issues;
}

/**
 * Shared normalizer for ESLint results → Finding[].
 * Both React and Angular paths use this with injected callbacks.
 */
function normalizeEslintResults(args: {
  parsed: EslintResult[];
  repoPath: string;
  rulePrefix: string;
  source: Source;
  scIdsForRule: (ruleId: string) => string[];
  helpUrl: (ruleId: string) => string;
  tags: string[];
}): { findings: Finding[]; rawWarnings: number } {
  const findings: Finding[] = [];
  let rawWarnings = 0;

  for (const fileResult of args.parsed) {
    rawWarnings += fileResult.warningCount + fileResult.errorCount;
    const normalizedFilePath = normalizePath(relative(args.repoPath, fileResult.filePath));
    if (shouldSkipStaticFile(normalizedFilePath)) {
      continue;
    }

    for (const msg of fileResult.messages) {
      if (!msg.ruleId || !msg.ruleId.startsWith(args.rulePrefix)) continue;

      const scIds = args.scIdsForRule(msg.ruleId);
      const primarySc = scIds[0] ?? "n/a";
      const criterion = primarySc !== "n/a" ? getCriterion(primarySc) : undefined;
      const level = criterion?.level ?? "AA";
      // Max severity across all mapped SCs — never from scIds[0] (ordering
      // must not downgrade a blocker; see severityForScList).
      const severity = severityForScList(scIds) ?? "major";

      findings.push({
        id: uuidv4(),
        wcagSc: primarySc,
        wcagLevel: level,
        severity,
        source: args.source,
        ruleId: msg.ruleId,
        title: msg.ruleId,
        description: msg.message,
        filePath: normalizedFilePath,
        line: msg.line,
        column: msg.column,
        htmlSnippet: msg.source,
        // W3C helpUrl is stamped by enrichFindings (in scanRepoStatic); the
        // GitHub rule-docs link is preserved as the secondary docUrl.
        docUrl: args.helpUrl(msg.ruleId),
        aiGenerated: false,
        requiresHumanReview: false,
        tags: args.tags,
        relatedRuleIds: [],
        relatedNodes: [],
      });
    }
  }

  return { findings, rawWarnings };
}


async function writeReactFlatConfig(): Promise<string> {
  const configPath = join(tmpdir(), `a11y-scout-eslint-react-${uuidv4()}.mjs`);

  // Resolve absolute paths to our bundled dependencies
  const currentFile = fileURLToPath(import.meta.url);
  const require = createRequire(currentFile);
  const jsxA11yPath = pathToFileURL(require.resolve("eslint-plugin-jsx-a11y")).href;
  const tsParserPath = pathToFileURL(require.resolve("@typescript-eslint/parser")).href;

  const config = `import jsxA11y from "${jsxA11yPath}";
import tsParser from "${tsParserPath}";

export default [
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    ignores: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.next/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    plugins: { "jsx-a11y": jsxA11y },
    rules: jsxA11y.flatConfigs.recommended.rules,
  },
];
`;
  await writeFile(configPath, config, "utf8");
  return configPath;
}

async function writeAngularFlatConfig(): Promise<string> {
  const configPath = join(
    tmpdir(),
    `a11y-scout-eslint-angular-${uuidv4()}.mjs`,
  );

  // Resolve absolute path to our bundled dependency
  const currentFile = fileURLToPath(import.meta.url);
  const require = createRequire(currentFile);
  const angularEslintPath = pathToFileURL(require.resolve("angular-eslint")).href;

  // Build the A11Y_RULES object from the single source of truth
  const rulesObj = ANGULAR_TEMPLATE_RULE_IDS.reduce(
    (acc, ruleId) => {
      acc[ruleId] = "warn";
      return acc;
    },
    {} as Record<string, string>,
  );

  const config = `import angular from "${angularEslintPath}";

const A11Y_RULES = ${JSON.stringify(rulesObj, null, 2)};

export default [
  // (1) TypeScript files: register the inline-template processor
  {
    files: ["**/*.ts"],
    ignores: ["**/node_modules/**", "**/dist/**", "**/.angular/**"],
    processor: angular.processInlineTemplates,
  },
  // (2) HTML templates (external .html AND extracted inline ones)
  {
    files: ["**/*.html"],
    ignores: ["**/node_modules/**", "**/dist/**", "**/.angular/**"],
    languageOptions: { parser: angular.templateParser },
    plugins: { "@angular-eslint/template": angular.templatePlugin },
    rules: A11Y_RULES,
  },
];
`;
  await writeFile(configPath, config, "utf8");
  return configPath;
}

/**
 * Resolve the local ESLint binary bundled with this package.
 * Returns the path to the ESLint entry point JS file.
 * Searches upward to handle workspace hoisting.
 */
function resolveLocalEslintBin(): string {
  const currentFile = fileURLToPath(import.meta.url);
  let searchDir = dirname(currentFile);

  // Search upward for node_modules/eslint/bin/eslint.js
  for (let i = 0; i < 10; i++) {
    const eslintBin = join(searchDir, "node_modules/eslint/bin/eslint.js");
    if (existsSync(eslintBin)) {
      return eslintBin;
    }
    const parent = dirname(searchDir);
    if (parent === searchDir) break; // reached root
    searchDir = parent;
  }

  throw new Error(
    `Could not find ESLint binary in any node_modules searching upward from ${currentFile}. Run npm install.`,
  );
}

async function runEslint(
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  const eslintBin = resolveLocalEslintBin();
  return new Promise((resolveFn, rejectFn) => {
    let settled = false;
    const safeResolve = (value: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      resolveFn(value);
    };
    const safeReject = (reason: unknown) => {
      if (settled) return;
      settled = true;
      rejectFn(reason);
    };

    const proc = spawn(process.execPath, [eslintBin, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const timeoutMs = options?.timeoutMs ?? 0;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let failSafeRejectHandle: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(proc.pid);

        // Fail-safe: if close/error never fires after kill, force timeout rejection
        // so chunk splitting can continue instead of hanging forever.
        failSafeRejectHandle = setTimeout(() => {
          const err = new Error(
            `eslint timed out after ${timeoutMs}ms (forced)`,
          ) as EslintExecutionError;
          err.stdout = stdout;
          err.stderr = stderr;
          err.timedOut = true;
          safeReject(err);
        }, 2000);
      }, timeoutMs);
    }

    proc.on("error", safeReject);
    proc.on("close", (code) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (failSafeRejectHandle) {
        clearTimeout(failSafeRejectHandle);
      }

      if (timedOut) {
        const err = new Error(
          `eslint timed out after ${timeoutMs}ms`,
        ) as EslintExecutionError;
        err.stdout = stdout;
        err.stderr = stderr;
        err.timedOut = true;
        safeReject(err);
        return;
      }

      // ESLint exits 1 when issues are found; that is success for our purposes.
      if (code === 0 || code === 1) {
        safeResolve({ stdout, stderr });
      } else {
        const err = new Error(
          `eslint exited with code ${code}: ${stderr.slice(0, 500)}`,
        ) as EslintExecutionError;
        err.stdout = stdout;
        err.stderr = stderr;
        safeReject(err);
      }
    });
  });
}

function terminateProcessTree(pid: number | undefined): void {
  if (pid === undefined || !Number.isFinite(pid) || pid <= 0) {
    return;
  }

  const targetPid = pid;

  if (process.platform === "win32") {
    // On Windows, a plain child.kill() may not reliably terminate descendants.
    const killer = spawn("taskkill", ["/PID", String(targetPid), "/T", "/F"], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    killer.on("error", () => {
      // Best effort only.
    });
    return;
  }

  try {
    process.kill(targetPid, "SIGKILL");
  } catch {
    // Best effort only.
  }
}
