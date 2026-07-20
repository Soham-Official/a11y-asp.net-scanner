import { Key } from "webdriverio";
import type { AxeResults, RunOptions } from "axe-core";
import {
  AXE_SOURCE,
  buildAxeRunArgs,
  injectAxeInPage,
  type AddStyleTagOptions,
  type AxeRunConfig,
  type EmulateMediaOptions,
  type FocusKey,
  type GotoOptions,
  type LoadStateWait,
  type PageDriver,
  type ScreenshotOptions,
  type ViewportSize,
  type WaitForLoadStateOptions,
} from "a11y-scout";

/** The subset of the WebdriverIO `Browser` surface this adapter uses. */
type WdioBrowser = WebdriverIO.Browser;

// WebDriver's async-script timeout defaults to 30s; axe on a large DOM can
// exceed that. Raise it once before the first axe run.
const AXE_SCRIPT_TIMEOUT_MS = 60_000;

/**
 * Adapter that exposes a WebdriverIO `Browser` as the engine's framework-
 * agnostic `PageDriver`. The engine never imports WebdriverIO — this class is
 * the only seam. It mirrors `PlaywrightPageDriver`, absorbing the places where
 * WebDriver diverges from Playwright:
 *
 *   - `evaluate(string)` — WebDriver treats a script string as a *function
 *     body* (needs `return`), unlike Playwright's *expression* semantics. The
 *     keyboard scanner ships self-invoking IIFEs as strings, so we prepend
 *     `return `.
 *   - `runAxe` — `axe.run()` is async, but WebDriver's `execute` does not await
 *     promises, so the run goes through `executeAsync` with a `done` callback.
 *   - `url()` / `viewportSize()` are synchronous in the interface but async in
 *     WebDriver, so they're served from a cache seeded by the async factory and
 *     refreshed on `goto` / `setViewportSize`.
 *   - `screenshot({ clip })` has no WebDriver equivalent, so a clipped request
 *     throws rather than silently returning a full-frame shot (which would make
 *     the focus-indicator pixel diff produce false negatives).
 *   - `emulateMedia` and `waitForLoadState("networkidle")` have no WebDriver
 *     equivalent and are documented no-ops.
 */
export class WebdriverioPageDriver implements PageDriver {
  private cachedUrl: string;
  private cachedViewport: ViewportSize | null;
  private scriptTimeoutRaised = false;

  constructor(
    private readonly browser: WdioBrowser,
    seed: { url: string; viewport: ViewportSize | null },
  ) {
    this.cachedUrl = seed.url;
    this.cachedViewport = seed.viewport;
  }

  /** Escape hatch for callers that still need the raw WebdriverIO browser. */
  raw(): WdioBrowser {
    return this.browser;
  }

  url(): string {
    return this.cachedUrl;
  }

  async title(): Promise<string> {
    return this.browser.getTitle();
  }

  async goto(url: string, opts?: GotoOptions): Promise<void> {
    // WebDriver navigation has no `waitUntil` equivalent; `browser.url()`
    // resolves once the document is loaded. `opts` is accepted for interface
    // parity but only the target URL is honored.
    void opts;
    await this.browser.url(url);
    this.cachedUrl = await this.browser.getUrl();
  }

  async waitForLoadState(
    state: LoadStateWait,
    opts?: WaitForLoadStateOptions,
  ): Promise<void> {
    // No WebDriver equivalent for load-state waits. `networkidle` is a no-op
    // (engine callers wrap this in `.catch`, so returning immediately is safe);
    // tests own their own readiness waits under WebdriverIO.
    void state;
    void opts;
  }

  async waitForTimeout(ms: number): Promise<void> {
    await this.browser.pause(ms);
  }

  async evaluate<T, Arg = unknown>(
    fnOrSource: ((arg: Arg) => T | Promise<T>) | string,
    arg?: Arg,
  ): Promise<T> {
    if (typeof fnOrSource === "string") {
      // WebDriver runs a string as a function BODY, so an explicit `return` is
      // required. The source is wrapped in parens — the engine's payloads are
      // multi-line IIFEs beginning on a fresh line, and `return\n(...)` would
      // trigger automatic semicolon insertion (returning `undefined`). The
      // parens keep the expression on the same logical line as `return`. The
      // IIFEs inline their own args, so no argument forwarding is needed here.
      return this.browser.execute(`return (${fnOrSource})`) as Promise<T>;
    }
    const script = fnOrSource as (...a: unknown[]) => T;
    if (arg === undefined) {
      return this.browser.execute(script) as Promise<T>;
    }
    return this.browser.execute(script, arg) as Promise<T>;
  }

