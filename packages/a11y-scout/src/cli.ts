#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import ora from "ora";
import { runScan, summarizeFindings } from "./agents/graph.js";
import { runFixer } from "./fixer/index.js";
import { createLlmProvider, getActiveProvider } from "./llm/index.js";
import { emitReports } from "./reports/emit.js";
import { buildReportDir } from "./reports/output-dir.js";
import type { ScanLevel } from "./types.js";
import type { StaticScanProgressEvent, StaticScanPhase } from "./scanners/static.js";
import { VERSION } from "./version.js";

// Auto-load .env from cwd OR the nearest ancestor directory that has one
// (so `npm run --workspace=a11y-scout cli` -- which sets cwd to the workspace
// dir -- still picks up the .env at the monorepo root). Uses Node 20.6+'s
// built-in loader; silently no-ops if Node is older or no .env is present.
function tryLoadEnv(path: string): void {
  if (!existsSync(path)) return;
  const loadEnvFile = (process as unknown as {
    loadEnvFile?: (p: string) => void;
  }).loadEnvFile;
  if (typeof loadEnvFile === "function") {
    try {
      loadEnvFile(path);
    } catch {
      /* ignore */
    }
  }
}
function loadNearestEnv(startDir: string): void {
  // Walk up at most 6 levels (covers root + most monorepo nesting).
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) {
      tryLoadEnv(candidate);
      tryLoadEnv(resolve(dir, ".env.local"));
      return;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
}
loadNearestEnv(process.cwd());

function parseLevel(value: string): ScanLevel {
  const v = value.toUpperCase();
  if (v === "A" || v === "AA" || v === "AAA") return v;
  throw new Error(`Invalid --level: ${value}. Must be A, AA, or AAA.`);
}

function printSummary(state: Awaited<ReturnType<typeof runScan>>) {
  const s = summarizeFindings(state);
  console.log("");
  console.log(chalk.bold("Summary"));
  console.log(`  ${chalk.red.bold(s.blockers)} blocker(s)`);
  console.log(`  ${chalk.hex("#ea580c").bold(s.severe)} severe`);
  console.log(`  ${chalk.yellow.bold(s.major)} major`);
  console.log(`  ${chalk.green.bold(s.minor)} minor`);
  console.log(`  ${chalk.blue.bold(s.review)} AI-flagged review item(s)`);
  console.log(`  ${chalk.green.bold(s.passes)} passed check(s)`);
  console.log(`  ${chalk.dim(s.inapplicable)} not applicable`);
  const providerLabel = state.meta.llmProvider
    ? state.meta.llmProvider.toUpperCase()
    : "LLM";
  const mockSuffix = state.meta.llmMockMode ? " (mock)" : "";
  console.log(
    chalk.dim(
      `  duration: ${(s.durationMs / 1000).toFixed(1)}s  •  ${providerLabel} cost: $${s.costUsd.toFixed(4)}${mockSuffix}`,
    ),
  );
}

const STATIC_CHECKLIST_PHASES: StaticScanPhase[] = [
  "detect-stack",
  "aspnet:js-a11y",
  "aspnet:template-files",
  "aspnet:html-lint",
  "aspnet:dom-injection",
  "aspnet:css-patterns",
  "aspnet:code-behind",
  "react:eslint",
  "angular:eslint",
];

function formatStaticChecklist(
  phaseState: Map<StaticScanPhase, "pending" | "running" | "done" | "failed" | "skipped">,
  active?: StaticScanProgressEvent,
): string {
  const total = STATIC_CHECKLIST_PHASES.length;
  const completed = Array.from(phaseState.values()).filter(
    (state) => state === "done" || state === "skipped",
  ).length;

  const items = STATIC_CHECKLIST_PHASES.map((phase) => {
    const state = phaseState.get(phase) ?? "pending";
    const label = phase.replace(/:/g, " ");
    if (state === "done") return `[x] ${label}`;
    if (state === "skipped") return `[-] ${label}`;
    if (state === "failed") return `[!] ${label}`;
    if (state === "running") {
      if (active?.processedFiles && active.totalFiles) {
        return `[>] ${label} ${active.processedFiles}/${active.totalFiles}`;
      }
      return `[>] ${label}`;
    }
    return `[ ] ${label}`;
  });

  return `${completed}/${total} ${items.join(" · ")}`;
}

