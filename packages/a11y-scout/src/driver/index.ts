/**
 * Public driver barrel for engine code. Scanners and agents import driver
 * types from here; the only file that imports from a concrete framework
 * subdir (e.g. `driver/playwright/`) is the CLI/fixture entry point that
 * actually owns browser launch.
 */

export type {
  PageDriver,
  BrowserDriver,
  BrowserContextDriver,
  AxeRunConfig,
  AxeLevelTags,
  ViewportSize,
  Rect,
  ScreenshotOptions,
  GotoOptions,
  WaitForLoadStateOptions,
  WaitUntilLoadState,
  LoadStateWait,
  AddStyleTagOptions,
  EmulateMediaOptions,
  FocusKey,
  NewContextOptions,
  BrowserLaunchOptions,
} from "./interfaces.js";

export {
  createPlaywrightPageDriver,
  launchPlaywrightBrowser,
} from "./playwright/index.js";

// Framework-neutral axe helpers, shared by every concrete driver (Playwright
// today, WebdriverIO/Puppeteer later) so axe injection + run-args cannot drift.
export { AXE_SOURCE, buildAxeRunArgs, injectAxeInPage } from "./axe-shared.js";
export type { AxeRunArgs } from "./axe-shared.js";
