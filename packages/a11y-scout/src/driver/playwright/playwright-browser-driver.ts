import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import type {
  BrowserDriver,
  BrowserContextDriver,
  BrowserLaunchOptions,
  NewContextOptions,
} from "../interfaces.js";
import { PlaywrightContextDriver } from "./playwright-context-driver.js";

/**
 * Owns a single Chromium `Browser` lifecycle. The CLI's runtime scanner
 * and crawler both reuse this — one browser per top-level scan, one or
 * more contexts per browser (today: exactly one).
 */
export class PlaywrightBrowserDriver implements BrowserDriver {
  constructor(private readonly browser: Browser) {}

  async newContext(opts: NewContextOptions = {}): Promise<BrowserContextDriver> {
    const contextOpts: Record<string, unknown> = {};
    if (opts.authStatePath && existsSync(opts.authStatePath)) {
      contextOpts.storageState = opts.authStatePath;
    }
    if (opts.ignoreHttpsErrors) {
      contextOpts.ignoreHTTPSErrors = true;
    }
    const context = await this.browser.newContext(contextOpts);
    return new PlaywrightContextDriver(context);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

/**
 * Public factory — launch a Chromium instance and wrap it as a
 * `BrowserDriver`. The CLI, crawler, and login flow consume this.
 */
export async function launchPlaywrightBrowser(
  opts: BrowserLaunchOptions = {},
): Promise<BrowserDriver> {
  const browser = await chromium.launch({
    headless: opts.headless !== false,
    args: opts.ignoreHttpsErrors ? ["--ignore-certificate-errors"] : undefined,
  });
  return new PlaywrightBrowserDriver(browser);
}
