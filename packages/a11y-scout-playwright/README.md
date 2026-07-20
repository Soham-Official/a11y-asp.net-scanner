# @a11y-scout/playwright

Drop-in Playwright fixture that runs a11y-scout against any page rendered during a Playwright test. Supports WCAG 2.0/2.1/2.2 levels A, AA, and AAA with AI-powered semantic analysis.

## Breaking change in 0.3.0

`a11y.scan()` has been **replaced** with a two-call API that accumulates findings across multiple pages into a single consolidated report. Enterprise products span many pages — one report per `scan()` call left users with a folder of disconnected reports they had to correlate by hand. Now:

- `a11y.scanPage()` scans the current page and adds it to a worker-scoped accumulator.
- `a11y.generateReport()` emits **one** consolidated HTML/Markdown/JSON report for every page scanned in the worker.
- If you forget to call `generateReport()`, the worker teardown auto-finalizes (without attaching the HTML to a Playwright test, since there is no `TestInfo` at worker scope).
- The HTML report grows a sticky **"Filter by page"** dropdown that scopes every section (summary cards, severity groups, all tabs) to a single page. Default is "All pages".

There is **no `scan()` shim**. Migration is a small rename. See the table further down.

## Install

```bash
npm install --save-dev @a11y-scout/playwright
```

## Quick Start

```ts
import { test, expect } from "@a11y-scout/playwright";

test("home page", async ({ page, a11y }) => {
  await page.goto("https://app.dev.hyland.com");
  await a11y.scanPage({ level: "AA" });
});

test("checkout page", async ({ page, a11y }) => {
  await page.goto("https://app.dev.hyland.com/checkout");
  await a11y.scanPage({ level: "AA" });
});

test.afterAll(async ({ a11y }) => {
  // Emits one consolidated report covering both pages above.
  // Optional — worker teardown will do it automatically if you skip this.
  await a11y.generateReport();
});
```

Inside a single test, you can also scan several pages back-to-back:

```ts
test("flow", async ({ page, a11y }) => {
  await page.goto("https://app.dev.hyland.com/login");
  await a11y.scanPage();

  await page.click("text=Sign in");
  await page.waitForURL("**/dashboard");
  await a11y.scanPage();
});
```

## Migration from 0.2.x

| 0.2.x                                             | 0.3.0                                          |
| ------------------------------------------------- | ---------------------------------------------- |
| `const result = await a11y.scan({ level: "AA" })` | `await a11y.scanPage({ level: "AA" })`         |
| One report file per scan call                     | One consolidated report per worker             |
| `result.reportPaths`                              | `(await a11y.generateReport()).reportPaths`    |
| `result.state` per call                           | `(await a11y.generateReport()).state`          |
| `failOnBlockers: true` (default)                  | Same — per-page in `scanPage`, also in `generateReport` |

If your test only ever scans one page and you don't need the consolidated view, you can keep things simple by calling `generateReport()` at the end of that one test.

## Auto-finalize at worker teardown

If a test in a worker calls `scanPage()` but no test calls `generateReport()`, the worker teardown automatically writes the consolidated report files to `./a11y-reports/` (or `outDir` from the most recent `generateReport()` call). The auto-finalize path **does not attach** the HTML to any Playwright test (there is no `TestInfo` at worker scope) and **does not throw** on accumulated blockers — your tests have already finished by then.

To attach the HTML to a specific test and surface blockers as a test failure, call `generateReport()` explicitly:

```ts
test("multi-page coverage", async ({ page, a11y }) => {
  await page.goto("/");
  await a11y.scanPage({ failOnBlockers: false }); // defer page-level failure
  await page.goto("/checkout");
  await a11y.scanPage({ failOnBlockers: false });
  await a11y.generateReport(); // throws if any page produced a blocker
});
```

## Page filter in the HTML report

When a report covers more than one page, the HTML report includes a sticky **"Filter by page"** dropdown at the top, labeled `Page title — URL` (falling back to URL when no title was captured). Selecting a page filters:

- the severity summary cards (Blocker / Severe / Major / Minor / Review),
- the WCAG-summary box numbers (Total Issues, Passed Audits, Required Manual Review, Not Applicable),
- the "Review Needed", "Passes", and "Not Applicable" tab counters,
- every finding card and group across all tabs.

Selecting **"All pages"** restores the full view.

## AI-Powered Semantic Analysis (A / AA / AAA)

When a real LLM provider is configured (Bedrock or HAIP), `scanPage()` runs AI-driven content-quality checks **at every level** for criteria that axe-core can't evaluate. Mock mode (or no credentials) skips all LLM calls and the report stays deterministic.

