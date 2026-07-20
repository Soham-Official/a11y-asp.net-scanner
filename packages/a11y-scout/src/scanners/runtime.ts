import type {
  Finding,
  PageEvidence,
  ScanLevel,
  WaitUntil,
  PassedRule,
  InapplicableRule,
} from "../types.js";
import type { LlmProvider } from "../llm/provider.js";
import type {
  BrowserDriver,
  BrowserContextDriver,
  PageDriver,
} from "../driver/interfaces.js";
import { launchPlaywrightBrowser } from "../driver/playwright/index.js";
import { scanPage } from "../agents/scan-page.js";
import { createLlmProvider } from "../llm/factory.js";

export interface RuntimeScanOptions {
  url: string;
  level: ScanLevel;
  /** Shared LLM provider. If omitted, an auto-detected provider is created. */
  llm?: LlmProvider;
  maxCostUsd?: number;
  authStatePath?: string;
  waitUntil?: WaitUntil;
  waitMs?: number;
  collectEvidence?: boolean;
  headed?: boolean;
  ignoreHttpsErrors?: boolean;
  keyboard?: boolean;
  // Phase-2 focus checks (off-screen focus, focus-indicator, modal leak).
  focusChecks?: boolean;
  // Disable tier-2 focus-indicator screenshots on a single page (no-op under crawl — crawl auto-disables tier-2 for cost).
  noFocusIndicatorScreenshots?: boolean;
  // Set by the crawler so the keyboard scanner disables the screenshot tier.
  inCrawl?: boolean;
  /** Suppress fix-html LLM calls. */
  aiFix?: boolean;
}

export interface RuntimeScanResult {
  findings: Finding[];
  evidence: PageEvidence;
  passes: PassedRule[];
  inapplicable: InapplicableRule[];
}

// TAGS_FOR_LEVEL is owned by axe-config.ts as part of the shared axe builder
// configuration. Re-exported here so existing consumers (the public barrel,
// any external import of "a11y-scout"/runtime) keep working unchanged.
export { TAGS_FOR_LEVEL } from "./axe-config.js";

/**
 * Single-page entry point. Owns its own browser. Keep using this for the
 * non-crawl path so we don't pay browser-launch cost in tests / fixtures.
 */
