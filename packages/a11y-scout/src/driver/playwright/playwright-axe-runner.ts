import type { Page } from "playwright";
// axe injection + run-args marshalling live in the framework-neutral
// `axe-shared` module so every driver injects the same bundle and composes
// the same context. This file owns only the Playwright-specific run call.
import type { AxeResults, RunOptions } from "axe-core";
import type { AxeRunConfig } from "../interfaces.js";
import { AXE_SOURCE, buildAxeRunArgs, injectAxeInPage } from "../axe-shared.js";

/**
 * Inject axe-core into `page` and run it under the supplied config. The
 * Playwright `Page` is intentionally accepted as a raw type here — this
 * file is the ONE place in the codebase outside the engine that talks to
 * Playwright directly. The engine consumes only `PageDriver.runAxe()`.
 */
export async function runAxeInPlaywrightPage(
  page: Page,
  config: AxeRunConfig,
): Promise<AxeResults> {
  // Inject axe-core if it isn't already present in this document.
  await page.evaluate(injectAxeInPage, AXE_SOURCE);

  const { include, exclude, runOptions } = buildAxeRunArgs(config);

  return page.evaluate(
    async ({ include, exclude, runOptions }) => {
      const w = window as unknown as {
        axe: { run: (ctx: unknown, opts: RunOptions) => Promise<AxeResults> };
      };
      // Compose axe context. If `include` is null and `exclude` is empty,
      // pass `document` so axe runs against the whole page.
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
      return w.axe.run(context, runOptions);
    },
    { include, exclude, runOptions },
  );
}