async function runUrlScan(opts: {
  url: string;
  out: string;
  level: ScanLevel;
  authState?: string;
  captureAuth?: boolean;
  headed?: boolean;
  crawl?: boolean;
  maxPages?: number;
  maxDepth?: number;
  include?: string;
  exclude?: string;
  ignoreHttpsErrors?: boolean;
  waitUntil?: string;
  extraWait?: number;
  keyboard?: boolean;
  focusChecks?: boolean;
  noFocusIndicatorScreenshots?: boolean;
  aiFix?: boolean;
}) {
  const llm = createLlmProvider();
  const providerDesc = llm.describe();
  if (llm.isMock) {
    console.log(
      chalk.yellow(
        `LLM provider (${providerDesc.provider}) running in mock mode -- AAA semantic findings will be stubs.`,
      ),
    );
    console.log(
      chalk.dim(
        "  Configure provider credentials to enable real Claude Sonnet 4 reasoning. See .env.example for details.",
      ),
    );
  }

  const isCrawl = Boolean(opts.crawl);
  const spinner = ora({
    text: isCrawl
      ? `Crawling ${chalk.cyan(opts.url)} (max ${opts.maxPages ?? 10} pages, depth ${opts.maxDepth ?? 2}) at level ${opts.level}...`
      : `Scanning ${chalk.cyan(opts.url)} at level ${opts.level}...`,
    color: "cyan",
  }).start();

  try {
    const state = await runScan({
      mode: "url",
      target: opts.url,
      level: opts.level,
      authStatePath: opts.authState,
      captureAuth: opts.captureAuth,
      headed: opts.headed,
      ignoreHttpsErrors: opts.ignoreHttpsErrors,
      waitUntil: opts.waitUntil as "networkidle" | "load" | "domcontentloaded" | undefined,
      extraWaitMs: opts.extraWait ?? 0,
      keyboard: opts.keyboard,
      focusChecks: opts.focusChecks,
      noFocusIndicatorScreenshots: opts.noFocusIndicatorScreenshots,
      aiFix: opts.aiFix,
      crawl: {
        enabled: isCrawl,
        maxPages: opts.maxPages ?? 10,
        maxDepth: opts.maxDepth ?? 2,
        includePattern: opts.include,
        excludePattern: opts.exclude,
      },
      onCrawlProgress: (p) => {
        spinner.text = `Crawled ${p.pagesDone}/${p.pagesTotal}: ${chalk.cyan(p.url)} (+${p.findingsThisPage} findings)`;
      },
      llm,
    });
    if (isCrawl) {
      spinner.succeed(
        `Crawled ${state.meta.pagesScanned.length} page(s) of ${chalk.cyan(opts.url)}`,
      );
    } else {
      spinner.succeed(`Scanned ${chalk.cyan(opts.url)}`);
    }

    const outDir = buildReportDir(opts.out, opts.url, "url");
    const reports = await emitReports(state, outDir);

    printSummary(state);
    if (isCrawl && state.meta.pagesScanned.length > 0) {
      console.log("");
      console.log(chalk.bold("Pages scanned"));
      for (const u of state.meta.pagesScanned) {
        console.log(`  ${chalk.dim("•")} ${u}`);
      }
      if (state.meta.pagesSkipped.length > 0) {
        console.log(chalk.dim(`  (${state.meta.pagesSkipped.length} skipped; rerun with DEBUG=1 to see why)`));
      }
    }
    console.log("");
    console.log(chalk.bold("Reports"));
    console.log(`  HTML:     ${chalk.underline(reports.htmlPath)}`);
    console.log(`  Markdown: ${chalk.underline(reports.mdPath)}`);
    console.log(`  JSON:     ${chalk.underline(reports.jsonPath)}`);

    const s = summarizeFindings(state);
    process.exitCode = s.blockers > 0 ? 1 : 0;
  } catch (err) {
    spinner.fail(`Scan failed: ${(err as Error).message}`);
    if (process.env.DEBUG) console.error(err);
    process.exitCode = 2;
  }
}

