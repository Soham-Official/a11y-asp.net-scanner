import type { Page } from "playwright";
import type { AxeResults } from "axe-core";
import type {
  AddStyleTagOptions,
  AxeRunConfig,
  EmulateMediaOptions,
  FocusKey,
  GotoOptions,
  LoadStateWait,
  PageDriver,
  ScreenshotOptions,
  ViewportSize,
  WaitForLoadStateOptions,
} from "../interfaces.js";
import { runAxeInPlaywrightPage } from "./playwright-axe-runner.js";

/**
 * Adapter that exposes a Playwright `Page` as a framework-agnostic
 * `PageDriver`. Methods are 1:1 pass-throughs except for:
 *   - `pressKey`        → `page.keyboard.press`
 *   - `evaluate(str)`   → Playwright accepts a function reference *or* a
 *                         string of JS (1 evaluation arg). Both branches
 *                         are needed because the keyboard scanner ships
 *                         large JS payloads as template-literal strings
 *                         to avoid tsx/__name helper injection.
 *   - `runAxe(config)`  → injects axe-core directly via `page.evaluate`,
 *                         replacing `@axe-core/playwright`.
 */
export class PlaywrightPageDriver implements PageDriver {
  constructor(private readonly page: Page) {}

  /** Escape hatch for callers that still need the raw Playwright Page. */
  raw(): Page {
    return this.page;
  }

  url(): string {
    return this.page.url();
  }

  async title(): Promise<string> {
    return this.page.title();
  }

  async goto(url: string, opts?: GotoOptions): Promise<void> {
    await this.page.goto(url, opts);
  }

  async waitForLoadState(
    state: LoadStateWait,
    opts?: WaitForLoadStateOptions,
  ): Promise<void> {
    await this.page.waitForLoadState(state, opts);
  }

  async waitForTimeout(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async evaluate<T, Arg = unknown>(
    fnOrSource: ((arg: Arg) => T | Promise<T>) | string,
    arg?: Arg,
  ): Promise<T> {
    // Playwright's overloads are tight; cast through `unknown` so this thin
    // adapter accepts the same (fn | source, arg?) shape engine code uses.
    const p = this.page as unknown as {
      evaluate: (fn: unknown, arg?: unknown) => Promise<T>;
    };
    if (typeof fnOrSource === "string") {
      return p.evaluate(fnOrSource);
    }
    if (arg === undefined) {
      return p.evaluate(fnOrSource);
    }
    return p.evaluate(fnOrSource, arg);
  }

  async pressKey(key: FocusKey): Promise<void> {
    await this.page.keyboard.press(key);
  }

  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    return this.page.screenshot({
      type: opts?.type ?? "png",
      clip: opts?.clip,
    });
  }

  async setViewportSize(size: ViewportSize): Promise<void> {
    await this.page.setViewportSize(size);
  }

  viewportSize(): ViewportSize | null {
    return this.page.viewportSize();
  }

  async addStyleTag(opts: AddStyleTagOptions): Promise<void> {
    await this.page.addStyleTag({ content: opts.content });
  }

  async emulateMedia(opts: EmulateMediaOptions): Promise<void> {
    await this.page.emulateMedia(opts);
  }

  async runAxe(config: AxeRunConfig): Promise<AxeResults> {
    return runAxeInPlaywrightPage(this.page, config);
  }
}

/** Public factory — wrap a Playwright `Page` for engine consumption. */
export function createPlaywrightPageDriver(page: Page): PageDriver {
  return new PlaywrightPageDriver(page);
}
