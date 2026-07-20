/**
 * Demo: drop @a11y-scout/webdriverio into any existing WebdriverIO suite.
 *
 *   npm install --save-dev @a11y-scout/webdriverio
 *
 * Then, in your spec:
 *   import { scanPage } from "@a11y-scout/webdriverio";
 *
 * The API is two calls:
 *   - `scanPage(browser)` — scan the page the browser is on and accumulate
 *     findings into a worker-scoped report.
 *   - `generateReport()` — emit ONE consolidated report covering every page
 *     scanned in this worker. This demo calls it from the `after` hook in
 *     wdio.conf.ts so it runs once at the end of the suite.
 *
 * Unlike the Playwright fixture (which receives `page` by injection), the
 * WebdriverIO `browser` is passed explicitly — this works in both the
 * testrunner (global `browser`, used here) and standalone `remote()` modes.
 *
 * Run with:
 *   npm test
 */
import { scanPage } from "@a11y-scout/webdriverio";

describe("example.com accessibility", () => {
  it("is roughly accessible at level AA", async () => {
    await browser.url("https://google.co.in");
    await scanPage(browser, {
      level: "AA",
      aiFix: false,
      failOnBlockers: false,
    });
  });
});
