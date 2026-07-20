import type {
  CrawlOptions,
  Finding,
  PageEvidence,
  ScanLevel,
  WaitUntil,
  PassedRule,
  InapplicableRule,
} from "../types.js";
import type { LlmProvider } from "../llm/provider.js";
import type { BrowserDriver } from "../driver/interfaces.js";
import { launchPlaywrightBrowser } from "../driver/playwright/index.js";
import { analyzeLoadedPage, launchContext } from "./runtime.js";
import {
  aggregatePages,
  type PerPageSlice,
} from "../agents/aggregate-pages.js";

export interface CrawlScanOptions {
  startUrl: string;
  level: ScanLevel;
  crawl: CrawlOptions;
  llm: LlmProvider;
  maxCostUsd?: number;
  authStatePath?: string;
  waitUntil?: WaitUntil;
  waitMs?: number;
  headed?: boolean;
  ignoreHttpsErrors?: boolean;
  keyboard?: boolean;
  focusChecks?: boolean;
  noFocusIndicatorScreenshots?: boolean;
  aiFix?: boolean;
  /** Called when each page finishes scanning. Useful for live CLI progress. */
  onProgress?: (info: {
    url: string;
    pagesDone: number;
    pagesTotal: number;
    findingsThisPage: number;
  }) => void;
}

export interface CrawlScanResult {
  findings: Finding[];
  evidence: PageEvidence[];
  pagesScanned: string[];
  pagesSkipped: { url: string; reason: string }[];
  passes: PassedRule[];
  inapplicable: InapplicableRule[];
}

/**
 * Same-origin BFS crawl. Reuses one browser + one context across all pages
 * so we don't pay launch cost per URL. Honors --max-pages, --max-depth,
 * --include/--exclude regexes. Cross-origin links are dropped silently.
 *
 * Intentionally NOT in V1.1:
 *   - robots.txt honoring (V1.2 -- we already keep crawls small by default)
 *   - parallelism (sequential keeps the host polite + simplifies error handling)
 *   - sitemap.xml seeding (V1.2)
 */
export async function crawlAndScan(
  opts: CrawlScanOptions,
): Promise<CrawlScanResult> {
  const start = normalizeUrl(opts.startUrl);
  if (!start) {
    throw new Error(`Invalid start URL: ${opts.startUrl}`);
  }
  const startOrigin = new URL(start).origin;

  const includeRe = opts.crawl.includePattern
    ? new RegExp(opts.crawl.includePattern)
    : undefined;
  const excludeRe = opts.crawl.excludePattern
    ? new RegExp(opts.crawl.excludePattern)
    : undefined;

  type FrontierEntry = { url: string; depth: number };
  const frontier: FrontierEntry[] = [{ url: start, depth: 0 }];
  const seen = new Set<string>([start]);

  const slices: PerPageSlice[] = [];
  const pagesSkipped: { url: string; reason: string }[] = [];

  let browser: BrowserDriver | undefined;
  try {
    browser = await launchPlaywrightBrowser({
      headless: !opts.headed,
      ignoreHttpsErrors: opts.ignoreHttpsErrors,
    });
    const context = await launchContext(
      browser,
      opts.authStatePath,
      opts.ignoreHttpsErrors,
    );
    const page = await context.newPage();

    while (frontier.length > 0 && slices.length < opts.crawl.maxPages) {
      const next = frontier.shift()!;
      try {
        const result = await analyzeLoadedPage({
          page,
          url: next.url,
          level: opts.level,
          llm: opts.llm,
          maxCostUsd: opts.maxCostUsd,
          waitUntil: opts.waitUntil,
          waitMs: opts.waitMs,
          keyboard: opts.keyboard,
          focusChecks: opts.focusChecks,
          noFocusIndicatorScreenshots: opts.noFocusIndicatorScreenshots,
          aiFix: opts.aiFix,
          // Auto-disable the focus-indicator screenshot tier under crawl so a
          // multi-page crawl never 10x's cost. The cheap style-delta walk still
          // runs and emits one per-page summary review finding.
          inCrawl: true,
        });

        slices.push({
          url: next.url,
          findings: result.findings,
          evidence: result.evidence,
          passes: result.passes,
          inapplicable: result.inapplicable,
        });

        opts.onProgress?.({
          url: next.url,
          pagesDone: slices.length,
          pagesTotal: opts.crawl.maxPages,
          findingsThisPage: result.findings.length,
        });

        if (next.depth < opts.crawl.maxDepth) {
          for (const link of result.evidence.links) {
            const candidate = normalizeUrl(link.href, next.url);
            if (!candidate) continue;
            if (seen.has(candidate)) continue;
            if (new URL(candidate).origin !== startOrigin) continue;
            if (includeRe && !includeRe.test(candidate)) continue;
            if (excludeRe && excludeRe.test(candidate)) continue;
            if (!isLikelyHtml(candidate)) continue;
            seen.add(candidate);
            frontier.push({ url: candidate, depth: next.depth + 1 });
          }
        }
      } catch (err) {
        const reason = (err as Error).message ?? String(err);
        pagesSkipped.push({ url: next.url, reason });
        if (process.env.DEBUG) {
          console.warn(`[a11y-scout] crawl skipped ${next.url}: ${reason}`);
        }
      }
    }

    await context.close();
  } finally {
    if (browser) await browser.close();
  }

  const aggregated = aggregatePages(slices);
  return {
    findings: aggregated.findings,
    evidence: aggregated.evidence,
    pagesScanned: aggregated.pagesScanned,
    pagesSkipped,
    passes: aggregated.passes,
    inapplicable: aggregated.inapplicable,
  };
}

/**
 * Normalize a URL string for dedup + same-origin comparison.
 * - Resolves relative URLs against `base` if provided.
 * - Drops `#fragment`.
 * - Drops common analytics noise (utm_*, gclid, fbclid).
 * - Lower-cases protocol + host.
 * - Removes trailing slash from path (except root).
 *
 * Returns undefined for unparseable / non-http(s) URLs (mailto:, tel:, etc).
 */
function normalizeUrl(href: string, base?: string): string | undefined {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  u.hash = "";
  const noise = ["gclid", "fbclid", "msclkid", "_hsenc", "_hsmi"];
  for (const k of [...u.searchParams.keys()]) {
    if (k.startsWith("utm_") || noise.includes(k.toLowerCase())) {
      u.searchParams.delete(k);
    }
  }
  // Trim trailing slash on non-root paths so /about and /about/ collapse.
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

/**
 * Skip URLs that look like binary assets to avoid wasting Playwright time
 * on PDFs, images, video, archives, etc. We just check the extension; if a
 * server lies about content-type that's their problem.
 */
function isLikelyHtml(url: string): boolean {
  const cleaned = (url.split("?")[0] ?? "").split("#")[0] ?? "";
  const parts = cleaned.split(".");
  const ext = parts.length > 1 ? parts[parts.length - 1]?.toLowerCase() : undefined;
  if (!ext || ext.length > 5) return true;
  const binary = new Set([
    "pdf", "zip", "tar", "gz", "7z", "rar",
    "png", "jpg", "jpeg", "gif", "svg", "webp", "ico",
    "mp3", "mp4", "wav", "mov", "avi", "webm",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "css", "js", "json", "xml",
  ]);
  return !binary.has(ext);
}
