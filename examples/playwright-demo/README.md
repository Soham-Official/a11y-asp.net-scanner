# Playwright fixture demo

Shows how to use `@a11y-scout/playwright` in an existing Playwright suite at AA and AAA levels — including the AI-driven content-quality review candidates that surface at every level when an LLM provider is configured.

## Run

From the repo root:

```bash
npm install
npm run build --workspace=a11y-scout
npm run build --workspace=@a11y-scout/playwright
cd examples/playwright-demo
npx playwright install chromium
npm test
```

## What's happening

> **Heads up — 0.3.0 breaking change.** `a11y.scan()` has been replaced with
> `a11y.scanPage()` + `a11y.generateReport()`. Scans now accumulate across the
> whole worker into one consolidated report (with a page-filter dropdown in the
> HTML output). See the fixture package README for migration details.

**AA scan (axe-core + AI content-quality when an LLM is configured):**

```ts
import { test, expect } from "@a11y-scout/playwright";
import { summarizeFindings } from "a11y-scout";

test("homepage", async ({ page, a11y }) => {
  await page.goto("https://example.com");
  await a11y.scanPage({ level: "AA" });
});

test("checkout", async ({ page, a11y }) => {
  await page.goto("https://example.com/checkout");
  await a11y.scanPage({ level: "AA" });
});

test.afterAll(async ({ a11y }) => {
  const { state, reportPaths } = await a11y.generateReport();
  console.log(`Consolidated report: ${reportPaths.html}`);
  console.log(`${state.findings.length} issues across ${state.meta.pagesScanned.length} pages`);
});
```

**AAA scan (axe-core + content-quality + AAA-only semantic agent):**

```ts
test("AAA compliance", async ({ page, a11y }) => {
  await page.goto("https://example.com");
  await a11y.scanPage({ level: "AAA" });
});

test.afterAll(async ({ a11y }) => {
  const { state } = await a11y.generateReport();
  console.log(`LLM cost: $${state.cost.totalUsd.toFixed(4)}`);
  const aiFindings = state.findings.filter((v) => v.aiGenerated);
  console.log(`${aiFindings.length} AI-flagged for review`);
});
```

## Key points

- `test` is the standard Playwright `test` extended with one extra fixture: `a11y`.
- `a11y.scanPage()` runs axe-core, keyboard, and reflow checks deterministically and accumulates the findings in a worker-scoped report. **When a real LLM provider is configured**, the content-quality agent additionally flags A/AA semantic SCs that axe cannot evaluate. At `level: "AAA"`, the AAA-only semantic agent runs on top. The first call in a worker locks the LLM provider and `level`.
- `a11y.generateReport()` emits one consolidated HTML/Markdown/JSON report covering every page in the worker. If you forget, the worker teardown auto-finalizes the files (without attaching the HTML to a test).
- The HTML report has a sticky **"Filter by page"** dropdown when the report covers more than one page.
- `failOnBlockers: true` (default) throws per-page in `scanPage` AND in `generateReport` for the accumulated state. Set `failOnBlockers: false` to surface findings without failing.
- **Configuration:** Set `A11Y_LLM_PROVIDER` and `A11Y_MAX_COST_USD` in `.env` once — the fixture honors it automatically. The content-quality and AAA-semantic agents share a single cost meter (one provider per worker, so cost accumulates across every `scanPage` call).
- **Mock mode:** Set `A11Y_LLM_PROVIDER=mock` (or omit credentials) for CI/offline runs — both LLM agents skip themselves so the report stays deterministic. Axe / keyboard / reflow still produce real violations at every level.
