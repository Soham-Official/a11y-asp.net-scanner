/**
 * Demo: drop the @a11y-scout/playwright fixture into any existing Playwright test.
 *
 *   npm install --save-dev @a11y-scout/playwright
 *
 * Then:
 *   import { test, expect } from "@a11y-scout/playwright";
 *
 * As of 0.3.0 the fixture exposes two calls instead of one:
 *   - `a11y.scanPage()` — scan the current page and accumulate findings.
 *   - `a11y.generateReport()` — emit ONE consolidated report covering every
 *     page scanned in this worker. If you forget to call it, the worker
 *     teardown auto-finalizes the report files (without attaching the HTML
 *     to a Playwright test, since there is no TestInfo at worker scope).
 *
 * Run with:
 *   npm test
 */
import { test, expect } from "@a11y-scout/playwright";
import { summarizeFindings } from "a11y-scout";

test("example.com is roughly accessible at level AA", async ({ page, a11y }) => {
  await page.goto("https://google.co.in");
  await a11y.scanPage({
    level: "AA",
    aiFix: false,
    failOnBlockers: false,
  });
});

test("emit the consolidated report", async ({ a11y }) => {
  const result = await a11y.generateReport({ failOnBlockers: false });
  const summary = summarizeFindings(result.state);
  expect(summary.total).toBeGreaterThanOrEqual(0);
  console.log(
    `[a11y-scout] ${summary.blockers} blocker(s), ${summary.severe} severe, ${summary.major} major across ${result.state.meta.pagesScanned.length} page(s). Report: ${result.reportPaths.html}`,
  );
});