async function runRepoScan(opts: {
  path: string;
  out: string;
  level: ScanLevel;
}) {
  const repo = resolve(opts.path);
  if (!existsSync(repo)) {
    console.error(chalk.red(`Path does not exist: ${repo}`));
    process.exitCode = 2;
    return;
  }

  const llm = createLlmProvider();
  const spinner = ora({
    text: `Scanning repo ${chalk.cyan(repo)} (static checks)...`,
    color: "cyan",
  }).start();
  const phaseState = new Map<StaticScanPhase, "pending" | "running" | "done" | "failed" | "skipped">();
  let lastProgress: StaticScanProgressEvent | undefined;

  try {
    const state = await runScan({
      mode: "repo",
      target: repo,
      level: opts.level,
      llm,
      onStaticProgress: (event) => {
        lastProgress = event;
        if (event.state === "start") {
          phaseState.set(event.phase, "running");
        } else if (event.state === "done") {
          phaseState.set(event.phase, "done");
        } else if (event.state === "failed") {
          phaseState.set(event.phase, "failed");
        } else if (event.state === "skipped") {
          phaseState.set(event.phase, "skipped");
        }

        const checklist = formatStaticChecklist(phaseState, lastProgress);
        if (event.state === "progress" && event.currentPath) {
          spinner.text = `Scanning repo ${chalk.cyan(repo)} (static checks) ${checklist} | ${event.currentPath}`;
          return;
        }

        const detail = event.message ?? event.phase;
        spinner.text = `Scanning repo ${chalk.cyan(repo)} (static checks) ${checklist} | ${detail}`;
      },
    });
    spinner.succeed(`Scanned ${chalk.cyan(repo)}`);

    const outDir = buildReportDir(opts.out, repo, "repo");
    const reports = await emitReports(state, outDir);

    printSummary(state);
    console.log("");
    console.log(chalk.bold("Reports"));
    console.log(`  HTML:     ${chalk.underline(reports.htmlPath)}`);
    console.log(`  Markdown: ${chalk.underline(reports.mdPath)}`);
    console.log(`  JSON:     ${chalk.underline(reports.jsonPath)}`);

    const s = summarizeFindings(state);
    process.exitCode = s.blockers > 0 ? 1 : 0;
  } catch (err) {
    spinner.fail(`Scan failed: ${(err as Error).message}`);
    if (process.env.DEBUG) console.error(err);
    process.exitCode = 2;
  }
}

const program = new Command();

program
  .name("a11y-scout")
  .description("AI-powered WCAG accessibility scanner (Hyland HAIP-powered)")
  .version(VERSION);

program
  .command("scan-url <url>")
  .description(
    "Scan a live URL for WCAG accessibility issues. Default: single page. Use --crawl to follow same-origin links.",
  )
  .option("-o, --out <dir>", "Output directory for reports", "./a11y-reports")
  .option(
    "-l, --level <level>",
    "WCAG level: A | AA | AAA (default AA; AAA enables AI-flagged review items)",
    "AA",
  )
  .option(
    "--headed",
    "Show browser during scan (default: headless). Useful for debugging.",
  )
  .option(
    "--crawl",
    "Crawl same-origin links from the starting URL. Off by default (single page only).",
  )
  .option(
    "--max-pages <n>",
    "Max pages to visit during a crawl (default 10)",
    (v) => Number.parseInt(v, 10),
  )
  .option(
    "--max-depth <n>",
    "Max link-depth from the starting URL during a crawl (default 2)",
    (v) => Number.parseInt(v, 10),
  )
  .option(
    "--include <regex>",
    "Only crawl URLs matching this regex (applied after same-origin filter)",
  )
  .option(
    "--exclude <regex>",
    "Skip URLs matching this regex (e.g. '/(login|signup|cart)')",
  )
  .option(
    "--auth-state <path>",
    "Path to a saved Playwright storageState JSON (for authenticated pages)",
  )
  .option(
    "--capture-auth",
    "Open a real browser so you can log in once; saves auth state to --auth-state, then exits the login step",
  )
  .option(
    "--ignore-https-errors",
    "Ignore HTTPS certificate errors (useful for localhost with self-signed certs)",
  )
  .option(
    "--wait-until <strategy>",
    "Page load strategy: networkidle | load | domcontentloaded (default: load, which waits for JS-rendered content)",
    "load",
  )
  .option(
    "--extra-wait <ms>",
    "Additional wait time in milliseconds after page load before scanning (for lazy-loaded content)",
    (v) => Number.parseInt(v, 10),
  )
  .option(
    "--no-keyboard",
    "Disable keyboard trap (WCAG 2.1.2) checks (enabled by default)",
  )
  .option(
    "--no-focus-checks",
    "Disable focus-order / focus-visible checks (WCAG 2.4.3 / 2.4.7). Keyboard-trap (2.1.2) stays on. Enabled by default.",
  )
  .option(
    "--no-focus-indicator-screenshots",
    "Disable screenshot-based focus-indicator verification on single-page scans (enabled by default; always off under --crawl).",
  )
  .option(
    "--no-ai-fix",
    "Disable AI-suggested fixed HTML per finding (enabled by default when a real LLM provider is configured).",
  )
  .action(async (url: string, options) => {
    await runUrlScan({
      url,
      out: options.out,
      level: parseLevel(options.level),
      authState: options.authState,
      captureAuth: options.captureAuth,
      headed: options.headed,
      crawl: options.crawl,
      maxPages: options.maxPages,
      maxDepth: options.maxDepth,
      include: options.include,
      exclude: options.exclude,
      ignoreHttpsErrors: options.ignoreHttpsErrors,
      waitUntil: options.waitUntil,
      extraWait: options.extraWait,
      keyboard: options.keyboard,
      focusChecks: options.focusChecks,
      noFocusIndicatorScreenshots: options.focusIndicatorScreenshots === false,
      aiFix: options.aiFix,
    });
  });

