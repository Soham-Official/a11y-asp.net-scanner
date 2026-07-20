import { generateReport } from "@a11y-scout/webdriverio";

/**
 * Minimal WebdriverIO config for the a11y-scout demo.
 *
 * The key integration point is the `after` hook: it runs once per worker at
 * the end of the suite and emits ONE consolidated report covering every page
 * that `scanPage()` accumulated. This is the WebdriverIO analog of the
 * Playwright fixture's worker-teardown auto-finalize.
 */
export const config: WebdriverIO.Config = {
  runner: "local",

  specs: ["./tests/**/*.spec.ts"],
  maxInstances: 1,

  capabilities: [
    {
      browserName: "chrome",
      "goog:chromeOptions": {
        // Headless by default so the demo runs in CI. Set HEADED=1 to watch it
        // live (e.g. `HEADED=1 npm test`).
        args:
          process.env.HEADED === "1"
            ? ["--no-sandbox", "--disable-gpu"]
            : ["--headless=new", "--no-sandbox", "--disable-gpu"],
      },
    },
  ],

  logLevel: "error",
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 180_000,
  },

  /**
   * Emit the consolidated a11y-scout report after all specs in this worker
   * finish. `failOnBlockers: false` keeps the demo from failing the run so you
   * can inspect the report — flip it to `true` (the default) to gate CI on
   * accessibility blockers.
   */
  after: async () => {
    try {
      const { state, reportPaths } = await generateReport({
        failOnBlockers: false,
      });
      // eslint-disable-next-line no-console
      console.log(
        `[a11y-scout] ${state.findings.length} issue(s) across ` +
          `${state.meta.pagesScanned.length} page(s). Report: ${reportPaths.html}`,
      );
    } catch (err) {
      // No scanPage() ran (e.g. a spec was filtered out) — nothing to report.
      // eslint-disable-next-line no-console
      console.warn(`[a11y-scout] ${(err as Error).message}`);
    }
  },
};
