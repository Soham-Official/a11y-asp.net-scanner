/**
 * Framework-neutral axe-core helpers shared by every concrete driver.
 *
 * `axe-core` ships its full browser bundle as `axe.source`. Drivers inject
 * that string into the page and call `axe.run()` in-page. This module owns
 * the pieces that must stay identical across drivers — the axe bundle
 * (`AXE_SOURCE`), the run-args marshalling (`buildAxeRunArgs`), and the
 * injection guard (`injectAxeInPage`) — so a second driver (WebdriverIO,
 * Puppeteer, …) cannot silently drift from Playwright.
 *
 * The in-page *run* call itself is intentionally NOT shared: Playwright's
 * `page.evaluate(async …)` auto-awaits the returned promise, whereas
 * WebDriver's execute-async needs an explicit `done` callback, so the two
 * run shapes genuinely differ. Everything up to that boundary lives here.
 */

import axe from "axe-core";
import type { RunOptions } from "axe-core";
import type { AxeRunConfig } from "./interfaces.js";

/** The axe-core browser bundle, injected verbatim into the page. */
export const AXE_SOURCE: string = (axe as unknown as { source: string }).source;

/**
 * Serializable arguments forwarded into the page for an axe run. The in-page
 * context is composed from `include`/`exclude` by each driver's run call
 * (that step needs the page's `document`, so it cannot happen here).
 */
export interface AxeRunArgs {
  include: string | null;
  exclude: string[];
  runOptions: RunOptions;
}

/**
 * Marshal an {@link AxeRunConfig} into the serializable pieces a driver
 * forwards into the page. Pure — no framework or DOM dependency.
 */
export function buildAxeRunArgs(config: AxeRunConfig): AxeRunArgs {
  return {
    include: config.include ?? null,
    exclude: config.exclude ?? [],
    runOptions: {
      runOnly: { type: "tag", values: config.tags },
      rules: config.rules,
    },
  };
}

/**
 * Injection guard, executed **inside the page**. Idempotent: appends a
 * `<script>` carrying the axe bundle only if `window.axe` is absent. Kept
 * self-contained (references only its argument + page globals) so it
 * serializes cleanly through both Playwright's `evaluate` and WebDriver's
 * `execute`.
 */
export function injectAxeInPage(source: string): void {
  const w = window as unknown as { axe?: unknown };
  if (w.axe) return;
  const script = document.createElement("script");
  script.textContent = source;
  document.head.appendChild(script);
}