  async pressKey(key: FocusKey): Promise<void> {
    // `browser.keys([...])` treats an array as a chord (modifiers held, then
    // released). "Shift+Tab" must be decomposed into a Shift+Tab chord — a
    // literal "Shift+Tab" string would be sent as characters.
    if (key === "Shift+Tab") {
      await this.browser.keys([Key.Shift, Key.Tab]);
      return;
    }
    const named = key === "Tab" ? Key.Tab : Key.Escape;
    await this.browser.keys([named]);
  }

  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    if (opts?.clip) {
      // WebDriver's takeScreenshot has no region clip. Returning a full-frame
      // shot here would silently break the focus-indicator tier-2 pixel diff
      // (a small element's change dilutes below threshold → false "no
      // indicator"). Throw so the caller's catch degrades to "indicator
      // present" instead of fabricating a miss.
      throw new Error(
        "WebdriverioPageDriver.screenshot: clipped screenshots are not supported under WebDriver.",
      );
    }
    const base64 = await this.browser.takeScreenshot();
    return Buffer.from(base64, "base64");
  }

  async setViewportSize(size: ViewportSize): Promise<void> {
    // NOTE: WebDriver sets the OUTER window size (incl. browser chrome), not
    // Playwright's inner viewport. Reflow (1.4.10) width measurements are
    // therefore slightly imprecise under WebdriverIO.
    await this.browser.setWindowSize(size.width, size.height);
    this.cachedViewport = size;
  }

  viewportSize(): ViewportSize | null {
    return this.cachedViewport;
  }

  async addStyleTag(opts: AddStyleTagOptions): Promise<void> {
    await this.browser.execute<void, [string]>(
      (content) => {
        const style = document.createElement("style");
        style.textContent = content;
        document.head.appendChild(style);
      },
      opts.content,
    );
  }

  async emulateMedia(opts: EmulateMediaOptions): Promise<void> {
    // No WebDriver equivalent. The determinism shim's injected stylesheet
    // (transitions/animations disabled) already provides what the scanners
    // rely on, so this is an intentional no-op.
    void opts;
  }

  async runAxe(config: AxeRunConfig): Promise<AxeResults> {
    // Inject axe-core (idempotent) using the shared guard + bundle so this
    // driver stays byte-identical to the Playwright runner.
    await this.browser.execute(injectAxeInPage, AXE_SOURCE);

    if (!this.scriptTimeoutRaised) {
      await this.browser.setTimeout({ script: AXE_SCRIPT_TIMEOUT_MS });
      this.scriptTimeoutRaised = true;
    }

    const { include, exclude, runOptions } = buildAxeRunArgs(config);

    // `axe.run` is async; WebDriver's `execute` does not await promises, so we
    // resolve it through `executeAsync`'s `done` callback.
    return this.browser.executeAsync(
      (
        include: string | null,
        exclude: string[],
        runOptions: RunOptions,
        done: (result: AxeResults) => void,
      ) => {
        const w = window as unknown as {
          axe: {
            run: (ctx: unknown, opts: RunOptions) => Promise<AxeResults>;
          };
        };
        let context: unknown;
        if (include && exclude.length > 0) {
          context = { include: [include], exclude };
        } else if (include) {
          context = { include: [include] };
        } else if (exclude.length > 0) {
          context = { exclude, include: [document as unknown as Element] };
        } else {
          context = document;
        }
        w.axe
          .run(context, runOptions)
          .then((results) => done(results))
          .catch(() => done({} as AxeResults));
      },
      include,
      exclude,
      runOptions,
    );
  }
}

/**
 * Public factory — wrap a WebdriverIO `Browser` for engine consumption. Async
 * because `url()` and `viewportSize()` must be served synchronously from the
 * interface, so their initial values are pre-fetched here (a sync constructor
 * could not `await`). `goto` / `setViewportSize` keep the cache fresh.
 */
export async function createWebdriverioPageDriver(
  browser: WdioBrowser,
): Promise<PageDriver> {
  const url = await browser.getUrl();
  let viewport: ViewportSize | null = null;
  try {
    const size = await browser.getWindowSize();
    viewport = { width: size.width, height: size.height };
  } catch {
    // Some remote/headless environments don't report window size; the engine
    // treats null as "unknown" (interface-legal).
    viewport = null;
  }
  return new WebdriverioPageDriver(browser, { url, viewport });
}
