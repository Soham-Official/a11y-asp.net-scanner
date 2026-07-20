import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { remote } from "webdriverio";
import { chromium, type Browser as PwBrowser } from "playwright";
import {
  buildAxeConfig,
  createPlaywrightPageDriver,
  type PageDriver,
} from "a11y-scout";
import { createWebdriverioPageDriver } from "../webdriverio-page-driver.js";

/**
 * Behavioral parity + conformance for the WebdriverIO PageDriver adapter.
 *
 * The whole value of a second driver is that it produces the SAME engine
 * results as Playwright. This suite drives one shared fixture through a real
 * WebdriverIO Chrome session and asserts:
 *   - `runAxe` returns populated results whose rule IDs MATCH the Playwright
 *     driver's on the same page (the core drift guard);
 *   - the `evaluate` string-branch works (the keyboard scanner ships JS as
 *     strings — this is the single most fragile adapter detail);
 *   - `pressKey("Shift+Tab")` moves focus backward (chord decomposition);
 *   - `setViewportSize`/`viewportSize` round-trips through the sync cache.
 *
 * Runs headless with no network egress; fits the mock-mode CI gate.
 */

// Serve the fixture over HTTP. Headless Chrome denies `file://` reads in some
// environments (ERR_ACCESS_DENIED), and HTTP is closer to how the scanner runs
// against real pages anyway.
const fixtureHtml = readFileSync(
  resolve(fileURLToPath(import.meta.url), "../fixtures/parity.html"),
  "utf8",
);

let server: Server;
let fixtureUrl: string;
let wdioBrowser: WebdriverIO.Browser;
let pwBrowser: PwBrowser;
let wdioDriver: PageDriver;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fixtureHtml);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  fixtureUrl = `http://127.0.0.1:${port}/`;

  wdioBrowser = await remote({
    logLevel: "error",
    capabilities: {
      browserName: "chrome",
      "goog:chromeOptions": {
        args: ["--headless=new", "--no-sandbox", "--disable-gpu"],
      },
    },
  });
  await wdioBrowser.url(fixtureUrl);
  wdioDriver = await createWebdriverioPageDriver(wdioBrowser);

  pwBrowser = await chromium.launch();
});

afterAll(async () => {
  await wdioBrowser?.deleteSession().catch(() => {});
  await pwBrowser?.close().catch(() => {});
  await new Promise<void>((r) => server?.close(() => r()));
});

/** axe rule IDs (violations) from the Playwright driver on the same fixture. */
async function playwrightAxeRuleIds(): Promise<Set<string>> {
  const page = await pwBrowser.newPage();
  await page.goto(fixtureUrl);
  const driver = createPlaywrightPageDriver(page);
  const results = await driver.runAxe(buildAxeConfig("AA", {}));
  await page.close();
  return new Set(results.violations.map((v) => v.id));
}

describe("WebdriverioPageDriver conformance", () => {
  it("runAxe returns populated results and matches Playwright's rule IDs", async () => {
    const wdioResults = await wdioDriver.runAxe(buildAxeConfig("AA", {}));
    const wdioIds = new Set(wdioResults.violations.map((v) => v.id));

    // The fixture has deliberate violations, so axe must report some.
    expect(wdioIds.size).toBeGreaterThan(0);
    // The two deterministic ones we planted.
    expect(wdioIds.has("image-alt")).toBe(true);
    expect(wdioIds.has("button-name")).toBe(true);

    // Parity: same engine config → same violation rule IDs across drivers.
    const pwIds = await playwrightAxeRuleIds();
    expect([...wdioIds].sort()).toEqual([...pwIds].sort());
  });

  it("evaluate runs the string (function-body) branch used by the keyboard scanner", async () => {
    // The keyboard scanner ships self-invoking IIFE strings; the adapter must
    // wrap them so WebDriver (which treats a string as a function body) returns
    // the value.
    const count = await wdioDriver.evaluate<number>(
      `(() => document.querySelectorAll("button, a[href], input").length)()`,
    );
    // Fixture has 2 buttons (b1, b2), 1 anchor (a1), 1 input (i1).
    expect(count).toBe(4);
  });

  it("evaluate string-branch handles a MULTI-LINE IIFE returning an array", async () => {
    // Regression guard: the real keyboard-scanner payloads are multi-line IIFEs
    // that begin on a fresh line. A naive `return ` + source triggers automatic
    // semicolon insertion (`return;\n(...)` → undefined). This mirrors
    // enumerateFocusables' shape and must return the actual array.
    const tags = await wdioDriver.evaluate<string[]>(/* js */ `
      (() => {
        const els = Array.from(
          document.querySelectorAll('button, a[href], input'),
        );
        return els.map((e) => e.tagName.toLowerCase());
      })()
    `);
    expect(Array.isArray(tags)).toBe(true);
    expect(tags.length).toBe(4);
    expect(tags).toContain("input");
    expect(tags).toContain("a");
  });

  it("evaluate runs the function branch with a forwarded arg", async () => {
    const tag = await wdioDriver.evaluate<string | null, string>(
      (id) => document.getElementById(id)?.tagName ?? null,
      "i1",
    );
    expect(tag).toBe("INPUT");
  });

  it("pressKey Tab / Shift+Tab moves focus forward then backward", async () => {
    const activeId = () =>
      wdioDriver.evaluate<string>(`(() => document.activeElement?.id || "")()`);

    // Land focus on the first control, then step forward and back.
    await wdioDriver.evaluate(`(() => document.getElementById("a1").focus())()`);
    expect(await activeId()).toBe("a1");

    await wdioDriver.pressKey("Tab");
    const afterTab = await activeId();
    expect(afterTab).not.toBe("a1");

    await wdioDriver.pressKey("Shift+Tab");
    expect(await activeId()).toBe("a1");
  });

  it("setViewportSize / viewportSize round-trips through the sync cache", async () => {
    await wdioDriver.setViewportSize({ width: 800, height: 600 });
    const size = wdioDriver.viewportSize();
    expect(size).toEqual({ width: 800, height: 600 });
  });

  it("screenshot throws on a clip request (WebDriver has no region clip)", async () => {
    await expect(
      wdioDriver.screenshot({ clip: { x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toThrow(/clipped/i);
  });
});