```ts
import { test } from "@a11y-scout/playwright";
import { summarizeFindings } from "a11y-scout";

test("AA scan with AI content-quality checks", async ({ page, a11y }) => {
  await page.goto("/");
  await a11y.scanPage({ level: "AA" });
  const { state } = await a11y.generateReport();
  const summary = summarizeFindings(state);

  console.log(`Found ${state.findings.length} issues`);
  console.log(`AI cost: $${state.cost.totalUsd.toFixed(4)}`);
});
```

**What the content-quality agent checks (always-on at A / AA / AAA):**

| WCAG  | Level | What it flags                                                                                                  |
| ----- | ----- | -------------------------------------------------------------------------------------------------------------- |
| 1.1.1 | A     | Meaningless `alt` text (`"image"`, filename, duplicate of surrounding text) — distinct from axe's missing-alt  |
| 1.3.3 | A     | Instructions referencing only shape/color/position/sound ("click the green button")                            |
| 2.4.2 | A     | Generic page titles ("Untitled", "Home", "Document")                                                           |
| 2.4.4 | A     | Generic link text ("click here", "read more") with no disambiguating context                                   |
| 2.5.3 | A     | Visible label not contained in the accessible name                                                             |
| 3.3.1 | A     | Error region present but doesn't say _which_ field or _what_ is wrong                                          |
| 3.3.2 | A     | Form fields with no visible label / aria-label / aria-labelledby (placeholder alone)                           |
| 1.3.5 | AA    | Personal-data inputs missing or with the wrong `autocomplete` token                                            |
| 2.4.6 | AA    | Vague headings ("Section 1") or labels ("Field")                                                               |
| 3.1.2 | AA    | Foreign-language passages missing a `lang` attribute                                                           |
| 3.3.3 | AA    | Errors identified but no suggestion when one is feasible                                                       |

**What AAA scans add (only at level=AAA):**

- Link purpose (WCAG 2.4.9) - Links understandable out of context (link text alone)
- Section headings (WCAG 2.4.10) - Meaningful heading structure
- Unusual words (WCAG 3.1.3) - Jargon/idioms defined
- Abbreviations (WCAG 3.1.4) - Acronyms expanded on first use
- Reading level (WCAG 3.1.5) - Text complexity assessment
- Help availability (WCAG 3.3.5) - Contextual help provided

The first `scanPage()` call in a worker locks the LLM provider and `level`. Later calls inherit those settings (and warn if a conflicting `level` is passed) so a single cost meter spans the whole worker.

## Keyboard-Trap Detection (WCAG 2.1.2)

Every `scanPage()` also runs **keyboard-trap detection** — it simulates real `Tab`/`Shift+Tab`/`Escape` key presses to find regions where focus can enter but not leave by keyboard (something axe-core cannot detect). It's deterministic (no LLM) and **on by default**; disable per scan with `keyboard: false`.

**Testing modal traps:** open the modal yourself, _then_ scan:

```ts
test("dialog has no keyboard trap", async ({ page, a11y }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open settings" }).click();
  await a11y.scanPage({ level: "AA" }); // walks inside the open dialog
});
```

## Configuration

### Environment

All LLM configuration lives in `.env` (respects `A11Y_MAX_COST_USD`, `A11Y_LLM_PROVIDER`, etc.).

```bash
# .env
A11Y_LLM_PROVIDER=bedrock  # or haip, or mock
A11Y_MAX_COST_USD=1.00
```

### `scanPage` options

```ts
await a11y.scanPage({
  level: "AA",                      // "A" | "AA" | "AAA" — locked on first call in worker
  include: "#main",                 // CSS selector to scope scan
  exclude: [".chromatic-ignore"],   // selectors to skip
  failOnBlockers: true,             // throw if THIS page has a blocker (default true)
  keyboard: true,                   // keyboard-trap + focus checks (default true)
  maxCostUsd: 0.50,                 // shared across the worker (first call wins)
});
```

### `generateReport` options

```ts
const { state, reportPaths } = await a11y.generateReport({
  outDir: "./a11y-reports",      // default
  reportName: "checkout-flow",   // overrides the auto-derived slug
  failOnBlockers: true,          // throw if ACCUMULATED state has any blocker (default true)
  attach: true,                  // attach HTML to current test (default true)
});

state.findings;          // all findings across every page (deduped)
state.passes;            // unioned passes — `pageUrls` lists every page each rule passed on
state.inapplicable;      // rules inapplicable on EVERY page (intersection)
state.meta.pagesScanned; // URL list
state.cost.totalUsd;     // cumulative LLM cost across every scanPage call
reportPaths;             // { html, md, json }
```

## License

Hyland Internal.
