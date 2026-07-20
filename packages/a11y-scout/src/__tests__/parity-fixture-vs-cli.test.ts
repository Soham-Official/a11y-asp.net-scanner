import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { createServer, type Server } from "node:http";
import { runScan } from "../agents/graph.js";
import { scanPage } from "../agents/scan-page.js";
import { MockProvider } from "../llm/mock-provider.js";
import { createPlaywrightPageDriver } from "../driver/playwright/index.js";
import type { Finding, InapplicableRule, PassedRule } from "../types.js";

/**
 * Parity test: the Playwright fixture path (scanPage on a test-supplied page)
 * and the CLI engine path (runScan with mode "url") must produce the same
 * axe findings, the same passes, and the same inapplicable rules when
 * pointed at the same DOM at the same WCAG level.
 *
 * If this regresses, the two surfaces have re-grown duplicate post-axe logic
 * — exactly the architectural problem this refactor was meant to kill.
 */

const FIXTURE_HTML = [
  "<!DOCTYPE html>",
  '<html lang="en">',
  "<head><title>parity fixture</title></head>",
  "<body>",
  "  <h1>Heading One</h1>",
  "  <h3>Skipped Two: heading-order violation</h3>",
  // image-alt: missing alt
  '  <img src="https://via.placeholder.com/150" />',
  // color-contrast: hard fail
  '  <p style="color:#bbb;background:#fff">Hard-to-read text on white.</p>',
  // color-contrast over an image: forces axe incomplete
  "  <div style=\"background-image: url('https://via.placeholder.com/300x100'); padding: 8px;\">",
  '    <span style="color:#888;">Text on image; incomplete</span>',
  "  </div>",
  // link-name fail
  '  <a href="/empty"></a>',
  // label/passes baseline
  '  <label for="email">Email</label>',
  '  <input id="email" type="email" />',
  "  <main>",
  "    <p>Body content for landmark coverage.</p>",
  "  </main>",
  "</body>",
  "</html>",
].join("\n");

async function startFixtureServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolveFn) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Failed to bind parity fixture server");
      }
      const url = `http://127.0.0.1:${addr.port}/`;
      const close = () =>
        new Promise<void>((r) => server.close(() => r()));
      resolveFn({ url, close });
    });
  });
}

interface AxeShape {
  axeRuleIds: string[];
  axeWcagSc: string[];
  axeSeverity: Record<string, number>;
  incompleteCount: number;
  passRuleIds: string[];
  inapplicableRuleIds: string[];
}

function shapeFromFindings(
  findings: Finding[],
  passes: PassedRule[],
  inapplicable: InapplicableRule[],
): AxeShape {
  const axe = findings.filter((f) => f.source === "axe");
  const severity: Record<string, number> = {};
  for (const f of axe) severity[f.severity] = (severity[f.severity] ?? 0) + 1;
  return {
    axeRuleIds: axe.map((f) => f.ruleId).sort(),
    axeWcagSc: Array.from(new Set(axe.map((f) => f.wcagSc))).sort(),
    axeSeverity: severity,
    incompleteCount: axe.filter((f) => f.requiresHumanReview === true).length,
    passRuleIds: Array.from(new Set(passes.map((p) => p.ruleId))).sort(),
    inapplicableRuleIds: Array.from(
      new Set(inapplicable.map((r) => r.ruleId)),
    ).sort(),
  };
}

describe("CLI engine and Playwright fixture produce the same scan output", () => {
  let server: { url: string; close: () => Promise<void> };
  let browser: Browser;
  let cliShape: AxeShape;
  let fixtureShape: AxeShape;

  beforeAll(async () => {
    server = await startFixtureServer();
    browser = await chromium.launch({ headless: true });

    // CLI path: runScan with mode "url" (the exact path scan-url takes).
    const cliState = await runScan({
      mode: "url",
      target: server.url,
      level: "AA",
      llm: new MockProvider(),
    });
    cliShape = shapeFromFindings(
      cliState.findings,
      cliState.passes,
      cliState.inapplicable,
    );

    // Fixture path: caller-supplied page (already navigated) + scanPage.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(server.url, { waitUntil: "load" });
    const fixtureResult = await scanPage({
      page: createPlaywrightPageDriver(page),
      url: server.url,
      level: "AA",
      llm: new MockProvider(),
    });
    fixtureShape = shapeFromFindings(
      fixtureResult.findings,
      fixtureResult.passes,
      fixtureResult.inapplicable,
    );
    await context.close();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("same axe rule ids fired (multiset, sorted)", () => {
    expect(fixtureShape.axeRuleIds).toEqual(cliShape.axeRuleIds);
  });

  it("same set of WCAG success criteria", () => {
    expect(fixtureShape.axeWcagSc).toEqual(cliShape.axeWcagSc);
  });

  it("same severity distribution across axe findings", () => {
    expect(fixtureShape.axeSeverity).toEqual(cliShape.axeSeverity);
  });

  it("incomplete-derived findings emitted on both surfaces", () => {
    // The fixture used to drop `results.incomplete` entirely. Both must now
    // emit them with `requiresHumanReview: true`.
    expect(fixtureShape.incompleteCount).toEqual(cliShape.incompleteCount);
  });

  it("incomplete count is non-zero (regression guard for fixture parity)", () => {
    // The text-on-image block in the fixture is what creates an `incomplete`.
    // If this hits 0 the fixture went back to dropping incomplete results.
    expect(fixtureShape.incompleteCount).toBeGreaterThan(0);
  });

  it("same passed-rule ids", () => {
    expect(fixtureShape.passRuleIds).toEqual(cliShape.passRuleIds);
  });

  it("same inapplicable-rule ids", () => {
    expect(fixtureShape.inapplicableRuleIds).toEqual(
      cliShape.inapplicableRuleIds,
    );
  });
});
