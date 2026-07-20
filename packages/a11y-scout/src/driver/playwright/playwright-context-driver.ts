import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserContext } from "playwright";
import type { BrowserContextDriver, PageDriver } from "../interfaces.js";
import { createPlaywrightPageDriver } from "./playwright-page-driver.js";

/**
 * Wraps a Playwright `BrowserContext`. Saves auth state in Playwright's
 * native `storageState` JSON format — the only place the engine touches
 * a driver-specific auth format. Future drivers (WebdriverIO, Selenium)
 * will own their own format under `saveAuthState`.
 */
export class PlaywrightContextDriver implements BrowserContextDriver {
  constructor(private readonly context: BrowserContext) {}

  async newPage(): Promise<PageDriver> {
    const page = await this.context.newPage();
    return createPlaywrightPageDriver(page);
  }

  async saveAuthState(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const state = await this.context.storageState();
    await writeFile(path, JSON.stringify(state, null, 2));
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