program
  .command("scan-repo <path>")
  .description("Scan a source code repository for accessibility issues (V1: React/JSX)")
  .option("-o, --out <dir>", "Output directory for reports", "./a11y-reports")
  .option("-l, --level <level>", "WCAG level: A | AA | AAA", "AA")
  .action(async (path: string, options) => {
    await runRepoScan({
      path,
      out: options.out,
      level: parseLevel(options.level),
    });
  });

program
  .command("fix-repo [report-path]")
  .description(
    "Auto-fix accessibility issues using LLM. Reads findings from a report and applies safe fixes to source files.",
  )
  .option(
    "-o, --reports-dir <dir>",
    "Reports directory (default: ./a11y-reports). If [report-path] is omitted, latest report is used.",
    "./a11y-reports",
  )
  .option(
    "--confidence <levels>",
    "Only apply fixes with these confidence levels (comma-separated: high,medium,low)",
  )
  .option(
    "--severity <levels>",
    "Only fix issues with these severities (comma-separated: blocker,severe,major,minor,review)",
  )
  .option(
    "--categories <ids>",
    "Only fix specific rule IDs (comma-separated, e.g. image-alt,html-has-lang)",
  )
  .option(
    "--branch",
    "Create a new git branch (a11y-auto-fixes-YYYY-MM-DD) before applying fixes",
  )
  .option(
    "--branch-prefix <prefix>",
    "Branch name prefix (only used with --branch)",
    "a11y-auto-fixes",
  )
  .option("--commit", "Auto-commit fixes grouped by category (default: stage only, no commit)")
  .option("--dry-run", "Generate fixes but don't apply or commit them")
  .option(
    "--allow-dirty",
    "Run even if files the fixer will touch have uncommitted changes (warns instead of blocking)",
  )
  .action(async (reportPath: string | undefined, options) => {
    console.log(chalk.bold("a11y-scout fix-repo"));
    console.log("");

    const spinner = ora("Loading report...").start();

    try {
      const output = await runFixer({
        reportPath,
        reportsDir: options.reportsDir,
        confidence: options.confidence?.split(","),
        severity: options.severity?.split(","),
        categories: options.categories?.split(","),
        createBranch: options.branch,
        branchPrefix: options.branchPrefix,
        autoCommit: options.commit,
        dryRun: options.dryRun,
        allowDirty: options.allowDirty,
      });

      spinner.succeed("Fixes complete");

      const s = output.summary;
      const reportTotal = output.report.findings.length;
      console.log("");
      console.log(chalk.bold("Summary"));
      console.log(
        `  ${chalk.cyan(s.totalFindings)} / ${reportTotal} fixable findings`,
      );
      console.log(`  ${chalk.green.bold(s.fixesApplied)} fixes applied`);
      console.log(`  ${chalk.red.bold(s.fixesFailed)} fixes failed (applier)`);
      console.log(
        `  ${chalk.yellow.bold(s.fixesDeclined)} fixes declined by LLM`,
      );
      if (output.declinedFindings.length > 0) {
        const byRule: Record<string, number> = {};
        for (const f of output.declinedFindings) {
          byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
        }
        console.log("");
        console.log(
          chalk.bold(`Declined by LLM (${output.declinedFindings.length})`),
        );
        for (const [rule, count] of Object.entries(byRule).sort(
          (a, b) => b[1] - a[1],
        )) {
          console.log(`  ${chalk.yellow(rule)}: ${count}`);
        }
      }
      if (output.unsupportedFindings.length > 0) {
        const byRule: Record<string, number> = {};
        for (const f of output.unsupportedFindings) {
          byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
        }
        console.log("");
        console.log(
          chalk.bold(
            `Manual remediation required (${output.unsupportedFindings.length})`,
          ),
        );
        for (const [rule, count] of Object.entries(byRule).sort(
          (a, b) => b[1] - a[1],
        )) {
          console.log(`  ${chalk.yellow(rule)}: ${count}`);
        }
      }

      if (Object.keys(s.byCategory).length > 0) {
        console.log("");
        console.log(chalk.bold("By Category"));
        for (const [cat, count] of Object.entries(s.byCategory)) {
          console.log(`  ${cat}: ${count}`);
        }
      }

      if (Object.keys(s.byConfidence).length > 0) {
        console.log("");
        console.log(chalk.bold("By Confidence"));
        for (const [conf, count] of Object.entries(s.byConfidence)) {
          console.log(`  ${conf}: ${count}`);
        }
      }

      console.log("");
      console.log(
        chalk.dim(
          `  duration: ${(s.durationMs / 1000).toFixed(1)}s  •  LLM cost: $${s.costUsd.toFixed(4)}${output.llmProvider.isMock ? " (mock)" : ""}`,
        ),
      );

      console.log("");
      console.log(
        chalk.bold(`LLM Provider: ${chalk.cyan(getActiveProvider())}`),
      );

      if (options.dryRun) {
        console.log("");
        console.log(
          chalk.yellow(
            "DRY RUN: No changes were applied. Remove --dry-run to apply fixes.",
          ),
        );
      } else if (s.fixesApplied > 0) {
        console.log("");
        if (options.commit) {
          console.log(
            chalk.green(
              `✓ ${s.fixesApplied} fix${s.fixesApplied > 1 ? "es" : ""} committed!`,
            ),
          );
          console.log("");
          console.log("  Review commits:");
          console.log(chalk.dim("    git log --oneline -5"));
        } else {
          console.log(
            chalk.green(
              `✓ ${s.fixesApplied} fix${s.fixesApplied > 1 ? "es" : ""} staged!`,
            ),
          );
          console.log("");
          console.log("  Review staged changes:");
          console.log(chalk.dim("    git diff --staged"));
          console.log("");
          console.log("  Commit when satisfied:");
          console.log(chalk.dim('    git commit -m "fix(a11y): accessibility fixes"'));
          console.log("");
          console.log("  Or discard:");
          console.log(chalk.dim("    git restore --staged . && git checkout -- ."));
        }
      }
    } catch (err) {
      spinner.fail(`Fix failed: ${(err as Error).message}`);
      if (process.env.DEBUG) console.error(err);
      process.exitCode = 2;
    }
  });

program
  .command("doctor")
  .description("Verify the local environment (Node, LLM provider config)")
  .action(async () => {
    console.log(chalk.bold("a11y-scout doctor"));
    console.log(`  Node: ${process.version}`);
    console.log(`  Platform: ${process.platform} ${process.arch}`);
    console.log("");
    console.log(chalk.bold("LLM Provider"));
    const llm = createLlmProvider();
    const desc = llm.describe();
    console.log(`  Active: ${chalk.cyan(desc.provider)}`);
    const labelWidth = Math.max(...desc.lines.map((l) => l.label.length));
    for (const line of desc.lines) {
      const padded = line.label.padEnd(labelWidth);
      const value =
        line.hint === "warn"
          ? chalk.yellow(line.value)
          : line.hint === "ok"
            ? chalk.green(line.value)
            : line.value;
      console.log(`  ${padded}  ${value}`);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red(`Fatal: ${(err as Error).message}`));
  process.exit(2);
});
