import { existsSync } from "node:fs";
import type { BrowserDriver, PageDriver } from "../driver/interfaces.js";
import { launchPlaywrightBrowser } from "../driver/playwright/index.js";

export interface LoginCaptureOptions {
  url: string;
  authStatePath: string;
  timeoutMs?: number;
}

/**
 * Open a real browser, let the user log in, then save the storage state.
 * V1 strategy for SSO/MFA: do this once interactively; reuse the cookie file
 * for subsequent automated scans until it expires.
 *
 * Today this uses the Playwright driver explicitly because the saved
 * storage-state format is Playwright-native. Future drivers will own
 * their own auth-capture flow (each driver's `BrowserContextDriver.saveAuthState`
 * writes its native format).
 */
export async function captureAuthState(
  opts: LoginCaptureOptions,
): Promise<void> {
  let browser: BrowserDriver | undefined;
  try {
    browser = await launchPlaywrightBrowser({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log(
      `\n[a11y-scout] Opening ${opts.url} in headed mode.\n` +
        `Please log in. The window will close automatically once you reach the post-login page.\n`,
    );

    await page.goto(opts.url, { waitUntil: "domcontentloaded" });
    await waitUntilLoggedIn(page, opts.timeoutMs ?? 5 * 60 * 1000);

    await context.saveAuthState(opts.authStatePath);
    console.log(`[a11y-scout] Auth state saved to ${opts.authStatePath}\n`);

    await context.close();
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Poll the page URL until it no longer matches `/login/i`. Half-second
 * interval is more than fast enough for an interactive login flow and
 * keeps the driver interface narrow (no `waitForFunction` method needed).
 */
async function waitUntilLoggedIn(
  page: PageDriver,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loggedIn = await page
      .evaluate<boolean>(() => !window.location.href.toLowerCase().includes("login"))
      .catch(() => false);
    if (loggedIn) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for login completion after ${timeoutMs}ms`);
}

export function authStateExists(path: string | undefined): boolean {
  return Boolean(path) && existsSync(path!);
}
