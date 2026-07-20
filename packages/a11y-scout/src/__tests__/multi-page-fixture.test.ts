import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createServer, type Server } from "node:http";
import { aggregatePages, type PerPageSlice } from "../agents/aggregate-pages.js";
import { scanPage } from "../agents/scan-page.js";
import { MockProvider } from "../llm/mock-provider.js";
import { createPlaywrightPageDriver } from "../driver/playwright/index.js";
import { plan as makeScanPlan } from "../agents/planner.js";
import { renderHtml } from "../reports/html.js";
import { renderMarkdown } from "../reports/markdown.js";
import type { ScanState } from "../types.js";

const PAGE_FOO = [
  "<!DOCTYPE html>",
  '<html lang="en">',
  "<head><title>Foo Page</title></head>",
  "<body>",
  "  <h1>Foo</h1>",
  '  <img src="https://via.placeholder.com/100" />', // image-alt fail
  "</body>",
  "</html>",
].join("\n");

const PAGE_BAR = [
  "<!DOCTYPE html>",
  '<html lang="en">',
  "<head><title>Bar Page</title></head>",
  "<body>",
  "  <h1>Bar</h1>",
  '  <a href="/empty"></a>', // link-name fail
  "</body>",
  "</html>",
].join("\n");

async function startMultiPageServer(): Promise<{
  fooUrl: string;
  barUrl: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolveFn) => {
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(req.url === "/bar" ? PAGE_BAR : PAGE_FOO);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Failed to bind multi-page fixture server");
      }
      const base = `http://127.0.0.1:${addr.port}`;
      resolveFn({
        fooUrl: `${base}/foo`,
        barUrl: `${base}/bar`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("Multi-page fixture: consolidated report shape + HTML filter markup", () => {
  let server: Awaited<ReturnType<typeof startMultiPageServer>>;
  let browser: Browser;
  let state: ScanState;

  beforeAll(async () => {
    server = await startMultiPageServer();
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    const slices: PerPageSlice[] = [];
    for (const url of [server.fooUrl, server.barUrl]) {
      await page.goto(url, { waitUntil: "load" });
      const r = await scanPage({
        page: createPlaywrightPageDriver(page),
        url,
        level: "AA",
        llm: new MockProvider(),
      });
      slices.push({
        url,
        findings: r.findings,
        evidence: r.evidence,
        passes: r.passes,
        inapplicable: r.inapplicable,
      });
    }
    await ctx.close();

    const agg = aggregatePages(slices);
    state = {
      scanId: "test-multi-page",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      plan: makeScanPlan({
        mode: "fixture",
        target: server.fooUrl,
        level: "AA",
      }),
      evidence: agg.evidence,
      findings: agg.findings,
      passes: agg.passes,
      inapplicable: agg.inapplicable,
      cost: { totalUsd: 0, entries: [] },
      meta: {
        version: "test",
        llmMockMode: true,
        llmProvider: "mock",
        pagesScanned: agg.pagesScanned,
        pagesSkipped: [],
      },
    };
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("aggregated state lists both pages and tags findings with the right pageUrl", () => {
    expect(state.meta.pagesScanned).toEqual([server.fooUrl, server.barUrl]);
    expect(state.evidence).toHaveLength(2);

    const findingsByPage = new Map<string, number>();
    for (const f of state.findings) {
      if (!f.pageUrl) continue;
      findingsByPage.set(f.pageUrl, (findingsByPage.get(f.pageUrl) ?? 0) + 1);
    }
    expect(findingsByPage.get(server.fooUrl) ?? 0).toBeGreaterThan(0);
    expect(findingsByPage.get(server.barUrl) ?? 0).toBeGreaterThan(0);

    const fooHasImageAlt = state.findings.some(
      (f) => f.pageUrl === server.fooUrl && f.ruleId === "image-alt",
    );
    const barHasLinkName = state.findings.some(
      (f) => f.pageUrl === server.barUrl && f.ruleId === "link-name",
    );
    expect(fooHasImageAlt).toBe(true);
    expect(barHasLinkName).toBe(true);
  });

  it("HTML report renders the page-filter dropdown for fixture multi-page", () => {
    const html = renderHtml(state);
    expect(html).toContain('id="page-filter-select"');
    expect(html).toContain(`<option value="${server.fooUrl}"`);
    expect(html).toContain(`<option value="${server.barUrl}"`);
    expect(html).toContain('id="a11y-page-counts"');

    const m = html.match(
      /<script id="a11y-page-counts"[^>]*>([\s\S]*?)<\/script>/,
    );
    expect(m).toBeTruthy();
    const counts = JSON.parse(m![1]!);
    expect(counts).toHaveProperty("__all__");
    expect(counts).toHaveProperty(server.fooUrl);
    expect(counts).toHaveProperty(server.barUrl);

    expect(html).toContain(`data-page-url="${server.fooUrl}"`);
    expect(html).toContain(`data-page-url="${server.barUrl}"`);
  });

  it("HTML report omits the filter for a single-page fixture", () => {
    const singlePageState: ScanState = {
      ...state,
      evidence: [state.evidence[0]!],
      findings: state.findings.filter((f) => f.pageUrl === server.fooUrl),
      meta: {
        ...state.meta,
        pagesScanned: [server.fooUrl],
      },
    };
    const html = renderHtml(singlePageState);
    expect(html).not.toContain('id="page-filter-select"');
    expect(html).not.toContain('id="a11y-page-counts"');
  });

  it("Markdown report includes the per-page findings table for multi-page fixture", () => {
    const md = renderMarkdown(state);
    expect(md).toContain("## Pages scanned (2)");
    expect(md).toContain(server.fooUrl);
    expect(md).toContain(server.barUrl);
    expect(md).toContain("(2 pages)");
  });
});