export async function scanUrlRuntime(
  opts: RuntimeScanOptions,
): Promise<RuntimeScanResult> {
  let browser: BrowserDriver | undefined;
  try {
    browser = await launchPlaywrightBrowser({
      headless: !opts.headed,
      ignoreHttpsErrors: opts.ignoreHttpsErrors,
    });
    const context = await browser.newContext({
      authStatePath: opts.authStatePath,
      ignoreHttpsErrors: opts.ignoreHttpsErrors,
    });
    const page = await context.newPage();
    const result = await analyzeLoadedPage({
      page,
      url: opts.url,
      level: opts.level,
      llm: opts.llm ?? createLlmProvider({ maxCostUsd: opts.maxCostUsd }),
      maxCostUsd: opts.maxCostUsd,
      waitUntil: opts.waitUntil,
      waitMs: opts.waitMs,
      keyboard: opts.keyboard,
      focusChecks: opts.focusChecks,
      noFocusIndicatorScreenshots: opts.noFocusIndicatorScreenshots,
      inCrawl: false,
      aiFix: opts.aiFix,
    });
    await context.close();
    return result;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Open a browser context, optionally restoring saved auth state. Exposed
 * so the crawler can reuse one context across N pages.
 */
export async function launchContext(
  browser: BrowserDriver,
  authStatePath?: string,
  ignoreHttpsErrors?: boolean,
): Promise<BrowserContextDriver> {
  return browser.newContext({
    authStatePath,
    ignoreHttpsErrors,
  });
}

/**
 * Navigate `page` to `url`, then delegate the entire per-page scan to
 * `scanPage`. Pure: doesn't own the browser lifecycle. Crawler uses this
 * in a loop with a single context.
 *
 * The post-goto pipeline (axe + incomplete + reflow + keyboard + evidence +
 * validate + AAA + content-quality + fix-html) lives in `agents/scan-page.ts`
 * so the Playwright fixture and CLI run identical logic.
 */
export async function analyzeLoadedPage(args: {
  page: PageDriver;
  url: string;
  level: ScanLevel;
  /** Shared LLM provider. If omitted, an auto-detected provider is created. */
  llm?: LlmProvider;
  maxCostUsd?: number;
  waitUntil?: WaitUntil;
  waitMs?: number;
  keyboard?: boolean;
  focusChecks?: boolean;
  noFocusIndicatorScreenshots?: boolean;
  inCrawl?: boolean;
  aiFix?: boolean;
}): Promise<RuntimeScanResult> {
  const { page, url, waitUntil = "load", waitMs } = args;
  await page.goto(url, { waitUntil, timeout: 60_000 });

  // Readiness (`networkidle` + `waitMs` delay) is owned by `scanPage` so the
  // CLI, crawler, and the Playwright fixture all see the same DOM state. Do
  // not duplicate the wait here.
  return scanPage({
    page,
    url,
    level: args.level,
    llm: args.llm ?? createLlmProvider({ maxCostUsd: args.maxCostUsd }),
    maxCostUsd: args.maxCostUsd,
    keyboard: args.keyboard,
    focusChecks: args.focusChecks,
    noFocusIndicatorScreenshots: args.noFocusIndicatorScreenshots,
    inCrawl: args.inCrawl === true,
    aiFix: args.aiFix,
    extraWaitMs: waitMs,
  });
}

/**
 * Collect page evidence for AAA semantic analysis and the A/AA content-quality
 * agent. Exported for use by the Playwright fixture.
 *
 * Caps every list to bound prompt size and LLM cost. Never reads input `.value`
 * to avoid leaking user-entered data on authenticated pages.
 */
export async function collectPageEvidence(
  page: PageDriver,
  url: string,
): Promise<PageEvidence> {
  const title = await page.title().catch(() => undefined);
  const textSample = await page
    .evaluate<string>(() => document.body.innerText.slice(0, 4000))
    .catch(() => undefined);
  const links = await page
    .evaluate<Array<{ href: string; text: string }>>(() =>
      Array.from(document.querySelectorAll("a"))
        .slice(0, 60)
        .map((a) => ({
          href: (a as HTMLAnchorElement).href,
          text: (a.textContent ?? "").trim().slice(0, 200),
        }))
        .filter((l) => l.href && l.text),
    )
    .catch(() => [] as Array<{ href: string; text: string }>);
  const headings = await page
    .evaluate<Array<{ level: number; text: string }>>(() =>
      Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
        .slice(0, 60)
        .map((h) => ({
          level: Number(h.tagName.slice(1)),
          text: (h.textContent ?? "").trim().slice(0, 200),
        })),
    )
    .catch(() => [] as Array<{ level: number; text: string }>);

  const htmlLang = await page
    .evaluate<string | undefined>(
      () => document.documentElement.getAttribute("lang") || undefined,
    )
    .catch(() => undefined);

  const images = await page
    .evaluate<Array<{ alt: string; src: string; hasAlt: boolean }>>(() =>
      Array.from(document.querySelectorAll("img"))
        .slice(0, 50)
        .map((img) => {
          const el = img as HTMLImageElement;
          return {
            alt: (el.getAttribute("alt") ?? "").slice(0, 200),
            src: (el.currentSrc || el.src || "").slice(0, 300),
            hasAlt: el.hasAttribute("alt"),
          };
        }),
    )
    .catch(() => [] as Array<{ alt: string; src: string; hasAlt: boolean }>);

  const formFields = await page
    .evaluate<
      Array<{
        tag: string;
        type?: string;
        id?: string;
        name?: string;
        autocomplete?: string;
        placeholder?: string;
        labelText?: string;
        accessibleName?: string;
        describedByText?: string;
        required?: boolean;
      }>
    >(() => {
      const norm = (s: string | null | undefined) =>
        (s ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      const labelTextFor = (el: Element): string => {
        const id = el.getAttribute("id");
        if (id) {
          const escaped = id.replace(/"/g, '\\"');
          const lbl = document.querySelector(`label[for="${escaped}"]`);
          if (lbl) return norm(lbl.textContent);
        }
        const wrappingLabel = el.closest("label");
        if (wrappingLabel) {
          // Subtract the field's own visible text (none for inputs; harmless).
          return norm(wrappingLabel.textContent);
        }
        return "";
      };
      const describedByText = (el: Element): string => {
        const ids = (el.getAttribute("aria-describedby") || "")
          .split(/\s+/)
          .filter(Boolean);
        const parts: string[] = [];
        for (const id of ids) {
          const escaped = id.replace(/"/g, '\\"');
          const node = document.querySelector(`#${CSS.escape(escaped)}`);
          if (node) parts.push(norm(node.textContent));
        }
        return parts.join(" ").slice(0, 300);
      };
      const accessibleName = (el: Element, label: string): string => {
        const labelledBy = (el.getAttribute("aria-labelledby") || "")
          .split(/\s+/)
          .filter(Boolean);
        if (labelledBy.length) {
          const parts: string[] = [];
          for (const id of labelledBy) {
            const node = document.querySelector(`#${CSS.escape(id)}`);
            if (node) parts.push(norm(node.textContent));
          }
          if (parts.length) return parts.join(" ").slice(0, 200);
        }
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) return norm(ariaLabel);
        if (label) return label;
        const placeholder = el.getAttribute("placeholder");
        if (placeholder) return norm(placeholder);
        return "";
      };
      return Array.from(
        document.querySelectorAll("input, select, textarea"),
      )
        .slice(0, 30)
        .map((el) => {
          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute("type") || undefined;
          // Skip hidden inputs — they don't contribute to a11y judgement.
          const label = labelTextFor(el);
          return {
            tag,
            type,
            id: el.getAttribute("id") || undefined,
            name: el.getAttribute("name") || undefined,
            autocomplete: el.getAttribute("autocomplete") || undefined,
            placeholder: el.getAttribute("placeholder") || undefined,
            labelText: label || undefined,
            accessibleName: accessibleName(el, label) || undefined,
            describedByText: describedByText(el) || undefined,
            required: el.hasAttribute("required") || undefined,
          };
        })
        .filter((f) => f.type !== "hidden");
    })
    .catch(
      () =>
        [] as Array<{
          tag: string;
          type?: string;
          id?: string;
          name?: string;
          autocomplete?: string;
          placeholder?: string;
          labelText?: string;
          accessibleName?: string;
          describedByText?: string;
          required?: boolean;
        }>,
    );

  const errorMessages = await page
    .evaluate<
      Array<{ text: string; role?: string; nearFieldName?: string }>
    >(() => {
      const norm = (s: string | null | undefined) =>
        (s ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
      const sel =
        '[role="alert"], [aria-live="assertive"], [aria-live="polite"], ' +
        '.error, .invalid, .field-error, [aria-invalid="true"]';
      const out: Array<{
        text: string;
        role?: string;
        nearFieldName?: string;
      }> = [];
      const seen = new Set<string>();
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const text = norm(el.textContent);
        if (!text) continue;
        if (seen.has(text)) continue;
        seen.add(text);
        const role = el.getAttribute("role") || undefined;
        // Try to associate to the nearest labelled form field.
        let nearFieldName: string | undefined;
        const form = el.closest("form");
        if (form) {
          const field = form.querySelector(
            "input, select, textarea",
          ) as HTMLElement | null;
          if (field) {
            nearFieldName =
              field.getAttribute("name") || field.getAttribute("id") || undefined;
          }
        }
        out.push({ text, role, nearFieldName });
        if (out.length >= 20) break;
      }
      return out;
    })
    .catch(
      () =>
        [] as Array<{
          text: string;
          role?: string;
          nearFieldName?: string;
        }>,
    );

  const langParts = await page
    .evaluate<Array<{ lang: string; text: string }>, string | undefined>(
      (pageLang) => {
        const norm = (s: string | null | undefined) =>
          (s ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
        const out: Array<{ lang: string; text: string }> = [];
        for (const el of Array.from(document.querySelectorAll("[lang]"))) {
          if (el === document.documentElement) continue;
          const lang = el.getAttribute("lang") || "";
          if (!lang) continue;
          if (pageLang && lang === pageLang) continue;
          const text = norm(el.textContent);
          if (!text) continue;
          out.push({ lang, text });
          if (out.length >= 15) break;
        }
        return out;
      },
      htmlLang,
    )
    .catch(() => [] as Array<{ lang: string; text: string }>);

  const instructions = await page
    .evaluate<string[]>(() => {
      const norm = (s: string | null | undefined) =>
        (s ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
      const out: string[] = [];
      const seen = new Set<string>();
      const consider = (s: string) => {
        if (!s) return;
        if (seen.has(s)) return;
        seen.add(s);
        out.push(s);
      };
      // Text immediately preceding a <form>.
      for (const form of Array.from(document.querySelectorAll("form"))) {
        const prev = form.previousElementSibling;
        if (prev && /^(p|div|span|h\d)$/i.test(prev.tagName)) {
          consider(norm(prev.textContent));
        }
        // Direct text descendants inside the form that are not form controls.
        for (const child of Array.from(form.children)) {
          const tag = child.tagName.toLowerCase();
          if (
            tag === "input" ||
            tag === "select" ||
            tag === "textarea" ||
            tag === "button" ||
            tag === "label" ||
            tag === "fieldset"
          ) {
            continue;
          }
          consider(norm(child.textContent));
          if (out.length >= 10) break;
        }
        if (out.length >= 10) break;
      }
      return out.slice(0, 10);
    })
    .catch(() => [] as string[]);

  return {
    url,
    title,
    textSample,
    links,
    headings,
    htmlLang,
    images,
    formFields,
    errorMessages,
    langParts,
    instructions,
  };
}
