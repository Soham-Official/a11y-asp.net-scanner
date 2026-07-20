# a11y-scout — Usage Guide

a11y-scout is an AI-assisted WCAG 2.0 / 2.1 / 2.2 accessibility scanner. It ships as three npm packages you can use independently or together:

| Package | What it is | Use it for |
|---|---|---|
| **`a11y-scout`** | The core engine + `a11y-scout` CLI | Ad-hoc and CI scans of live URLs (`scan-url`), static scans of source repos (`scan-repo`), and automated fixes (`fix-repo`). The other two packages depend on this one. |
| **`@a11y-scout/playwright`** | A drop-in Playwright test fixture | Failing your CI when a page in your Playwright test suite has accessibility blockers. Runtime checks against real rendered pages. |
| **`@a11y-scout/webdriverio`** | A drop-in WebdriverIO helper | The same idea for WebdriverIO suites. Reuses the identical detection engine; only the browser-rendering layer differs. |

All AI calls go through Hyland's AI Platform (HAIP) gateway — **no data egress to third-party LLM vendors**. Without credentials the tool runs in a deterministic **mock mode** (engine checks still run; AI checks are skipped).

---

## Contents

1. [How scanning works (read this first)](#1-how-scanning-works-read-this-first)
2. [Prerequisites & setup](#2-prerequisites--setup)
3. [The Playwright plugin (`@a11y-scout/playwright`)](#3-the-playwright-plugin-a11y-scoutplaywright)
4. [The WebdriverIO helper (`@a11y-scout/webdriverio`)](#4-the-webdriverio-helper-a11y-scoutwebdriverio)
5. [Scanning live URLs (`scan-url`)](#5-scanning-live-urls-scan-url)
6. [Scanning source repos (`scan-repo`) — React & Angular](#6-scanning-source-repos-scan-repo--react--angular)
7. [Auto-fixing issues (`fix-repo`)](#7-auto-fixing-issues-fix-repo)
8. [Reports](#8-reports)
9. [Troubleshooting & FAQ](#9-troubleshooting--faq)

---

## 1. How scanning works (read this first)

The single most important concept: **static analysis and runtime analysis catch different bugs. Neither is a superset of the other.** For real coverage you want both.

Every scan layers up to three kinds of checks:

| Layer | Powered by | Cost | Where it runs |
|---|---|---|---|
| **Deterministic engine checks** | axe-core (runtime) / ESLint a11y rules (static) | Free | Always on |
| **Keyboard & focus checks** | Real `Tab`/`Shift+Tab`/`Escape` simulation — no LLM | Free | Runtime only (`scan-url`, Playwright plugin, WebdriverIO helper) |
| **AI content-quality checks** | HAIP LLM | Costs tokens | Runtime only; skipped in mock mode |

- **Runtime scanning** (`scan-url`, the Playwright plugin, and the WebdriverIO helper) loads the real page in a browser, so it sees JavaScript-rendered DOM, computed styles, focus behavior, and content. It runs **all three layers**.
- **Static scanning** (`scan-repo`) parses your source files with ESLint a11y rules. It's fast, needs no running app, and catches markup-level issues — but it **cannot** run keyboard checks or AI content-quality checks, and it can't see anything produced at runtime.

> **Non-negotiable:** AI findings never auto-claim conformance. Every AI-generated finding is flagged `requiresHumanReview: true` and reported as a *review item*, not a pass/fail. AI augments human judgement; it does not replace it.

---

## 2. Prerequisites & setup

### Requirements

- **Node.js >= 20** (uses Node's built-in `.env` loader).
- For runtime scans, a Chromium browser (installed via Playwright — see below).

### Install (pilot — local packages)

> **Pilot delivery.** During the pilot phase the packages are **not published to a registry** — they're delivered to you as local folders (or tarballs). Install them by pointing npm at the local path you were given. Replace `<path to a11y-scout>` below with the actual path on your machine (e.g. `../a11y-scout/packages/a11y-scout` or a `.tgz` file).

To use the **CLI** (`scan-url`, `scan-repo`, `fix-repo`), install the core package into your project:

```bash
npm install <path to a11y-scout>
```

Then run it with `npx a11y-scout <command>` as shown throughout this guide. (For the Playwright plugin, see [§3](#3-the-playwright-plugin-a11y-scoutplaywright) — you'll install **both** packages.)

After installing, install the Chromium browser used for runtime scans:

```bash
npx playwright install chromium
```

### Environment variables

Both packages read the same `.env` file (the CLI walks up from the working directory to find the nearest one). Copy `.env.example` to `.env` and fill in what you need.

| Variable | Purpose | Default |
|---|---|---|
| `A11Y_LLM_PROVIDER` | `haip` \| `bedrock` \| `mock` (auto-detected if unset) | auto |
| `HAIP_API_KEY` | Bearer token for HAIP (required for real AI scans) | — |
| `HAIP_ENVIRONMENT_ID` | HAIP environment id | — |
| `HAIP_USER_ID` | Service-account identifier | — |
| `A11Y_MAX_COST_USD` | Hard cap on LLM spend per scan | `1.00` |
| `A11Y_HAIP_MOCK=1` | Force mock mode even when a key is present | — |

> **Provider detection priority:** explicit `A11Y_LLM_PROVIDER` → Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`, or `AWS_PROFILE` set without a `HAIP_API_KEY`) → mock (`A11Y_HAIP_MOCK=1`) → **defaults to HAIP**, which falls back to mock if no `HAIP_API_KEY` is found. Note that `A11Y_HAIP_MOCK=1` forces mock even when a HAIP key is present.

### Verify your setup

```bash
npx a11y-scout doctor
```

Prints your Node version, platform, the active LLM provider, and whether its credentials are configured.

Two built-in flags are available on every command:

```bash
npx a11y-scout --version          # print the installed version
npx a11y-scout --help             # list all commands
npx a11y-scout scan-url --help    # show options for a specific command
```

### Mock mode (CI & offline)

When no credentials are present, or `A11Y_LLM_PROVIDER=mock` / `A11Y_HAIP_MOCK=1` is set:

- ✅ axe-core, keyboard, and focus checks run normally and **deterministically**.
- ⏭️ The A/AA content-quality agent is **skipped entirely**; AAA semantic findings become stubs.
- 💲 Zero LLM cost.

This is the recommended mode for CI gating where you only want hard, deterministic failures.

---

## 3. The Playwright plugin (`@a11y-scout/playwright`)

The plugin scans **whatever page your test has already navigated to**. Page lifecycle — navigation, auth, clicking into a modal — is your test's job; the fixture just runs the scan engine on the current DOM. This makes it ideal for stateful checks (e.g. open a dialog, *then* scan it).

### Install

> **Pilot delivery — install both packages.** Because the packages aren't published to a registry yet, npm can't resolve `@a11y-scout/playwright`'s dependency on the core `a11y-scout` package automatically. You must install **both** from their local paths. The plugin re-exports helpers like `summarizeFindings` from the core package, so both are needed at runtime regardless. Replace the `<path to …>` placeholders with the actual paths you were given.

```bash
npm install --save-dev <path to a11y-scout-playwright> <path to a11y-scout>
```

Both are needed: `@a11y-scout/playwright` provides the test fixture, and `a11y-scout` provides the core engine plus helpers (`summarizeFindings`, etc.) that the examples import directly.

### Quick start

Import `test` and `expect` **from the plugin** (`@a11y-scout/playwright`), *not* from `@playwright/test`. The plugin re-exports Playwright's own `test`/`expect` extended with the `a11y` fixture — if you import `test` from `@playwright/test`, the `a11y` fixture won't exist and the test will fail with an "unknown fixture" error.

> **ESM only.** Both packages are published as ES modules (`"type": "module"`, no CommonJS build), so use `import` syntax — `const { test } = require("@a11y-scout/playwright")` will not work. Keep your test files as ES modules (`.ts`/`.mts`, or `.js` in a `"type": "module"` project), and if you use a plain-JavaScript Playwright config in a non-module project, name it `playwright.config.mjs`.

> **Breaking change in 0.3.0.** `a11y.scan()` was replaced with `a11y.scanPage()` + `a11y.generateReport()`. Scans accumulate across the worker into a single consolidated report (with a page-filter dropdown in the HTML). The fixture package README documents the migration.

```ts
import { test, expect } from "@a11y-scout/playwright";

test("homepage", async ({ page, a11y }) => {
  await page.goto("https://app.example.com");
  await a11y.scanPage({ level: "AA" });
});

test("checkout", async ({ page, a11y }) => {
  await page.goto("https://app.example.com/checkout");
  await a11y.scanPage({ level: "AA" });
});

test.afterAll(async ({ a11y }) => {
  // Emit one report covering every page above. Optional — worker teardown
  // auto-finalizes the files for you if you skip this.
  const result = await a11y.generateReport();
  expect(result.state.findings).toEqual([]);
});
```

By default `a11y.scanPage()` **throws if THAT page has any blocker** (`failOnBlockers: true`), and `a11y.generateReport()` throws if the accumulated state has any blocker. Pass `failOnBlockers: false` on either to defer / disable.

### `a11y.scanPage(options)` reference

All options are optional.

| Option | Type | Default | Description |
|---|---|---|---|
| `level` | `"A" \| "AA" \| "AAA"` | `"AA"` | WCAG conformance level. `AAA` adds extra AI semantic checks. |
| `outDir` | `string` | `"./a11y-reports"` | Where HTML/MD/JSON reports are written. |
| `include` | `string` | — | CSS selector to scope the scan to one region. |
| `exclude` | `string[]` | — | CSS selectors to skip. |
| `failOnBlockers` | `boolean` | `true` | Throw if any blocker-severity finding is present. |
| `keyboard` | `boolean` | `true` | Run keyboard-trap detection (WCAG 2.1.2). |
| `focusChecks` | `boolean` | `true` | Run focus-order / focus-visible checks. |
| `noFocusIndicatorScreenshots` | `boolean` | `false` | Disable screenshot-based focus-indicator verification. |
| `aiFix` | `boolean` | `true` | Include AI-suggested fixed HTML per finding (real provider only). |
| `waitForNetworkIdle` | `boolean` | `true` | Best-effort `networkidle` wait (15s ceiling) before scanning. |
| `extraWaitMs` | `number` | — | Fixed extra delay after readiness, before scanning. |
| `maxCostUsd` | `number` | `A11Y_MAX_COST_USD` or `1.00` | Cumulative LLM cost ceiling for this scan. |
| `llm` | `LlmProvider` | auto | Inject a custom provider; auto-detected from env if omitted. |

### Return values

`scanPage()` returns the per-page slice it just scanned:

```ts
interface ScanPageSliceResult {
  findings: Finding[];
  evidence: PageEvidence;
  passes: PassedRule[];
  inapplicable: InapplicableRule[];
  pageUrl: string;
  accumulatedCount: number; // running total across the worker
}
```

`generateReport()` returns the full consolidated state plus the report paths:

```ts
interface GenerateReportResult {
  state: ScanState;   // identical shape to the CLI's report.json
  reportPaths: { html: string; md: string; json: string };
}
```

Useful fields on `state`:

```ts
result.state.findings;        // Finding[] — all issues (axe + keyboard + AI)
result.state.passes;          // rules that passed on every node
result.state.inapplicable;    // rules with nothing to test
result.state.plan.level;      // "AA"
result.state.cost.totalUsd;   // cumulative LLM cost across every scanPage call
result.state.meta.pagesScanned; // URL[] — every page covered by this report
```

Use `summarizeFindings` (from the core package) for severity counts:

```ts
import { summarizeFindings } from "a11y-scout";

const summary = summarizeFindings(result.state);
// { blockers, severe, major, minor, review, total }
```

### Common patterns

**Fail only on blockers, log everything else (recommended for incremental adoption):**

```ts
import { test } from "@a11y-scout/playwright";
import { summarizeFindings } from "a11y-scout";

test("dashboard", async ({ page, a11y }) => {
  await page.goto("/dashboard");
  await a11y.scanPage({ level: "AA" }); // throws on per-page blockers by default
});

test.afterAll(async ({ a11y }) => {
  const result = await a11y.generateReport();
  const s = summarizeFindings(result.state);
  console.log(`severe=${s.severe} major=${s.major} review=${s.review}`);
});
```

**Scan a sub-region only:**

```ts
await a11y.scanPage({ level: "AA", include: "#main", exclude: [".third-party-widget"] });
```

**Test a modal/keyboard trap — open it first, *then* scan:**

A modal behind a trigger button is closed on page load, so an automatic crawl never exercises it. The fixture is the right place to catch these:

```ts
test("settings dialog has no keyboard trap", async ({ page, a11y }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open settings" }).click(); // open the modal
  await a11y.scanPage({ level: "AA" });                              // walk runs inside the dialog
});
```

**Faster axe-only pass (skip keyboard/focus):**

```ts
await a11y.scanPage({ level: "AA", keyboard: false, focusChecks: false });
```

### A complete starter setup

Three files get you from zero to a running accessibility suite.

**1. `playwright.config.ts`** — a standard Playwright config. The plugin needs no special wiring; it works with any project setup. (If your app needs a dev server, the commented `webServer` block starts it for you.)

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/a11y",
  reporter: [["html", { open: "never" }]], // a11y HTML reports attach here
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    ignoreHTTPSErrors: true, // handy for self-signed localhost certs
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // Uncomment to let Playwright start your app before the suite runs:
  // webServer: {
  //   command: "npm run start",
  //   url: "http://localhost:3000",
  //   reuseExistingServer: !process.env.CI,
  //   timeout: 120_000,
  // },
});
```

**2. `tests/a11y/home.spec.ts`** — a realistic spec covering the common cases:

```ts
import { test, expect } from "@a11y-scout/playwright";
import { summarizeFindings } from "a11y-scout";

test.describe("Accessibility", () => {
  test("home page has no WCAG AA blockers", async ({ page, a11y }) => {
    await page.goto("/");
    // Throws on any per-page blocker by default (failOnBlockers: true).
    await a11y.scanPage({ level: "AA" });
  });

  test("settings dialog has no keyboard trap", async ({ page, a11y }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open settings" }).click();
    // Scan runs inside the now-open dialog.
    await a11y.scanPage({ level: "AA" });
  });

  test.afterAll(async ({ a11y }) => {
    // Emit one report covering every page above. Optional — worker teardown
    // auto-finalizes the files even without this call.
    const result = await a11y.generateReport();
    const s = summarizeFindings(result.state);
    console.log(
      `blockers=${s.blockers} severe=${s.severe} major=${s.major} review=${s.review} pages=${result.state.meta.pagesScanned.length}`,
    );
    console.log(`Report: ${result.reportPaths.html}`);
  });

  test("main content is clean (scoped, axe-only fast pass)", async ({ page, a11y }) => {
    await page.goto("/");
    await a11y.scanPage({
      level: "AA",
      include: "#main",
      exclude: [".third-party-widget"],
      keyboard: false,
      focusChecks: false,
    });
  });
});
```

**3. `.env`** — provider config (see [§2](#2-prerequisites--setup)). Leave it on `mock` for CI gating; switch to `haip` for AI content-quality checks:

```bash
A11Y_LLM_PROVIDER=mock   # haip | bedrock | mock
A11Y_MAX_COST_USD=1.00
# HAIP_API_KEY=...        # required when A11Y_LLM_PROVIDER=haip
```

Run it:

```bash
npx playwright test            # run the a11y suite
npx playwright show-report     # open the report (a11y reports attached per test)
```

### CI tip

Run the suite with `A11Y_LLM_PROVIDER=mock` in CI for deterministic, zero-cost gating on hard (axe + keyboard) failures. Run with real HAIP credentials in a nightly/scheduled job to also get AI content-quality review items. The HTML report is automatically attached to the Playwright HTML report for each test.

---

## 4. The WebdriverIO helper (`@a11y-scout/webdriverio`)

`@a11y-scout/webdriverio` runs the **same detection engine** as the Playwright plugin — identical axe-core rule selection, keyboard-trap detection, reflow, and AI content-quality agents. Only the browser-rendering layer differs. Use it if your suite is already on WebdriverIO.

The key difference from Playwright is the shape of the API: instead of an injected `a11y` fixture, you import two **functions** and pass the WebdriverIO `browser` explicitly. This works in both the WDIO testrunner (global `browser`) and standalone (`remote()`) modes.

### Install

> **Pilot delivery — install both packages.** As with Playwright, npm can't resolve `@a11y-scout/webdriverio`'s dependency on the core `a11y-scout` package from a registry yet, so install **both** from their local paths. Replace the `<path to …>` placeholders with the actual paths you were given.

```bash
npm install --save-dev <path to a11y-scout-webdriverio> <path to a11y-scout>
```

`webdriverio` itself is a peer dependency — you already have it in a WebdriverIO project.

> **ESM only.** Like the other packages, this ships as an ES module. Use `import` syntax.

### Quick start

Import `scanPage` and `generateReport`, and pass `browser` to `scanPage`:

```ts
import { scanPage, generateReport } from "@a11y-scout/webdriverio";

describe("home page", () => {
  it("is accessible", async () => {
    await browser.url("https://app.example.com");
    await scanPage(browser, { level: "AA" });
  });

  it("checkout is accessible", async () => {
    await browser.url("https://app.example.com/checkout");
    await scanPage(browser, { level: "AA" });
  });

  after(async () => {
    // Emit one report covering both pages above.
    await generateReport();
  });
});
```

`scanPage()` accumulates each page into a **worker-scoped** report (one accumulator per WebdriverIO worker process). `generateReport()` emits a single consolidated HTML/Markdown/JSON report for every page scanned in that worker.

By default `scanPage()` **throws if THAT page has any blocker** (`failOnBlockers: true`), and `generateReport()` throws if the accumulated state has any blocker. Pass `failOnBlockers: false` on either to defer / disable.

> **No auto-finalize.** Unlike the Playwright fixture, there is no worker teardown that emits the report for you — **you must call `generateReport()` yourself** (in an `after` hook, or once per worker via the config hook below). If you never call it, no report is written.

### Auto-finalize via a config hook

The cleanest place to finalize once per worker is the `after` hook in `wdio.conf.ts`:

```ts
import { generateReport } from "@a11y-scout/webdriverio";

export const config = {
  // ...
  after: async () => {
    await generateReport({ failOnBlockers: false });
  },
};
```

Use `failOnBlockers: true` (the default) if you want accumulated blockers to fail the run.

### `scanPage(browser, options)` reference

The option surface intentionally mirrors the Playwright fixture's `scanPage()` so the two integrations stay interchangeable. All options are optional.

| Option | Type | Default | Description |
|---|---|---|---|
| `level` | `"A" \| "AA" \| "AAA"` | `"AA"` | WCAG conformance level. Locked on the first call in a worker. |
| `include` | `string` | — | CSS selector to scope the scan to one region. |
| `exclude` | `string[]` | — | CSS selectors to skip. |
| `failOnBlockers` | `boolean` | `true` | Throw if this page introduces any blocker. |
| `keyboard` | `boolean` | `true` | Run keyboard-trap detection (WCAG 2.1.2). |
| `focusChecks` | `boolean` | `true` | Run focus-order / focus-visible checks. |
| `noFocusIndicatorScreenshots` | `boolean` | `true` | **Off by default under WebDriver** (see limitations below). |
| `aiFix` | `boolean` | `true` | Include AI-suggested fixed HTML per finding (real provider only). |
| `waitForNetworkIdle` | `boolean` | — | **No-op under WebDriver** (see limitations). |
| `extraWaitMs` | `number` | — | Fixed extra delay before scanning. |
| `maxCostUsd` | `number` | `A11Y_MAX_COST_USD` or `1.00` | Cumulative LLM cost ceiling for the worker (first call wins). |
| `llm` | `LlmProvider` | auto | Inject a custom provider; honored only on the first `scanPage` call in a worker. |

`scanPage()` returns the same `ScanPageSliceResult` shape as the Playwright fixture (`findings`, `evidence`, `passes`, `inapplicable`, `pageUrl`, `accumulatedCount`), and `generateReport()` returns `{ state, reportPaths }` — see [§3](#3-the-playwright-plugin-a11y-scoutplaywright) for the field reference.

### Testing a modal / keyboard trap

Same pattern as Playwright — open it first, *then* scan:

```ts
it("dialog has no keyboard trap", async () => {
  await browser.url("/");
  await $("button=Open settings").click();
  await scanPage(browser, { level: "AA" }); // walks inside the open dialog
});
```

### Limitations under WebDriver

The engine is driver-agnostic, but a few checks depend on browser capabilities WebDriver doesn't expose the same way Playwright does:

- **Focus-indicator pixel diff (tier-2 of WCAG 2.4.7) is off by default.** WebDriver has no region-clipped screenshot, so the pixel-level check can't run. The engine falls back to its style-delta heuristic and reports one per-page summary needing manual review. You can opt in with `noFocusIndicatorScreenshots: false`, but the clip request will throw and the check degrades to "indicator present" — leaving it off is recommended.
- **Reflow (WCAG 1.4.10) width measurements are slightly imprecise.** `setViewportSize` maps to WebDriver's `setWindowSize`, which sets the **outer** window (including browser chrome) rather than the inner viewport. Narrow-width reflow results may be off by the chrome delta.
- **`waitForNetworkIdle` and reduced-motion emulation are no-ops.** WebDriver has no equivalents; tests own their own readiness waits. The determinism stylesheet (transitions/animations disabled) is still injected.

---

## 5. Scanning live URLs (`scan-url`)

`scan-url` runs the same runtime engine as the Playwright plugin, from the command line. Default is a **single page**; add `--crawl` to follow same-origin links.

```bash
# single page
npx a11y-scout scan-url https://example.com --level AA

# crawl the site
npx a11y-scout scan-url https://example.com --crawl --max-pages 20 --max-depth 3
```

### Options

| Option | Default | Description |
|---|---|---|
| `-o, --out <dir>` | `./a11y-reports` | Output directory for reports. |
| `-l, --level <A\|AA\|AAA>` | `AA` | WCAG level. `AAA` enables AI-flagged review items. |
| `--headed` | headless | Show the browser — useful for debugging. |
| `--crawl` | off | Follow same-origin links from the start URL. |
| `--max-pages <n>` | `10` | Max pages to visit during a crawl. |
| `--max-depth <n>` | `2` | Max link-depth from the start URL. |
| `--include <regex>` | — | Only crawl URLs matching this regex (after the same-origin filter). |
| `--exclude <regex>` | — | Skip URLs matching this regex (e.g. `'/(login\|signup\|cart)'`). |
| `--auth-state <path>` | — | Saved Playwright `storageState` JSON for authenticated pages. |
| `--capture-auth` | — | Open a real browser to log in once; saves auth state to `--auth-state`. |
| `--ignore-https-errors` | — | Ignore HTTPS cert errors (self-signed localhost certs). |
| `--wait-until <strategy>` | `load` | `networkidle` \| `load` \| `domcontentloaded`. |
| `--extra-wait <ms>` | `0` | Extra wait after load (lazy-loaded content). |
| `--no-keyboard` | on | Disable keyboard-trap checks. |
| `--no-focus-checks` | on | Disable focus-order/visible checks (keyboard-trap stays on). |
| `--no-focus-indicator-screenshots` | on | Disable screenshot-based focus-indicator verification. |
| `--no-ai-fix` | on | Disable AI-suggested fixed HTML per finding. |

### Authenticated pages

Capture a session once, then reuse it:

```bash
# 1. Open a browser, log in manually; session is saved to auth.json
npx a11y-scout scan-url https://app.example.com --capture-auth --auth-state ./auth.json

# 2. Reuse the saved session on later scans
npx a11y-scout scan-url https://app.example.com --crawl --auth-state ./auth.json
```

> For privacy, the engine never reads the `.value` of input fields, so user-entered data on authenticated pages is never sent to the LLM.

### Local dev servers / SPAs

```bash
# self-signed cert + wait for a JS framework to finish rendering
npx a11y-scout scan-url https://localhost:3000 \
  --ignore-https-errors --wait-until networkidle --extra-wait 2000
```

The process exits `1` if any blocker is found (`2` on a scan error), which makes it easy to gate a pipeline.

---

## 6. Scanning source repos (`scan-repo`) — React & Angular

`scan-repo` statically analyses your source with ESLint accessibility rules. It auto-detects the framework from `package.json` and lints the relevant files. **No running app required.**

```bash
npx a11y-scout scan-repo ./path/to/repo --level AA
```

Options: `-o, --out <dir>` (default `./a11y-reports`) and `-l, --level <A|AA|AAA>` (default `AA`).

### Coverage: React vs. Angular (be aware of the difference)

| | **React / Next** | **Angular** |
|---|---|---|
| Detected via | `react` or `next` in `package.json` | `@angular/core` in `package.json` |
| Files linted | `**/*.js`, `**/*.jsx`, `**/*.ts`, `**/*.tsx` | `**/*.ts` (inline templates) + `**/*.html` (external templates) |
| Engine | `eslint-plugin-jsx-a11y` (recommended ruleset) | `angular-eslint` template plugin |
| Rule count | ~30 jsx-a11y rules across A/AA/AAA | **11 template rules, A/AA only** |
| Ignored dirs | `node_modules`, `dist`, `build`, `.next` | `node_modules`, `dist`, `.angular` |

> **Angular support is intentionally transparent about its limits.** The Angular template plugin offers a **smaller rule set** than jsx-a11y, and it is **A/AA only** — there are no AAA static rules for Angular. Component TypeScript logic, signals, host bindings, and anything rendered at runtime are **not** covered by the static scan.

**Angular template rules currently checked:**

| Rule | WCAG SC |
|---|---|
| `alt-text` | 1.1.1 |
| `elements-content` | 4.1.2 |
| `interactive-supports-focus` | 2.1.1 |
| `label-has-associated-control` | 3.3.2, 4.1.2 |
| `click-events-have-key-events` | 2.1.1 |
| `mouse-events-have-key-events` | 2.1.1 |
| `no-autofocus` | 2.4.3 |
| `no-distracting-elements` | 2.2.2 |
| `role-has-required-aria` | 4.1.2 |
| `table-scope` | 1.3.1 |
| `valid-aria` | 4.1.2 |

### What static scanning does *not* catch (any framework)

- Keyboard traps, focus order, and focus-visibility (runtime only).
- AI content-quality issues — vague alt text, "click here" links, generic page titles (runtime only).
- Anything produced by JavaScript at runtime, dynamic ARIA state, computed contrast.
- **Other frameworks** (Vue, Svelte, plain HTML) — these are detected but produce **no findings** today.

> **Recommendation:** Treat `scan-repo` as your fast, pre-commit/PR markup gate, and pair it with the **Playwright plugin** (or `scan-url`) for runtime and content-quality coverage. Because Angular's static rule set is the thinner of the two, runtime scanning matters *even more* for Angular apps.

---

## 7. Auto-fixing issues (`fix-repo`)

`fix-repo` reads a JSON report, asks the LLM to generate **safe, mechanical** fixes, and applies them to your source files. It defaults to staging changes only (no commit) so you stay in control.

```bash
# Generate a report, then fix from the latest one
npx a11y-scout scan-repo ./src
npx a11y-scout fix-repo

# Preview without touching files
npx a11y-scout fix-repo --dry-run --confidence high
```

### Options

| Option | Default | Description |
|---|---|---|
| `[report-path]` | latest in reports dir | Specific report JSON to fix from. |
| `-o, --reports-dir <dir>` | `./a11y-reports` | Where to find the latest report if no path given. |
| `--confidence <levels>` | all | Comma-separated: `high,medium,low`. |
| `--severity <levels>` | all | Comma-separated: `blocker,severe,major,minor,review`. |
| `--categories <ids>` | all | Comma-separated rule IDs, e.g. `image-alt,html-has-lang`. |
| `--branch` | off | Create `a11y-auto-fixes-YYYY-MM-DD` before applying. |
| `--branch-prefix <prefix>` | `a11y-auto-fixes` | Branch name prefix (with `--branch`). |
| `--commit` | off | Auto-commit fixes grouped by category. |
| `--dry-run` | off | Generate fixes but don't apply or commit. |
| `--allow-dirty` | off | Proceed even if target files have uncommitted changes (warns instead of blocking). |

### What it can fix

Only localized, string-level edits with a clear correct answer:

| Category | Examples |
|---|---|
| `missing-alt` | Add/repair image `alt` text |
| `missing-lang` | Add or correct `<html lang>` |
| `empty-button` / `empty-link` | Give buttons/links an accessible name |
| `missing-label` | Associate a label with a form field |
| `empty-heading` / `empty-anchor` | Add content to empty headings/anchors |
| `iframe-title` | Add a `title` to an `<iframe>` |
| `attribute-rename` | Fix typo'd ARIA prop (`aria-labeledby` → `aria-labelledby`) |
| `attribute-value` | Correct a bad value (`tabindex`, `autocomplete`, role) |
| `attribute-removal` | Remove an offending attribute (`autofocus`, access keys) |

Applies to both **React/JSX** (`jsx-a11y/*` rules) and **Angular templates** (`@angular-eslint/template/*` rules).

### What it will **not** fix (manual remediation required)

- Interactive handlers (click/keyboard events on non-interactive elements) — these need real logic.
- Structural ARIA (role requirements, modal focus management).
- Content-quality rewrites (vague text, missing instructions).

These are reported under "Manual remediation required" and left untouched. Findings the LLM declines and fixes the applier couldn't safely apply are reported separately too.

### Recommended workflow

```bash
npx a11y-scout scan-repo ./src
npx a11y-scout fix-repo --dry-run --confidence high   # 1. preview
npx a11y-scout fix-repo --confidence high              # 2. apply (staged, not committed)
git diff --staged                                      # 3. review every change
git commit -m "fix(a11y): accessibility fixes"         # 4. commit when satisfied
```

> **Safety:** `fix-repo` refuses to run when files it would touch have uncommitted changes (override with `--allow-dirty`), and only touches files that actually contain findings — never the whole repo.

---

## 8. Reports

Every scan writes three reports into a timestamped subdirectory `./a11y-reports/<target-slug>-<timestamp>/` (override the base dir with `-o`/`outDir`):

| Format | File | Best for |
|---|---|---|
| **HTML** | `report.html` | Humans — interactive dashboard, expandable findings, evidence, suggested fixes. |
| **Markdown** | `report.md` | PR descriptions, quick review. |
| **JSON** | `report.json` | Machines — full `ScanState`; this is what `fix-repo` consumes. |

The most recent reports are also mirrored to a stable `./a11y-reports/latest/` directory (same three filenames), which is what `fix-repo` uses by default.

Report footers show the HAIP token cost for transparency. AI-generated findings are always tagged as **review items**, never as automatic pass/fail.

---

## 9. Troubleshooting & FAQ

**"LLM provider running in mock mode" — why no AI findings?**
No credentials were detected (or mock is forced). axe/keyboard/focus still run; AI content-quality is skipped. Run `a11y-scout doctor` to confirm provider config, and set `HAIP_API_KEY` (plus `HAIP_ENVIRONMENT_ID`, `HAIP_USER_ID`) for real AI checks.

**My SPA scans as nearly empty.**
The page hadn't finished rendering. Use `--wait-until networkidle` and/or `--extra-wait <ms>`. In the Playwright plugin, `waitForNetworkIdle` is on by default; add `extraWaitMs` for lazy content.

**HTTPS certificate errors on localhost.**
Add `--ignore-https-errors` (CLI). The Playwright plugin inherits your Playwright project's context settings.

**A modal's keyboard trap isn't detected.**
Closed modals aren't exercised by an automatic scan. Use the Playwright plugin: click to open the modal, *then* call `a11y.scanPage()`.

**My Angular repo reports fewer issues than I expected.**
That's expected — Angular static coverage is 11 template rules (A/AA) and can't see runtime behavior. Add runtime coverage with the Playwright plugin or `scan-url`. See [§6](#6-scanning-source-repos-scan-repo--react--angular).

**A scan stopped partway / cost looks capped.**
You hit `A11Y_MAX_COST_USD` (default `$1.00`). Raise it via env or `maxCostUsd`, or scope the scan with `include` / fewer crawl pages.

**My Vue/Svelte/HTML repo returns no findings.**
`scan-repo` only supports React and Angular today. Use `scan-url` against the running app for runtime coverage.
