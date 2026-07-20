/**
 * Browser-automation abstraction. The engine (scanners, agents) consumes
 * these interfaces and never imports a concrete framework. Each automation
 * framework (Playwright today, WebdriverIO/Puppeteer/Selenium later) ships
 * a concrete implementation under `driver/<framework>/`.
 *
 * The shapes are intentionally narrow — only what the existing scanners
 * actually use. Adding a method requires it to be implementable across
 * every target framework, so do so only when a scanner genuinely needs it.
 */

import type { AxeResults } from "axe-core";
import type { ScanLevel } from "../types.js";

export type WaitUntilLoadState =
  | "load"
  | "domcontentloaded"
  | "networkidle"
  | "commit";

export type LoadStateWait = "load" | "domcontentloaded" | "networkidle";

export interface ViewportSize {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotOptions {
  type?: "png";
  clip?: Rect;
}

export interface GotoOptions {
  waitUntil?: WaitUntilLoadState;
  timeout?: number;
}

export interface WaitForLoadStateOptions {
  timeout?: number;
}

export interface AddStyleTagOptions {
  content: string;
}

export interface EmulateMediaOptions {
  reducedMotion?: "reduce" | "no-preference";
}

export type FocusKey = "Tab" | "Shift+Tab" | "Escape";

/**
 * Configuration for an axe-core run. The engine builds this; the driver's
 * axe runner consumes it. Keeps axe selection in lockstep across drivers.
 */
export interface AxeRunConfig {
  /** Tag filter — e.g., `["wcag2a", "wcag2aa", "best-practice"]`. */
  tags: string[];
  /** Force-enabled rules; keys override the tag filter. */
  rules: Record<string, { enabled: boolean }>;
  /** Optional restricting selector. */
  include?: string;
  /** Optional excluded selectors. */
  exclude?: string[];
}

/**
 * Per-page interface the engine uses for axe + scanners.
 *
 * Method shapes mirror Playwright's `Page` 1:1 so the existing JS payloads
 * inside `page.evaluate()` calls work unchanged. WebdriverIO/Puppeteer
 * implementations adapt; the engine never adapts.
 */
export interface PageDriver {
  /** Current URL (synchronous in Playwright). */
  url(): string;

  /** Document title; returns undefined if unavailable. */
  title(): Promise<string>;

  /** Navigate to `url`. */
  goto(url: string, opts?: GotoOptions): Promise<void>;

  /** Wait for a load state, or fall through on timeout. */
  waitForLoadState(
    state: LoadStateWait,
    opts?: WaitForLoadStateOptions,
  ): Promise<void>;

  /** Fixed-duration sleep. */
  waitForTimeout(ms: number): Promise<void>;

  /**
   * Run JS inside the page context. Accepts either a function (Playwright
   * native) or a string of JS (used by the keyboard scanner to keep the JS
   * source verbatim and avoid bundler transformations). Args are serialized
   * and forwarded as the function's arguments.
   */
  evaluate<T, Arg = unknown>(
    fnOrSource: ((arg: Arg) => T | Promise<T>) | string,
    arg?: Arg,
  ): Promise<T>;

  /** Press a single key (Tab / Shift+Tab / Escape today). */
  pressKey(key: FocusKey): Promise<void>;

  /** Capture a PNG screenshot, optionally clipped to a region. */
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;

  /** Resize the viewport. */
  setViewportSize(size: ViewportSize): Promise<void>;

  /** Current viewport size; null if unknown. */
  viewportSize(): ViewportSize | null;

  /** Inject a `<style>` tag with `content` into the page. */
  addStyleTag(opts: AddStyleTagOptions): Promise<void>;

  /** Emulate media preferences (only `reducedMotion` is used today). */
  emulateMedia(opts: EmulateMediaOptions): Promise<void>;

  /**
   * Run axe-core against this page. Implementations inject axe-core themselves
   * — engine code never injects axe. Returns the standard axe-core results
   * shape so downstream consumers stay framework-agnostic.
   */
  runAxe(config: AxeRunConfig): Promise<AxeResults>;
}

export interface NewContextOptions {
  /** Path to a previously saved auth-state file (driver-specific format). */
  authStatePath?: string;
  ignoreHttpsErrors?: boolean;
}

export interface BrowserLaunchOptions {
  headless?: boolean;
  ignoreHttpsErrors?: boolean;
}

/**
 * A single browser instance. Owns context creation and final teardown.
 */
export interface BrowserDriver {
  newContext(opts?: NewContextOptions): Promise<BrowserContextDriver>;
  close(): Promise<void>;
}

/**
 * A single browser context — analogous to an incognito session. Owns its
 * page(s) and (when applicable) an auth-state save target.
 */
export interface BrowserContextDriver {
  newPage(): Promise<PageDriver>;
  /**
   * Persist this context's storage state to `path`. Each driver writes its
   * own native format — Playwright writes Playwright `storageState` JSON,
   * future drivers may differ.
   */
  saveAuthState(path: string): Promise<void>;
  close(): Promise<void>;
}

/** Convenience helper signature for runners that build the level-tag map. */
export type AxeLevelTags = Record<ScanLevel, string[]>;
