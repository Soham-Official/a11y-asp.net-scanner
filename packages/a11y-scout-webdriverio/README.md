# @a11y-scout/webdriverio

Drop-in WebdriverIO helper that runs a11y-scout against any page rendered during a WebdriverIO test. Supports WCAG 2.0/2.1/2.2 levels A, AA, and AAA with AI-powered semantic analysis.

It reuses the **same detection engine** as [`@a11y-scout/playwright`](../a11y-scout-playwright) — axe-core rule selection, keyboard-trap detection, reflow, and the AI content-quality agents are identical. Only the browser-rendering layer differs: this package wraps WebdriverIO's `browser` in the engine's framework-agnostic `PageDriver` abstraction.

## Install

```bash
npm install --save-dev @a11y-scout/webdriverio
```

`webdriverio` is a peer dependency — you already have it in a WebdriverIO project.

## Quick Start

Unlike the Playwright fixture (which receives `page` by injection), the WebdriverIO `browser` is passed **explicitly**. This works in both the WDIO testrunner (global `browser`) and standalone (`remote()`) modes.

```ts
import { scanPage, generateReport } from "@a11y-scout/webdriverio";

describe("home page", () => {
  it("is accessible", async () => {
    await browser.url("https://app.dev.hyland.com");
    await scanPage(browser, { level: "AA" });
  });

  it("checkout is accessible", async () => {
    await browser.url("https://app.dev.hyland.com/checkout");
    await scanPage(browser, { level: "AA" });
  });

  after(async () => {
    // Emits one consolidated report covering both pages above.
    await generateReport();
  });
});
```

`scanPage()` accumulates each page into a **worker-scoped** report (one accumulator per WebdriverIO worker process). `generateReport()` emits a single consolidated HTML/Markdown/JSON report for every page scanned in that worker.

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

Call `generateReport()` explicitly (with `failOnBlockers: true`, the default) if you want accumulated blockers to fail the run.

## AI-Powered Semantic Analysis (A / AA / AAA)

When a real LLM provider is configured (Bedrock or HAIP), `scanPage()` runs AI-driven content-quality checks **at every level** for criteria axe-core can't evaluate. Mock mode (or no credentials) skips all LLM calls and the report stays deterministic.

The checks are identical to the Playwright package — see its [README](../a11y-scout-playwright/README.md#ai-powered-semantic-analysis-a--aa--aaa) for the full WCAG table.

The first `scanPage()` call in a worker locks the LLM provider and `level`. Later calls inherit those settings (and warn if a conflicting `level` is passed) so a single cost meter spans the whole worker.

## Keyboard-Trap Detection (WCAG 2.1.2)

Every `scanPage()` also runs **keyboard-trap detection** — it drives real `Tab`/`Shift+Tab`/`Escape` key presses to find regions where focus can enter but not leave by keyboard (something axe-core cannot detect). Deterministic (no LLM), on by default; disable per scan with `keyboard: false`.

To test a modal, open it first, then scan:

```ts
it("dialog has no keyboard trap", async () => {
  await browser.url("/");
  await $("button=Open settings").click();
  await scanPage(browser, { level: "AA" }); // walks inside the open dialog
});
```

## Limitations under WebDriver

The engine is driver-agnostic, but a few checks depend on browser capabilities WebDriver doesn't expose the same way Playwright does:

- **Focus-indicator pixel diff (tier-2 of WCAG 2.4.7) is off by default.** WebDriver has no region-clipped screenshot, so the pixel-level "does focus draw a visible indicator?" check cannot run. The engine falls back to its style-delta heuristic and reports one per-page summary needing manual review. You can opt in with `noFocusIndicatorScreenshots: false`, but the clip request will throw and the check degrades to "indicator present" — so leaving it off is recommended.
- **Reflow (WCAG 1.4.10) width measurements are slightly imprecise.** `setViewportSize` maps to WebDriver's `setWindowSize`, which sets the **outer** window (including browser chrome) rather than Playwright's inner viewport. Narrow-width reflow results may be off by the chrome delta.
- **`waitForNetworkIdle` and reduced-motion emulation are no-ops.** WebDriver has no equivalents; tests own their own readiness waits. The determinism stylesheet (transitions/animations disabled) is still injected.

## Configuration

### Environment

All LLM configuration lives in `.env` (respects `A11Y_MAX_COST_USD`, `A11Y_LLM_PROVIDER`, etc.).

```bash
# .env
A11Y_LLM_PROVIDER=bedrock  # or haip, or mock
A11Y_MAX_COST_USD=1.00
```

### `scanPage` options

> **Maintainer note:** this option surface intentionally mirrors `@a11y-scout/playwright`'s `ScanPageOptions`. When you add or change an option in one integration package, update the other so they stay interchangeable.

```ts
await scanPage(browser, {
  level: "AA",                      // "A" | "AA" | "AAA" — locked on first call in worker
  include: "#main",                 // CSS selector to scope scan
  exclude: [".chromatic-ignore"],   // selectors to skip
  failOnBlockers: true,             // throw if THIS page has a blocker (default true)
  keyboard: true,                   // keyboard-trap + focus checks (default true)
  focusChecks: true,                // phase-2 focus checks (default true)
  maxCostUsd: 0.5,                  // shared across the worker (first call wins)
});
```

### `generateReport` options

```ts
const { state, reportPaths } = await generateReport({
  outDir: "./a11y-reports",      // default
  reportName: "checkout-flow",   // overrides the auto-derived slug
  failOnBlockers: true,          // throw if ACCUMULATED state has any blocker (default true)
});

state.findings; // all findings across every page (deduped)
state.passes; // unioned passes — `pageUrls` lists every page each rule passed on
state.inapplicable; // rules inapplicable on EVERY page (intersection)
state.meta.pagesScanned; // URL list
state.cost.totalUsd; // cumulative LLM cost across every scanPage call
reportPaths; // { html, md, json }
```

## Advanced: using the driver directly

If you need the engine's lower-level `scanPage` (from `a11y-scout`) or want to reuse the `PageDriver` for a custom flow, wrap the browser yourself:

```ts
import { createWebdriverioPageDriver } from "@a11y-scout/webdriverio";
import { scanPage as coreScanPage, createLlmProvider } from "a11y-scout";

const driver = await createWebdriverioPageDriver(browser);
const result = await coreScanPage({
  page: driver,
  url: await browser.getUrl(),
  level: "AA",
  llm: createLlmProvider({}),
});
```

## License

Hyland Internal.
