# WebdriverIO helper demo

Shows how to use `@a11y-scout/webdriverio` in an existing WebdriverIO suite at AA (and AAA) levels — including the AI-driven content-quality review candidates that surface at every level when an LLM provider is configured. It reuses the **same detection engine** as the Playwright fixture; only the browser-rendering layer differs.

## Run

From the repo root:

```bash
npm install
npm run build --workspace=a11y-scout
npm run build --workspace=@a11y-scout/webdriverio
cd examples/webdriverio-demo
npm test
```

WebdriverIO 9 auto-manages the Chrome driver, so there's no separate browser-install step. The config runs headless Chrome; drop the `--headless=new` arg in `wdio.conf.ts` to watch it live.

## What's happening

The API is two calls:

- `scanPage(browser, opts?)` — scans the page `browser` is currently on and accumulates the findings in a worker-scoped report.
- `generateReport(opts?)` — emits **one** consolidated HTML/Markdown/JSON report covering every page scanned in the worker.

Unlike the Playwright fixture (which receives `page` by injection), the WebdriverIO `browser` is passed **explicitly** — this works in both the testrunner (global `browser`) and standalone (`remote()`) modes.

**Spec (`tests/example.spec.ts`):**

```ts
import { scanPage } from "@a11y-scout/webdriverio";

describe("example.com accessibility", () => {
  it("is roughly accessible at level AA", async () => {
    await browser.url("https://example.com");
    await scanPage(browser, { level: "AA", failOnBlockers: false });
  });
});
```

**Finalize once per worker (`wdio.conf.ts`):**

The idiomatic place to emit the report is the `after` hook, which runs once at the end of the suite:

```ts
import { generateReport } from "@a11y-scout/webdriverio";

export const config: WebdriverIO.Config = {
  // ...
  after: async () => {
    const { state, reportPaths } = await generateReport({ failOnBlockers: false });
    console.log(
      `[a11y-scout] ${state.findings.length} issue(s) across ` +
        `${state.meta.pagesScanned.length} page(s). Report: ${reportPaths.html}`,
    );
  },
};
```

## Key points

- `scanPage(browser)` runs axe-core, keyboard, and reflow checks deterministically and accumulates the findings in a worker-scoped report. **When a real LLM provider is configured**, the content-quality agent additionally flags A/AA semantic SCs that axe cannot evaluate. At `level: "AAA"`, the AAA-only semantic agent runs on top. The first call in a worker locks the LLM provider and `level`.
- `generateReport()` emits one consolidated report covering every page scanned in the worker. Call it from the `after` hook so it runs once per worker.
- `failOnBlockers: true` (default) throws per-page in `scanPage` AND in `generateReport` for the accumulated state. This demo sets `failOnBlockers: false` so you can inspect the report without failing the run.
- **Configuration:** Set `A11Y_LLM_PROVIDER` and `A11Y_MAX_COST_USD` in `.env` once — the helper honors it automatically. The content-quality and AAA-semantic agents share a single cost meter (one provider per worker).
- **Mock mode:** Set `A11Y_LLM_PROVIDER=mock` (or omit credentials) for CI/offline runs — both LLM agents skip themselves so the report stays deterministic. Axe / keyboard / reflow still produce real violations at every level.

## Limitations under WebDriver

A few checks depend on browser capabilities WebDriver exposes differently than Playwright — see the [`@a11y-scout/webdriverio` README](../../packages/a11y-scout-webdriverio/README.md#limitations-under-webdriver) for details (focus-indicator pixel diff off by default, reflow width imprecision, no-op network-idle/reduced-motion waits).
