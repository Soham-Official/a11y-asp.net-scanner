# a11y-scout Installation Guide

> For teams installing a11y-scout packages

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Installation Steps](#installation-steps)
4. [Static Code Analysis for React & Angular Development](#static-code-analysis-for-react--angular-development)
   - [Quick Start](#quick-start)
   - [Add to package.json Scripts](#add-to-packagejson-scripts-recommended)
   - [Auto-Fixing Issues with fix-repo](#auto-fixing-issues-with-fix-repo)
   - [Example Daily Workflow](#example-workflow-daily-development)
5. [Usage in Playwright Tests](#usage-in-tests)
6. [Usage in WebdriverIO Tests](#usage-in-webdriverio-tests)
7. [CI/CD Integration](#cicd-integration)
8. [Troubleshooting](#troubleshooting)

## Overview

a11y-scout is an AI-powered WCAG accessibility scanner with three primary use cases:

1. **Static Analysis (React/JSX)** — Scan your source code during development to catch accessibility issues before they reach production
2. **Runtime Testing (Playwright)** — Integrate into Playwright test suites to scan rendered pages
3. **Runtime Testing (WebdriverIO)** — Integrate into WebdriverIO test suites to scan rendered pages

The Playwright and WebdriverIO integrations share the **same detection engine** — axe-core rule selection, keyboard-trap detection, reflow, and the AI content-quality agents are identical; only the browser-rendering layer differs.

This guide covers installation from distributed `.tgz` packages for all three use cases.

## Prerequisites

### For Static Analysis (React Development)
- Node.js >= 20
- React/Next.js/JSX codebase

### For Playwright Integration
- Node.js >= 20
- Existing Playwright test project (`@playwright/test` >= 1.40.0)
- Access to Hyland AI Platform (HAIP) API key (optional for axe-only scans; required to enable the AI content-quality checks at A / AA / AAA — these flag candidates for human review against semantic SCs that axe cannot evaluate)

### For WebdriverIO Integration
- Node.js >= 20
- Existing WebdriverIO test project (`webdriverio` >= 8)
- Access to Hyland AI Platform (HAIP) API key (same optional/AI-check semantics as Playwright above)

## Installation Steps

### Step 1: Download Packages

Navigate to the SharePoint distribution folder and **download** the package files you need to your local file system:
- `a11y-scout-0.3.0.tgz` — Core engine (required for all use cases)
- `a11y-scout-playwright-0.3.0.tgz` — Playwright fixture
- `a11y-scout-webdriverio-0.3.0.tgz` — WebdriverIO helper

> **Note:** Install from the downloaded local files — installing directly from a SharePoint
> URL (`npm install https://sharepoint.url/...`) does **not** work.

### Step 2: Install in Your Project

**For Playwright projects:**

```bash
# Navigate to your Playwright test project
cd /path/to/your-playwright-tests

# Install both packages from the downloaded local files
npm install /path/to/a11y-scout-0.3.0.tgz
npm install /path/to/a11y-scout-playwright-0.3.0.tgz
```

**For WebdriverIO projects:**

```bash
# Navigate to your WebdriverIO test project
cd /path/to/your-webdriverio-tests

# Install both packages from the downloaded local files
npm install /path/to/a11y-scout-0.3.0.tgz
npm install /path/to/a11y-scout-webdriverio-0.3.0.tgz
```

### Step 3: Environment Setup for LLM Inferences

a11y-scout supports multiple LLM providers for AI-powered accessibility checks. Configuration is done via a `.env` file.

#### Where to Place the .env File

Create a `.env` file in **the directory where you run the `a11y-scout` command** (typically your project root). The CLI automatically searches for `.env` files up to 6 directory levels, so it can be placed:

- **In your project root** (recommended)
- **In any parent directory** (useful for monorepos)

```bash
# Example project structure
my-project/
├── .env                    ← Place your .env file here
├── src/
├── tests/
└── package.json
```

#### LLM Provider Configuration

a11y-scout auto-detects the LLM provider based on environment variables. You can use **either HAIP or AWS Bedrock** — both route entirely through Hyland-controlled infrastructure with **no external data egress**. Choose one of the following configurations:

##### Option 1: HAIP

All LLM calls go through the Hyland AI Platform Model Gateway — no external data egress.

```bash
# .env file

# === REQUIRED ===
HAIP_API_KEY=your-haip-key-here   # the only value you must set

# === OPTIONAL (sensible defaults shown) ===
HAIP_BASE_URL=https://ai-platform-public.api.ai.dev.app.hyland.com  # public dev endpoint
HAIP_ENV=dev                      # dev | staging | prod | prod-eu | prod-au (V1 supports dev)
HAIP_USER_ID=a11y-scout-service   # identifier sent in HAIP audit logs
HAIP_APP_KEY=a11y-scout           # app key for usage reporting
# HAIP_ENVIRONMENT_ID=            # only needed if your team enforces env scoping

# Optional: force the provider explicitly (otherwise auto-detected from HAIP_API_KEY)
A11Y_LLM_PROVIDER=haip

# Optional: hard cost cap per scan (default: $1.00; scan aborts if exceeded)
A11Y_MAX_COST_USD=1.00
```

> **Only `HAIP_API_KEY` is required.** All other values have working defaults
> (see `distribution/.env.example`). Set `HAIP_BASE_URL`/`HAIP_ENV` only when
> targeting an environment other than dev.

**Where to get HAIP credentials:**
- See the HAIP access wiki: https://hyland.atlassian.net/wiki/x/boeVsw
- Or contact your team's AI Platform administrator

##### Option 2: AWS Bedrock

Use AWS SSO authentication to reach Claude through Bedrock. All calls stay within Hyland-controlled AWS infrastructure — no external data egress.

```bash
# .env file
A11Y_LLM_PROVIDER=bedrock

# Or let it auto-detect via AWS profile
AWS_PROFILE=your-aws-profile

# Optional: maximum cost per scan
A11Y_MAX_COST_USD=1.00
```

**Prerequisites:**
- AWS credentials configured (`~/.aws/credentials`) or an active SSO session
- Bedrock access in your AWS account — see the access wiki: https://hyland.atlassian.net/wiki/x/lgIy5g
- Model access for the defaults: Claude Sonnet 4.5 (reasoner) and Claude 3.5 Haiku (cheap classifier). Override with `HAIP_MODEL_REASONER` / `HAIP_MODEL_CHEAP` if needed.

##### Option 3: Mock Mode (Testing/Offline)

Use this for CI/CD, offline development, or when LLM credentials are not available.

```bash
# .env file
A11Y_HAIP_MOCK=1
```

**Behavior in mock mode:**
- ✅ **axe-core, keyboard, and reflow checks**: run normally at A, AA, and AAA — produce real deterministic violations with no LLM required
- ⏭️ **A/AA content-quality LLM checks**: skipped entirely (deterministic CI behavior)
- ⏭️ **AAA semantic LLM checks**: emit stub findings tagged `__mock__` (not useful for review)

#### Provider Detection Priority

The scanner selects providers in this order:

1. **Explicit `A11Y_LLM_PROVIDER`** environment variable (`haip`, `bedrock`, or `mock`)
2. **Auto-detect Bedrock** if `CLAUDE_CODE_USE_BEDROCK=1` or `AWS_PROFILE` is set
3. **Auto-detect HAIP** if `HAIP_API_KEY` is set
4. **Force mock** if `A11Y_HAIP_MOCK=1`
5. **Default to HAIP** — which transparently falls back to mock mode when no `HAIP_API_KEY` is present

#### When Do You Need LLM Configuration?

| Scan Level | LLM Required? | Works Without Config? |
|------------|---------------|----------------------|
| **A** | Optional | ✅ Yes (axe-core only); add LLM to also flag alt-text quality, sensory-only instructions, undescriptive page titles, generic link text, label-in-name mismatches, unhelpful error messages, missing form labels |
| **AA** | Optional | ✅ Yes (axe-core only); add LLM to also flag everything from A plus undescriptive headings/labels (2.4.6), missing/wrong `autocomplete` (1.3.5), language-of-parts (3.1.2), error suggestions (3.3.3) |
| **AAA** | Yes | ⚠️ Without an LLM, AAA-only semantic findings (link purpose alone, reading level, jargon, abbreviations, section headings, help) degrade to stubs. axe-core AAA rules still run. |

**Summary:** LLM configuration is **optional but recommended at every level**. Without it you get axe-core, keyboard, and reflow checks for A/AA/AAA. With it you additionally get LLM-flagged review candidates for the semantic SCs above. Every AI finding is `requiresHumanReview: true` — the tool never auto-claims conformance.

#### Verifying Your Configuration

After setting up your `.env` file, verify the provider detection:

```bash
# Run the doctor command to check configuration
npx a11y-scout doctor
# Prints the active provider, e.g. "Active: haip" (or "bedrock" / "mock"),
# plus its environment, models, and cost cap.

# Or run a quick scan — the summary footer reports the provider and cost,
# e.g. "HAIP cost: $0.0012" (or "(mock)" when no LLM is configured)
npx a11y-scout scan-url https://example.com --level AA
```

#### Example .env Files

**AWS Bedrock:**
```bash
# Copy from distribution/.env.example
AWS_PROFILE=default
A11Y_MAX_COST_USD=5.00
```

**HAIP:**
```bash
# Copy from distribution/.env.example
HAIP_API_KEY=hap_abc123...      # required
HAIP_USER_ID=user@company.com   # optional — for audit attribution
A11Y_MAX_COST_USD=1.00
```

**CI/CD (Mock Mode):**
```bash
# Copy from distribution/.env.example
A11Y_HAIP_MOCK=1
```

---

## Static Code Analysis for React & Angular Development

**Use Case:** Scan your React/JSX or Angular codebase during development to catch accessibility issues before committing code. This mode analyzes source files statically using ESLint rules — no browser required.

### Installation for Static Analysis Only

If you only need static analysis (no Playwright integration), install just the core package from the downloaded local file:

```bash
npm install /path/to/a11y-scout-0.3.0.tgz
```

### Quick Start

Run directly with `npx`:

```bash
# Scan your src directory
npx a11y-scout scan-repo ./src

# Scan entire project
npx a11y-scout scan-repo .

# Scan with specific WCAG level
npx a11y-scout scan-repo ./src --level AA

# Custom output directory
npx a11y-scout scan-repo ./src --out ./accessibility-reports
```

### Add to package.json Scripts (Recommended)

Add convenience scripts to your `package.json` for easy access:

```json
{
  "scripts": {
    "a11y": "a11y-scout scan-repo ./src",
    "a11y:full": "a11y-scout scan-repo . --level AAA",
    "a11y:check": "a11y-scout scan-repo ./src && echo '✓ Accessibility check passed'",
    "precommit": "npm run a11y"
  }
}
```

Then run:

```bash
# Quick scan during development
npm run a11y

# Full project scan
npm run a11y:full

# In pre-commit hook
npm run precommit
```

### What Gets Scanned

The static scanner auto-detects your framework from `package.json` and analyzes:
- **React / Next / JSX:** all `.js`, `.jsx`, `.ts`, `.tsx` files via `eslint-plugin-jsx-a11y`
- **Angular:** external `.html` templates and inline `template:` strings in `*.component.ts` via `@angular-eslint/template`
- Automatically excludes: `node_modules/`, `dist/`, `build/`, `.next/`
- ESLint rule IDs are mapped to WCAG success criteria

**Common issues detected:**
- Missing `alt` attributes on images
- Missing form labels
- Invalid ARIA attributes
- Non-interactive elements with click handlers
- Keyboard accessibility issues
- Semantic HTML problems


### Understanding Scan Results

The static scan produces three report formats in `./a11y-reports/`:

1. **HTML Report** (`report.html`) — Visual report with severity-coded findings
2. **Markdown Report** (`report.md`) — Text summary for PRs/commits
3. **JSON Report** (`report.json`) — Machine-readable for automation

**Exit codes:**
- `0` — No blockers found (safe to commit)
- `1` — Blockers found (blocks commit/CI)
- `2` — Scan failed (infrastructure error)

### Auto-Fixing Issues with `fix-repo`

After a `scan-repo` run, the `fix-repo` command reads the latest JSON report and applies
**safe, mechanical fixes** directly to your React/JSX or Angular source files using an LLM
(missing `alt`, missing `lang`, empty buttons/links, missing labels, iframe titles, etc.).
It requires an LLM provider — configure HAIP or AWS Bedrock (see
[Step 3](#step-3-environment-setup-for-llm-inferences)); it does not run in mock mode.

> **Prerequisite:** Run `scan-repo` first so a report exists in `./a11y-reports`.
> `fix-repo` uses the latest report unless you pass an explicit `[report-path]`.

**Recommended workflow — preview first, then apply:**

```bash
# 1. Scan your source to generate a report
npx a11y-scout scan-repo ./src --level AA

# 2. Preview the fixes without touching any files (dry run)
npx a11y-scout fix-repo --dry-run

# 3. Preview only the high-confidence fixes
npx a11y-scout fix-repo --dry-run --confidence high

# 4. Apply high-confidence fixes to your working tree (stages changes, no commit)
npx a11y-scout fix-repo --confidence high

# 5. Review the staged diff, then commit yourself
git diff --staged
git commit -m "fix(a11y): apply high-confidence accessibility fixes"
```

By default `fix-repo` **stages** the changed files without committing, so you stay in
control of the final diff. It refuses to run if the files it would touch have uncommitted
changes — pass `--allow-dirty` to override (warns instead of blocking).

**Common flags:**

| Flag | Description |
|------|-------------|
| `[report-path]` | Optional path to a specific report. If omitted, the latest report in `--reports-dir` is used. |
| `-o, --reports-dir <dir>` | Reports directory (default: `./a11y-reports`). |
| `--confidence <levels>` | Only apply fixes at these confidence levels — comma-separated `high,medium,low`. |
| `--severity <levels>` | Only fix these severities — comma-separated `blocker,severe,major,minor,review`. |
| `--categories <ids>` | Only fix specific rule IDs — comma-separated, e.g. `image-alt,html-has-lang`. |
| `--branch` | Create a new git branch (`a11y-auto-fixes-YYYY-MM-DD`) before applying fixes. |
| `--branch-prefix <prefix>` | Branch name prefix, used with `--branch` (default: `a11y-auto-fixes`). |
| `--commit` | Auto-commit fixes grouped by category (default: stage only). |
| `--dry-run` | Generate fixes but don't apply or commit them. |
| `--allow-dirty` | Run even if target files have uncommitted changes (warns instead of blocking). |

**Fully automated (branch + commit):**

```bash
# Create a dedicated branch and auto-commit fixes grouped by category
npx a11y-scout fix-repo --branch --commit --confidence high
```

> **Always review auto-generated fixes.** `fix-repo` handles mechanical issues only;
> semantic fixes (meaningful alt text, descriptive link purpose, etc.) still need a human.

### Example Workflow: Daily Development

```bash
# During development: scan your components as you work
npm run a11y

# Before commit: review the HTML report
open a11y-reports/latest/report.html

# Fix issues, then commit
git add .
git commit -m "feat(checkout): add payment form"
# Pre-commit hook runs automatically
```

### Limitations of Static Analysis

Static scanning **cannot detect:**
- Runtime/dynamic content issues
- Color contrast problems (requires rendered pixels)
- Focus management in complex interactions
- Issues in conditionally rendered components
- Screen reader announcement problems

**Recommendation:** Use **both** static analysis (during development) and runtime testing (in Playwright or WebdriverIO tests) for comprehensive coverage.

---

## Usage in Tests

> **Breaking change in 0.3.0.** The single-call `a11y.scan()` API has been **replaced**
> by a two-call API that accumulates findings across multiple pages into a single
> consolidated report:
>
> - `a11y.scanPage()` scans the current page and adds it to a worker-scoped accumulator.
> - `a11y.generateReport()` emits **one** consolidated HTML/Markdown/JSON report for
>   every page scanned in the worker.
>
> There is **no `scan()` shim** — migration is a small rename. See
> [Migrating from 0.2.x](#migrating-from-02x) below.

### Basic Example

```typescript
// tests/accessibility.spec.ts
import { test, expect } from "@a11y-scout/playwright";

test("home page", async ({ page, a11y }) => {
  await page.goto("https://your-app.com");
  await a11y.scanPage({ level: "AA" }); // fails the test if this page has a blocker
});

test("checkout page", async ({ page, a11y }) => {
  await page.goto("https://your-app.com/checkout");
  await a11y.scanPage({ level: "AA" });
});

test.afterAll(async ({ a11y }) => {
  // Emits ONE consolidated report covering both pages above.
  // Optional — worker teardown will auto-finalize if you skip this.
  await a11y.generateReport();
});
```

You can also scan several pages back-to-back inside a single test:

```typescript
test("login flow", async ({ page, a11y }) => {
  await page.goto("https://your-app.com/login");
  await a11y.scanPage();

  await page.click("text=Sign in");
  await page.waitForURL("**/dashboard");
  await a11y.scanPage();
});
```

> **Auto-finalize:** If a test calls `scanPage()` but no test calls `generateReport()`,
> the worker teardown automatically writes the consolidated report to `./a11y-reports/`.
> The auto-finalize path does **not** attach the HTML to a Playwright test (there is no
> `TestInfo` at worker scope) and does **not** throw on accumulated blockers. Call
> `generateReport()` explicitly to attach the HTML and surface blockers as a test failure.

### Advanced Example

```typescript
import { test, expect } from "@a11y-scout/playwright";
import { summarizeFindings } from "a11y-scout";

test("checkout flow accessibility", async ({ page, a11y }) => {
  await page.goto("https://your-app.com/checkout");

  // Scan with custom options (defer page-level failure to generateReport)
  await a11y.scanPage({
    level: "AA",                      // A | AA | AAA — locked on first call in worker
    failOnBlockers: false,            // don't fail on THIS page; check accumulated state later
    exclude: [".third-party-widget"], // skip external widgets
    include: "main",                  // only scan main content
  });

  // Emit the consolidated report and inspect it
  const { state, reportPaths } = await a11y.generateReport();
  const summary = summarizeFindings(state);
  console.log(`Blockers: ${summary.blockers}`);
  console.log(`Severe: ${summary.severe}`);
  console.log(`Major: ${summary.major}`);
  console.log(`Report: ${reportPaths.html}`);
});
```

### Authenticated Page Testing

```typescript
test("authenticated dashboard scan", async ({ page, a11y }) => {
  // Login flow
  await page.goto("https://your-app.com/login");
  await page.fill("#username", "test@example.com");
  await page.fill("#password", "password");
  await page.click("button[type=submit]");

  // Wait for navigation
  await page.waitForURL("**/dashboard");

  // Scan the authenticated page
  await a11y.scanPage({ level: "AA" });
  await a11y.generateReport();
});
```

### Collecting Results Without Failing

```typescript
import { summarizeFindings } from "a11y-scout";

test("collect accessibility metrics", async ({ page, a11y }) => {
  await page.goto("https://your-app.com");

  // Don't fail on blockers — just collect findings
  await a11y.scanPage({ level: "AA", failOnBlockers: false });
  const { state } = await a11y.generateReport({ failOnBlockers: false });

  // Custom assertions
  expect(summarizeFindings(state).blockers).toBeLessThan(5);
  expect(state.findings).toHaveLength(0);
});
```

### Migrating from 0.2.x

| 0.2.x                                             | 0.3.0                                                    |
| ------------------------------------------------- | -------------------------------------------------------- |
| `const result = await a11y.scan({ level: "AA" })` | `await a11y.scanPage({ level: "AA" })`                   |
| One report file per `scan()` call                 | One consolidated report per worker                       |
| `result.reportPaths`                              | `(await a11y.generateReport()).reportPaths`              |
| `result.state`                                    | `(await a11y.generateReport()).state`                    |
| `failOnBlockers: true` (default)                  | Same — per-page in `scanPage`, and in `generateReport`   |

If a test only ever scans one page and you don't need the consolidated view, just call
`generateReport()` at the end of that one test.

### Page filter in the HTML report

When a report covers more than one page, the HTML report includes a sticky
**"Filter by page"** dropdown at the top that scopes every section (severity summary
cards, WCAG-summary numbers, tab counters, and every finding card) to a single page.
Selecting **"All pages"** restores the full view.

## Scan Options

### `scanPage` options

```typescript
interface ScanPageOptions {
  level?: "A" | "AA" | "AAA";       // WCAG conformance level (default: "AA"); locked on first call in worker
  include?: string;                  // CSS selector to limit scan scope
  exclude?: string[];                // CSS selectors to skip
  failOnBlockers?: boolean;          // Throw if THIS page has a blocker (default: true)
  maxCostUsd?: number;               // Override cumulative LLM cost limit (shared across worker; first call wins)
  keyboard?: boolean;                // Run keyboard-trap checks, WCAG 2.1.2 (default: true)
  focusChecks?: boolean;             // Run focus-order/focus-visible checks, WCAG 2.4.3/2.4.7 (default: true)
  noFocusIndicatorScreenshots?: boolean; // Disable screenshot-based focus-indicator verification (default: false)
  aiFix?: boolean;                   // Include AI-suggested fixed HTML per finding (default: true when a real LLM is configured)
  waitForNetworkIdle?: boolean;      // Best-effort network-idle wait before scanning (default: true)
  extraWaitMs?: number;              // Additional wait (ms) after load for lazy-loaded content
  llm?: LlmProvider;                 // Custom LLM provider; honored only on the FIRST scanPage call in a worker
}
```

### `generateReport` options

```typescript
interface GenerateReportOptions {
  outDir?: string;                // Report output directory (default: ./a11y-reports)
  reportName?: string;            // Override the auto-derived report slug (default: test project name or first URL)
  failOnBlockers?: boolean;       // Throw if the ACCUMULATED state has any blocker (default: true)
  attach?: boolean;               // Attach the HTML report to the current test (default: true)
}
```

## Scan Results

`a11y.generateReport()` returns `{ state, reportPaths }`:

```typescript
{
  state: ScanState;                     // identical shape to the CLI's report.json
  reportPaths: {                        // Generated report files
    html: string;
    md: string;
    json: string;
  };
}

// Derive everything you need from state:
state.findings;          // Finding[] — all findings across every page (deduped)
state.passes;            // PassedRule[] — unioned; `pageUrls` lists every page each rule passed on
state.inapplicable;      // InapplicableRule[] — rules inapplicable on EVERY page (intersection)
state.plan.level;        // "A" | "AA" | "AAA"
state.meta.pagesScanned; // URL list of every page scanned in the worker
state.cost.totalUsd;     // cumulative LLM cost across every scanPage call (0 in mock mode)

// Aggregated counts via the helper exported from `a11y-scout`:
import { summarizeFindings } from "a11y-scout";
summarizeFindings(state); // { blockers, severe, major, minor, review, total }
```

## Generated Reports

Each worker generates one consolidated set of three reports in `test-results/[test-name]/a11y-reports/`:

1. **HTML Report** (`*.html`)
   - Interactive browser-viewable report
   - Dark-mode aware
   - Severity-coded findings
   - Automatically attached to Playwright HTML reporter

2. **Markdown Report** (`*.md`)
   - Text-based summary
   - Paste into PRs or commit messages
   - Includes severity breakdown and key findings

3. **JSON Report** (`*.json`)
   - Machine-readable format
   - Full finding details
   - For CI/CD integration and metrics

## Running Tests

```bash
# Run all tests
npx playwright test

# Run specific test
npx playwright test tests/accessibility.spec.ts

# View HTML report (includes a11y reports as attachments)
npx playwright show-report
```

## Usage in WebdriverIO Tests

The WebdriverIO helper (`@a11y-scout/webdriverio`) mirrors the Playwright package's
two-call API. The only difference is that the WebdriverIO `browser` is passed
**explicitly** (Playwright injects `page` via a fixture). This works in both the WDIO
testrunner (global `browser`) and standalone (`remote()`) modes.

### Basic Example

```typescript
import { scanPage, generateReport } from "@a11y-scout/webdriverio";

describe("home page", () => {
  it("is accessible", async () => {
    await browser.url("https://your-app.com");
    await scanPage(browser, { level: "AA" });
  });

  it("checkout is accessible", async () => {
    await browser.url("https://your-app.com/checkout");
    await scanPage(browser, { level: "AA" });
  });

  after(async () => {
    // Emits ONE consolidated report covering both pages above.
    await generateReport();
  });
});
```

`scanPage()` accumulates each page into a **worker-scoped** report (one accumulator per
WebdriverIO worker process); `generateReport()` emits a single consolidated
HTML/Markdown/JSON report for every page scanned in that worker.

### Auto-finalize via a config hook

The cleanest place to finalize once per worker is the `after` hook in `wdio.conf.ts`:

```typescript
import { generateReport } from "@a11y-scout/webdriverio";

export const config = {
  // ...
  after: async () => {
    await generateReport({ failOnBlockers: false });
  },
};
```

Call `generateReport()` explicitly (with the default `failOnBlockers: true`) if you want
accumulated blockers to fail the run.

### `scanPage` / `generateReport` options

The option surface intentionally matches the Playwright package (see [Scan Options](#scan-options)
above), with two WebDriver-specific differences noted below:

```typescript
await scanPage(browser, {
  level: "AA",                      // "A" | "AA" | "AAA" — locked on first call in worker
  include: "#main",                 // CSS selector to scope scan
  exclude: [".third-party-widget"], // selectors to skip
  failOnBlockers: true,             // throw if THIS page has a blocker (default: true)
  maxCostUsd: 0.5,                  // shared across the worker (first call wins)
  keyboard: true,                   // keyboard-trap checks, WCAG 2.1.2 (default: true)
  focusChecks: true,                // focus-order/focus-visible checks (default: true)
  noFocusIndicatorScreenshots: false, // tier-2 focus-indicator screenshots — see note below
  aiFix: true,                      // include AI-suggested fixed HTML per finding (default: true with a real LLM)
  waitForNetworkIdle: false,        // no-op under WebDriver (see Limitations)
  extraWaitMs: 0,                   // extra wait (ms) after load for lazy-loaded content
  // llm: myProvider,               // custom LLM provider; honored only on the FIRST call in a worker
});
```

**Differences from the Playwright package:**

- `noFocusIndicatorScreenshots` **defaults to `true` (screenshots off) under WebDriver**
  (it defaults to `false` under Playwright). WebDriver has no region-clipped screenshot, so
  the tier-2 focus-indicator pixel check falls back to a style-delta heuristic.
- `generateReport()` has **no `attach` option** — WebDriver has no test-attachment mechanism.
  It accepts `outDir`, `reportName`, and `failOnBlockers` only.

### Limitations under WebDriver

The detection engine is driver-agnostic, but a few checks depend on browser capabilities
WebDriver doesn't expose the same way Playwright does:

- **Focus-indicator pixel diff (tier-2 of WCAG 2.4.7) is off by default.** WebDriver has no
  region-clipped screenshot, so the pixel-level check cannot run; the engine falls back to
  its style-delta heuristic and reports one per-page summary needing manual review.
- **Reflow (WCAG 1.4.10) width measurements are slightly imprecise.** `setViewportSize` maps
  to WebDriver's `setWindowSize`, which sets the outer window (including browser chrome)
  rather than the inner viewport, so narrow-width results may be off by the chrome delta.
- **`waitForNetworkIdle` and reduced-motion emulation are no-ops.** WebDriver has no
  equivalents; tests own their own readiness waits. (The determinism stylesheet that
  disables transitions/animations is still injected.)

## WCAG Levels Explained

| Level | What's Checked | HAIP Required? | Cost |
|-------|---------------|----------------|------|
| **A** | Basic accessibility (minimum conformance). With LLM: also flags meaningful-alt, sensory-only instructions, page title, link purpose in context, label-in-name, error identification, form labels. | Optional | Free without LLM; ~$0.001/page with LLM |
| **AA** | Industry standard (includes A). With LLM: also flags undescriptive headings/labels, autocomplete sanity, language of parts, error suggestions. | Optional | Free without LLM; ~$0.001/page with LLM |
| **AAA** | Enhanced accessibility (includes A + AA). LLM also flags link purpose alone, section headings, reading level, abbreviations, unusual words, help. | Recommended | ~$0.002/page with LLM |

**Recommendation:** Start with level `AA` (most common requirement). Configure an LLM provider (HAIP or Bedrock) to enable the AI content-quality review candidates at every level — they're the only way to catch alt-text quality, generic link text, vague headings, and similar semantic issues that axe-core cannot evaluate. Every AI finding is `requiresHumanReview: true`.

## Troubleshooting

### Missing HAIP_API_KEY Warning

**Symptom:** Warning about missing HAIP credentials

**Solution:** Without HAIP (or another configured LLM provider) the scanner runs in mock mode:
- ✅ **axe-core, keyboard, and reflow checks**: run normally at A / AA / AAA — you get real deterministic violations
- ⏭️ **A/AA content-quality LLM checks**: skipped (deterministic CI)
- ⚠️ **AAA semantic LLM checks**: emit stub findings tagged `__mock__`

If you want the LLM-flagged review candidates (alt-text quality, link purpose, headings, labels, error messages, language of parts, etc.), obtain HAIP credentials from your team administrator or set `A11Y_LLM_PROVIDER=bedrock` with an AWS SSO profile.

### Type Errors

**Symptom:** TypeScript errors importing `@a11y-scout/playwright` or `@a11y-scout/webdriverio`

**Solution:** Ensure a compatible peer version of your test runner is installed:
```bash
npm install -D @playwright/test@latest   # Playwright projects
npm install -D webdriverio@latest         # WebdriverIO projects
```

Minimum required: `@playwright/test` >= 1.40.0 · `webdriverio` >= 8

### Reports Not Found

**Symptom:** Can't locate generated reports

**Solution:** Check `test-results/` directory structure:
```
test-results/
└── [test-name]-[browser]/
    └── a11y-reports/
        ├── report.html
        ├── report.md
        └── report.json
```

HTML reports are also attached to Playwright's built-in HTML reporter. View with:
```bash
npx playwright show-report
```

### Test Fails with "N blockers found"

**Symptom:** Test fails immediately with blocker message

**Behavior:** This is expected! By default, `failOnBlockers: true`.

**Solutions:**
1. Fix the accessibility issues (recommended)
2. Set `failOnBlockers: false` to collect metrics without failing
3. Use `exclude` option to skip known problematic areas temporarily

### Package Installation Fails

**Symptom:** npm install errors

**Solution:** Verify:
- Node.js >= 20 (`node --version`)
- Correct path to `.tgz` files
- Both packages are installed (core + playwright)

### Scans Take Too Long

**Symptom:** Tests timeout or run slowly

**Solution:**
- The content-quality LLM agent adds ~5–10 s per page when a real LLM is configured. Use `A11Y_HAIP_MOCK=1` (or unset credentials) to skip all LLM calls in CI for the fastest deterministic run.
- Avoid level `AAA` if not needed (the AAA-only semantic agent adds another LLM call on top of content-quality).
- Tighten the `A11Y_MAX_COST_USD` ceiling for crawls — content-quality stops scheduling pages once 95% of the cap is spent.
- Use `include` option to scan only relevant page sections
- Use `exclude` option to skip complex widgets

### SSL Certificate Errors

**Symptom:** `ERR_CERT_AUTHORITY_INVALID` or similar SSL errors

**Solution:**
For localhost with self-signed certificates or staging environments with invalid certs, use the CLI with:
```bash
npx a11y-scout scan-url https://localhost:3000 --ignore-https-errors
```

**Note:** If you get `ERR_SSL_PROTOCOL_ERROR`, your server is running on HTTP, not HTTPS. Use `http://` instead of `https://`.

## CI/CD Integration

### GitHub Actions

```yaml
- name: Run Accessibility Tests
  run: npx playwright test tests/accessibility.spec.ts
  env:
    HAIP_API_KEY: ${{ secrets.HAIP_API_KEY }}    # required for LLM checks
    # Optional — only set if your team scopes by environment / attributes usage:
    HAIP_USER_ID: ${{ secrets.HAIP_USER_ID }}
    # Tip: omit HAIP_API_KEY (or set A11Y_HAIP_MOCK=1) to run deterministic
    # axe + keyboard + reflow checks only, with no LLM calls or cost.

- name: Upload A11y Reports
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: a11y-reports
    path: test-results/**/a11y-reports/
```

### Jenkins

```groovy
stage('Accessibility Tests') {
  steps {
    sh 'npx playwright test tests/accessibility.spec.ts'
  }
  post {
    always {
      publishHTML(target: [
        reportDir: 'test-results',
        reportFiles: '**/a11y-reports/*.html',
        reportName: 'A11y Reports'
      ])
    }
  }
}
```

## Best Practices

1. **Start with AA level** — Most compliance requirements target AA
2. **Scan key user journeys** — Homepage, login, checkout, critical workflows
3. **Use exclude for third-party content** — You can't fix external widgets
4. **Run in CI/CD** — Catch regressions early
5. **Review HTML reports** — They provide remediation guidance
6. **Fix blockers first** — Prioritize by severity

## Support & Resources

- **Internal Repository:** Contact the a11y-scout maintainers
- **HAIP Access:** https://hyland.atlassian.net/wiki/x/boeVsw
- **AWS Bedrock (Claude) Access:** https://hyland.atlassian.net/wiki/x/lgIy5g
- **WCAG Guidelines:** https://www.w3.org/WAI/WCAG21/quickref/
- **Issues:** File bug reports in the internal a11y-scout repository

## Version Information

This guide is for **a11y-scout v0.3.0** / **@a11y-scout/playwright v0.3.0** / **@a11y-scout/webdriverio v0.3.0**.
