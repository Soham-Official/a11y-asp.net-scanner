import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding, ScanState, Severity } from "../types.js";
import { summarizeFindings } from "../agents/graph.js";
import { getIncompleteGuidance } from "../incomplete-guidance.js";
import { understandingUrlForSc } from "../wcag.js";
import {
  manualAuditsByLevel,
  manualAuditsCount,
  type ManualAudit,
} from "./manual-audits.js";

const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: "Blocker",
  severe: "Severe",
  major: "Major",
  minor: "Minor",
  review: "AI Review",
};

const SEVERITY_HEX: Record<Severity, string> = {
  blocker: "#dc2626",
  severe: "#ea580c",
  major: "#d97706",
  minor: "#65a30d",
  review: "#2563eb",
};

const TAG_DISPLAY_NAME: Record<string, string> = {
  a: "Link",
  button: "Button",
  img: "Image",
  input: "Input",
  select: "Select",
  textarea: "Textarea",
  form: "Form",
  label: "Label",
  nav: "Navigation",
  header: "Header",
  footer: "Footer",
  main: "Main",
  article: "Article",
  section: "Section",
  aside: "Aside",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  h4: "Heading 4",
  h5: "Heading 5",
  h6: "Heading 6",
  iframe: "Frame",
  video: "Video",
  audio: "Audio",
  table: "Table",
  th: "Table Header",
  td: "Table Cell",
  ul: "List",
  ol: "Ordered List",
  li: "List Item",
  dialog: "Dialog",
  svg: "SVG",
  canvas: "Canvas",
};

interface TechnicalDetails {
  elementId?: string;
  classes: string[];
  selector?: string;
  xpath?: string;
  dataAttributes: Record<string, string>;
  ariaAttributes: Record<string, string>;
  role?: string;
  name?: string;
  src?: string;
  href?: string;
  fileLocation?: string;
  pageUrl?: string;
}

/**
 * Extract all HTML attributes from a snippet string.
 * Returns a Map of attribute name -> value pairs.
 */
function extractAllAttributes(snippet: string): Map<string, string> {
  const attrs = new Map<string, string>();
  // Match all attribute="value" or attribute='value' patterns
  const attrRegex = /(\w+(?:-\w+)*)=["']([^"']*)["']/g;
  let match;
  while ((match = attrRegex.exec(snippet)) !== null) {
    if (match[1] && match[2] !== undefined) {
      attrs.set(match[1], match[2]);
    }
  }
  return attrs;
}

/**
 * Check if an attribute name is framework-generated noise that should be filtered.
 */
function isNoiseAttribute(name: string): boolean {
  const noisePatterns = [
    /^_ngcontent-/,
    /^_nghost-/,
    /^ng-/,
    /^data-reactid$/,
    /^data-react-/,
    /^data-v-/,
    /^data-emotion-/,
  ];
  return noisePatterns.some((pattern) => pattern.test(name));
}

/**
 * Extract technical details from a finding for developer reference.
 */
function extractTechnicalDetails(f: Finding): TechnicalDetails {
  const details: TechnicalDetails = {
    classes: [],
    dataAttributes: {},
    ariaAttributes: {},
  };

  // Add selector and xpath
  if (f.selector) {
    details.selector = f.selector;
  }
  if (f.xpath) {
    details.xpath = f.xpath;
  }

  // Add file location for repo scans
  if (f.filePath && f.line) {
    details.fileLocation = `${f.filePath}:${f.line}:${f.column ?? 0}`;
  }

  // Add page URL for web scans
  if (f.pageUrl) {
    details.pageUrl = f.pageUrl;
  }

  // Parse HTML snippet for attributes
  if (f.htmlSnippet) {
    const attrs = extractAllAttributes(f.htmlSnippet);

    for (const [name, value] of attrs.entries()) {
      // Skip noise attributes
      if (isNoiseAttribute(name)) {
        continue;
      }

      // Categorize attributes
      if (name === "id") {
        details.elementId = value;
      } else if (name === "class") {
        // Split classes and filter framework noise
        const classes = value
          .split(/\s+/)
          .filter((c) => c && !isNoiseAttribute(c));
        details.classes = classes;
      } else if (name.startsWith("data-")) {
        details.dataAttributes[name] = value;
      } else if (name.startsWith("aria-")) {
        details.ariaAttributes[name] = value;
      } else if (name === "role") {
        details.role = value;
      } else if (name === "name") {
        details.name = value;
      } else if (name === "src") {
        details.src = value;
      } else if (name === "href") {
        details.href = value;
      }
    }
  }

  return details;
}

/**
 * Render technical details HTML block for an element.
 */
function renderTechnicalDetails(details: TechnicalDetails): string {
  const sections: string[] = [];

  // Primary section: ID, Selector, File Location, Page URL
  const primary: string[] = [];

  if (details.elementId) {
    primary.push(
      `<span class="tech-id" title="Element ID">#${escape(details.elementId)}</span>`,
    );
  }

  if (details.selector) {
    primary.push(`
      <div class="tech-selector-block">
        <div class="tech-label">CSS Selector:</div>
        <div class="tech-code-block">
          <code>${escape(details.selector)}</code>
          <button class="tech-copy-btn" data-copy="${escape(details.selector)}" title="Copy selector" aria-label="Copy CSS selector to clipboard">Copy</button>
        </div>
      </div>
    `);
  }

  if (details.fileLocation) {
    primary.push(`
      <div class="tech-item">
        <span class="tech-label">File:</span>
        <code>${escape(details.fileLocation)}</code>
      </div>
    `);
  }

  if (details.pageUrl) {
    primary.push(`
      <div class="tech-item">
        <span class="tech-label">Page:</span>
        <a href="${escape(details.pageUrl)}" target="_blank" rel="noopener" class="tech-link">${escape(truncateUrl(details.pageUrl, 60))}</a>
      </div>
    `);
  }

  if (primary.length > 0) {
    sections.push(`<div class="tech-primary">${primary.join("")}</div>`);
  }

  // Secondary section: Classes, Data attributes, ARIA attributes, Role, XPath, src/href
  const secondary: string[] = [];

  if (details.classes.length > 0) {
    const visibleClasses = details.classes.slice(0, 5);
    const hiddenCount = details.classes.length - 5;
    const classBadges = visibleClasses
      .map((c) => `<span class="attr-badge">${escape(c)}</span>`)
      .join(" ");
    const moreClasses =
      hiddenCount > 0
        ? `<span class="tech-more">+${hiddenCount} more</span>`
        : "";
    secondary.push(`
      <div class="tech-item">
        <span class="tech-label">Classes:</span>
        <div class="attr-badge-list">${classBadges} ${moreClasses}</div>
      </div>
    `);
  }

  // Prioritize test-related data attributes
  const testAttrs = [
    "data-testid",
    "data-cy",
    "data-qa",
    "data-test",
    "data-test-id",
  ];
  const priorityDataAttrs: string[] = [];
  const otherDataAttrs: string[] = [];

  for (const [name, value] of Object.entries(details.dataAttributes)) {
    const attr = `<code>${escape(name)}</code> = <code>"${escape(value)}"</code>`;
    if (testAttrs.includes(name)) {
      priorityDataAttrs.push(attr);
    } else {
      otherDataAttrs.push(attr);
    }
  }

  const allDataAttrs = [...priorityDataAttrs, ...otherDataAttrs];
  if (allDataAttrs.length > 0) {
    secondary.push(`
      <div class="tech-item">
        <span class="tech-label">Data Attributes:</span>
        <div class="attr-list">${allDataAttrs.join("<br>")}</div>
      </div>
    `);
  }

  if (Object.keys(details.ariaAttributes).length > 0) {
    const ariaList = Object.entries(details.ariaAttributes)
      .map(
        ([name, value]) =>
          `<code>${escape(name)}</code> = <code>"${escape(value)}"</code>`,
      )
      .join("<br>");
    secondary.push(`
      <div class="tech-item">
        <span class="tech-label">ARIA Attributes:</span>
        <div class="attr-list">${ariaList}</div>
      </div>
    `);
  }

  if (details.role) {
    secondary.push(`
      <div class="tech-item">
        <span class="tech-label">Role:</span>
        <code>${escape(details.role)}</code>
      </div>
    `);
  }

  if (details.name) {
    secondary.push(`
      <div class="tech-item">
        <span class="tech-label">Name:</span>
        <code>${escape(details.name)}</code>
      </div>
    `);
  }

  if (details.xpath) {
    secondary.push(`
      <div class="tech-selector-block">
        <div class="tech-label">XPath:</div>
        <div class="tech-code-block">
          <code>${escape(truncate(details.xpath, 100))}</code>
          <button class="tech-copy-btn" data-copy="${escape(details.xpath)}" title="Copy XPath" aria-label="Copy XPath to clipboard">Copy</button>
        </div>
      </div>
    `);
  }

  if (details.src) {
    secondary.push(`
      <div class="tech-item">
        <span class="tech-label">Source:</span>
        <code>${escape(truncate(details.src, 60))}</code>
      </div>
    `);
  }

  if (details.href) {
    secondary.push(`
      <div class="tech-item">
        <span class="tech-label">Link:</span>
        <code>${escape(truncate(details.href, 60))}</code>
      </div>
    `);
  }

  if (secondary.length > 0) {
    sections.push(`
      <details class="tech-secondary">
        <summary class="tech-secondary-label">Additional Technical Details</summary>
        <div class="tech-secondary-content">${secondary.join("")}</div>
      </details>
    `);
  }

  return sections.join("");
}

/**
 * Truncate URL intelligently, preserving domain and last path segment.
 */
function truncateUrl(url: string, maxLen: number): string {
  if (url.length <= maxLen) return url;

  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (pathParts.length === 0) return url.slice(0, maxLen - 1) + "…";

    const lastPart = pathParts[pathParts.length - 1];
    const base = `${parsed.protocol}//${parsed.host}/…/`;
    const result = base + lastPart;

    if (result.length > maxLen) {
      return url.slice(0, maxLen - 1) + "…";
    }

    return result;
  } catch {
    return url.slice(0, maxLen - 1) + "…";
  }
}

export async function writeHtmlReport(
  state: ScanState,
  outDir: string,
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, "report.html");
  const html = renderHtml(state);
  await writeFile(path, html);
  return path;
}

export function renderHtml(state: ScanState): string {
  const summary = summarizeFindings(state);
  const grouped = groupBySeverity(state.findings);
  const isCrawl = state.plan.crawl?.enabled ?? false;
  const pages = state.meta.pagesScanned ?? [];
  const targetLabel =
    state.plan.mode === "url"
      ? isCrawl
        ? `Crawled from: ${escape(state.plan.target)} (${pages.length} pages)`
        : `URL: ${escape(state.plan.target)}`
      : state.plan.mode === "repo"
        ? `Repo: ${escape(state.plan.target)}`
        : `Fixture: ${escape(state.plan.target)}`;

  const cards = (
    [
      ["blocker", summary.blockers],
      ["severe", summary.severe],
      ["major", summary.major],
      ["minor", summary.minor],
      ["review", summary.review],
    ] as const
  )
    .map(
      ([k, v]) => `
        <div class="card" data-severity="${k}">
          <div class="count">${v}</div>
          <div class="card-label">${SEVERITY_LABEL[k as Severity]}</div>
        </div>`,
    )
    .join("");

  const severitySections = (
    ["blocker", "severe", "major", "minor", "review"] as const
  )
    .filter((sev) => grouped[sev].length > 0)
    .map((sev) => renderSection(sev, grouped[sev]))
    .join("\n");

  const wcagRuleSections = renderWcagRuleView(state.findings);
  const elementSections = renderElementView(state.findings);
  const reviewNeededSections = renderReviewNeededView(state.findings);
  const passesSections = renderPassesView(state.passes);
  const inapplicableSections = renderInapplicableView(state.inapplicable, isCrawl);

  const reviewNeededCount = state.findings.filter(f => f.requiresHumanReview).length;
  const manualAuditsSection = renderManualAuditsView();
  const manualAuditsTotalCount = manualAuditsCount("Manual Only");
  const isMultiPage = pages.length > 1 && (isCrawl || state.plan.mode === "fixture");
  const pagesSection = isMultiPage ? renderPagesSection(state) : "";
  const pageFilterSection = isMultiPage ? renderPageFilterControl(state) : "";
  const pageCountsScript = isMultiPage
    ? `<script id="a11y-page-counts" type="application/json">${JSON.stringify(computePageCounts(state)).replace(/</g, "\\u003c")}</script>`
    : "";
  const tabBar = renderTabBar(
    state.passes.length,
    state.inapplicable.length,
    reviewNeededCount,
    manualAuditsTotalCount,
    summary.total > 0,
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Accessibility Report · a11y-scout</title>
  <style>
    :root {
      color-scheme: light dark;

      /* Light mode colors */
      --bg-primary: #ffffff;
      --bg-secondary: #f5f5f7;
      --bg-tertiary: #fafafa;
      --text-primary: #1d1d1f;
      --text-secondary: #52525b;
      --text-tertiary: #3f3f46;
      --border-light: #d2d2d7;
      --border-medium: #e5e5e5;
      --accent: #0071e3;
      --accent-hover: #0077ed;

      /* Severity colors */
      --severity-blocker: #ff3b30;
      --severity-blocker-bg: rgba(255, 59, 48, 0.08);
      --severity-severe: #ff9500;
      --severity-severe-bg: rgba(255, 149, 0, 0.08);
      --severity-major: #ffcc00;
      --severity-major-bg: rgba(255, 204, 0, 0.08);
      --severity-minor: #8b5cf6;
      --severity-minor-bg: rgba(139, 92, 246, 0.08);
      --severity-review: #0071e3;
      --severity-review-bg: rgba(0, 113, 227, 0.08);

      /* Success/Pass colors (green reserved for passed audits only) */
      --success: #34c759;
      --success-bg: rgba(52, 199, 89, 0.08);

      /* Shadows */
      --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.04);
      --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.06);
      --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.08);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg-primary: #000000;
        --bg-secondary: #1d1d1f;
        --bg-tertiary: #2c2c2e;
        --text-primary: #f5f5f7;
        --text-secondary: #86868b;
        --text-tertiary: #a1a1a6;
        --border-light: #424245;
        --border-medium: #2c2c2e;
        --accent: #0a84ff;
        --accent-hover: #409cff;

        --severity-blocker: #ff453a;
        --severity-blocker-bg: rgba(255, 69, 58, 0.15);
        --severity-severe: #ff9f0a;
        --severity-severe-bg: rgba(255, 159, 10, 0.15);
        --severity-major: #ffd60a;
        --severity-major-bg: rgba(255, 214, 10, 0.15);
        --severity-minor: #a78bfa;
        --severity-minor-bg: rgba(167, 139, 250, 0.15);
        --severity-review: #0a84ff;
        --severity-review-bg: rgba(10, 132, 255, 0.15);

        /* Success/Pass colors (green reserved for passed audits only) */
        --success: #32d74b;
        --success-bg: rgba(50, 215, 75, 0.15);

        --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
        --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
        --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
      }
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.47059;
      font-size: 17px;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .container {
      max-width: 980px;
      margin: 0 auto;
      padding: 60px 24px 100px;
    }

    /* Header */
    .header {
      margin-bottom: 48px;
      position: relative;
    }

    .theme-toggle {
      position: absolute;
      top: 0;
      right: 0;
      background: var(--bg-secondary);
      border: 1px solid var(--border-medium);
      border-radius: 20px;
      padding: 8px 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      transition: all 0.2s ease;
    }

    .theme-toggle:hover {
      background: var(--bg-tertiary);
      border-color: var(--border-light);
    }

    .theme-toggle:active {
      transform: scale(0.98);
    }

    .theme-toggle:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .theme-toggle svg {
      width: 18px;
      height: 18px;
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .theme-icon-sun,
    .theme-icon-moon {
      display: none;
    }

    html[data-theme="light"] .theme-icon-sun {
      display: block;
    }

    html[data-theme="dark"] .theme-icon-moon {
      display: block;
    }

    /* Override system preference when manual theme is set */
    html[data-theme="light"] {
      color-scheme: light;
      --bg-primary: #ffffff;
      --bg-secondary: #f5f5f7;
      --bg-tertiary: #fafafa;
      --text-primary: #1d1d1f;
      --text-secondary: #52525b;
      --text-tertiary: #3f3f46;
      --border-light: #d2d2d7;
      --border-medium: #e5e5e5;
      --accent: #0071e3;
      --accent-hover: #0077ed;
      --severity-blocker: #ff3b30;
      --severity-blocker-bg: rgba(255, 59, 48, 0.08);
      --severity-severe: #ff9500;
      --severity-severe-bg: rgba(255, 149, 0, 0.08);
      --severity-major: #ffcc00;
      --severity-major-bg: rgba(255, 204, 0, 0.08);
      --severity-minor: #8b5cf6;
      --severity-minor-bg: rgba(139, 92, 246, 0.08);
      --severity-review: #0071e3;
      --severity-review-bg: rgba(0, 113, 227, 0.08);
      --success: #34c759;
      --success-bg: rgba(52, 199, 89, 0.08);
      --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.04);
      --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.06);
      --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.08);
    }

    html[data-theme="dark"] {
      color-scheme: dark;
      --bg-primary: #000000;
      --bg-secondary: #1d1d1f;
      --bg-tertiary: #2c2c2e;
      --text-primary: #f5f5f7;
      --text-secondary: #86868b;
      --text-tertiary: #a1a1a6;
      --border-light: #424245;
      --border-medium: #2c2c2e;
      --accent: #0a84ff;
      --accent-hover: #409cff;
      --severity-blocker: #ff453a;
      --severity-blocker-bg: rgba(255, 69, 58, 0.15);
      --severity-severe: #ff9f0a;
      --severity-severe-bg: rgba(255, 159, 10, 0.15);
      --severity-major: #ffd60a;
      --severity-major-bg: rgba(255, 214, 10, 0.15);
      --severity-minor: #a78bfa;
      --severity-minor-bg: rgba(167, 139, 250, 0.15);
      --severity-review: #0a84ff;
      --severity-review-bg: rgba(10, 132, 255, 0.15);
      --success: #32d74b;
      --success-bg: rgba(50, 215, 75, 0.15);
      --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
      --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
      --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
    }

    h1 {
      font-size: 48px;
      font-weight: 600;
      letter-spacing: -0.003em;
      line-height: 1.08349;
      margin-bottom: 12px;
      padding-right: 140px;
    }

    .subtitle {
      font-size: 21px;
      line-height: 1.381;
      color: var(--text-secondary);
      font-weight: 400;
      margin-bottom: 24px;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 24px;
      font-size: 14px;
      color: var(--text-tertiary);
      padding: 16px 0;
      border-top: 1px solid var(--border-medium);
      border-bottom: 1px solid var(--border-medium);
    }

    .meta-item strong {
      color: var(--text-primary);
      font-weight: 600;
    }

    /* Summary Cards */
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 16px;
      margin: 0 0 48px;
    }

    .card {
      background: var(--bg-secondary);
      border-radius: 18px;
      padding: 24px 20px;
      text-align: center;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      border: 1px solid transparent;
    }

    .card:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }

    .card[data-severity="blocker"] { border-color: var(--severity-blocker); }
    .card[data-severity="severe"] { border-color: var(--severity-severe); }
    .card[data-severity="major"] { border-color: var(--severity-major); }
    .card[data-severity="minor"] { border-color: var(--severity-minor); }
    .card[data-severity="review"] { border-color: var(--severity-review); }

    .count {
      font-size: 40px;
      font-weight: 600;
      line-height: 1.1;
      margin-bottom: 8px;
      letter-spacing: -0.005em;
    }

    .card[data-severity="blocker"] .count { color: var(--severity-blocker); }
    .card[data-severity="severe"] .count { color: var(--severity-severe); }
    .card[data-severity="major"] .count { color: var(--severity-major); }
    .card[data-severity="minor"] .count { color: var(--severity-minor); }
    .card[data-severity="review"] .count { color: var(--severity-review); }

    .card-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 600;
      color: var(--text-tertiary);
    }

    /* Tabs */
    .tab-bar {
      display: flex;
      gap: 0;
      margin-bottom: 48px;
      background: var(--bg-secondary);
      border-radius: 12px;
      padding: 4px;
      width: fit-content;
    }

    .tab-bar button {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: 14px;
      font-weight: 600;
      padding: 10px 20px;
      cursor: pointer;
      border-radius: 8px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      font-family: inherit;
      white-space: nowrap;
    }

    .tab-bar button:hover {
      color: var(--text-primary);
      background: rgba(0, 0, 0, 0.03);
    }

    @media (prefers-color-scheme: dark) {
      .tab-bar button:hover {
        background: rgba(255, 255, 255, 0.08);
      }
    }

    .tab-bar button[aria-selected="true"] {
      color: var(--text-primary);
      background: var(--bg-primary);
      box-shadow: var(--shadow-sm);
    }

    .tab-bar button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    /* Tab panels */
    .tab-panel {
      display: none;
    }

    .tab-panel[data-active="true"] {
      display: block;
      animation: fadeIn 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }

    @keyframes fadeIn {
      from {
        opacity: 0;
        transform: translateY(12px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    /* Section Groups */
    .section {
      margin-bottom: 48px;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border-medium);
    }

    .section h2 {
      font-size: 28px;
      font-weight: 600;
      letter-spacing: -0.003em;
      line-height: 1.14286;
    }

    .section-count {
      font-size: 14px;
      color: var(--text-tertiary);
      background: var(--bg-secondary);
      padding: 6px 12px;
      border-radius: 12px;
      font-weight: 600;
    }

    /* Collapsible Groups */
    .group {
      background: var(--bg-secondary);
      border-radius: 16px;
      margin-bottom: 16px;
      overflow: hidden;
      border: 1px solid var(--border-medium);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .group:hover {
      box-shadow: var(--shadow-sm);
    }

    .group[data-severity="blocker"] {
      border-left: 4px solid var(--severity-blocker);
    }

    .group[data-severity="severe"] {
      border-left: 4px solid var(--severity-severe);
    }

    .group[data-severity="major"] {
      border-left: 4px solid var(--severity-major);
    }

    .group[data-severity="minor"] {
      border-left: 4px solid var(--severity-minor);
    }

    .group[data-severity="review"] {
      border-left: 4px solid var(--severity-review);
    }

    .group-header {
      cursor: pointer;
      padding: 20px 24px;
      display: flex;
      align-items: center;
      gap: 16px;
      user-select: none;
      transition: background 0.2s ease;
    }

    .group-header:hover {
      background: var(--bg-tertiary);
    }

    .group-header:active {
      transform: scale(0.995);
    }

    .chevron {
      width: 20px;
      height: 20px;
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      color: var(--text-secondary);
      flex-shrink: 0;
    }

    .group[open] .chevron {
      transform: rotate(90deg);
    }

    .group-title {
      flex: 1;
      font-size: 17px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .group-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }

    .badge {
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .badge-blocker {
      background: var(--severity-blocker-bg);
      color: var(--severity-blocker);
    }

    .badge-severe {
      background: var(--severity-severe-bg);
      color: var(--severity-severe);
    }

    .badge-major {
      background: var(--severity-major-bg);
      color: var(--severity-major);
    }

    .badge-minor {
      background: var(--severity-minor-bg);
      color: var(--severity-minor);
    }

    .badge-review {
      background: var(--severity-review-bg);
      color: var(--severity-review);
    }

    .badge-ai {
      background: var(--severity-review-bg);
      color: var(--severity-review);
    }

    .badge-count {
      background: var(--bg-primary);
      color: var(--text-secondary);
      font-size: 13px;
      padding: 4px 10px;
      border-radius: 10px;
      font-weight: 600;
    }

    .group-content {
      padding: 0 24px 24px;
      animation: expandContent 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    @keyframes expandContent {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }

    /* Findings */
    .finding {
      background: var(--bg-primary);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 12px;
      border: 1px solid var(--border-medium);
      transition: all 0.2s ease;
    }

    .finding:last-child {
      margin-bottom: 0;
    }

    .finding:hover {
      box-shadow: var(--shadow-sm);
    }

    .finding-header {
      margin-bottom: 12px;
    }

    .finding-title {
      font-size: 17px;
      font-weight: 600;
      line-height: 1.47059;
      margin-bottom: 8px;
      color: var(--text-primary);
    }

    .finding-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }

    .finding-desc {
      font-size: 15px;
      line-height: 1.53333;
      color: var(--text-secondary);
      margin-bottom: 16px;
    }

    .finding-meta {
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 13px;
      color: var(--text-tertiary);
    }

    .meta-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }

    .meta-label {
      font-weight: 600;
      color: var(--text-secondary);
      min-width: 80px;
    }

    .meta-value {
      font-family: "SF Mono", Monaco, monospace;
      font-size: 12px;
      color: var(--text-tertiary);
      word-break: break-all;
    }

    /* Code */
    pre {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-medium);
      border-radius: 10px;
      padding: 16px;
      overflow-x: auto;
      font-size: 13px;
      line-height: 1.5;
      margin: 12px 0;
    }

    code {
      font-family: "SF Mono", Monaco, Menlo, monospace;
      font-size: 0.95em;
    }

    .remediation {
      background: var(--severity-review-bg);
      border-left: 3px solid var(--severity-review);
      border-radius: 10px;
      padding: 16px;
      margin-top: 16px;
      font-size: 15px;
      line-height: 1.53333;
      color: var(--text-primary);
    }
    .remediation-label {
      display: block;
      margin-bottom: 8px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .remediation-label::after {
      content: ":";
    }
    .remediation-body {
      color: var(--text-secondary);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .remediation-body a {
      color: var(--accent);
      word-break: break-all;
    }

    .ai-fixed-html {
      background: var(--bg-tertiary);
      border-left: 3px solid var(--accent);
      border-radius: 10px;
      padding: 16px;
      margin-top: 12px;
      font-size: 15px;
      line-height: 1.53333;
      color: var(--text-primary);
    }
    .ai-fixed-html .ai-fixed-html-label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .ai-fixed-html .ai-fixed-html-tag {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: var(--accent);
      color: #fff;
      padding: 2px 6px;
      border-radius: 6px;
    }
    .ai-fixed-html pre {
      margin: 0;
    }
    .ai-fixed-html-note {
      margin-top: 8px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    a {
      color: var(--accent);
      text-decoration: none;
      transition: color 0.2s ease;
    }

    a:hover {
      color: var(--accent-hover);
      text-decoration: underline;
    }

    /* Controls */
    .controls {
      display: flex;
      gap: 12px;
      margin-bottom: 24px;
    }

    .btn {
      background: var(--bg-secondary);
      border: 1px solid var(--border-medium);
      color: var(--text-primary);
      font-size: 14px;
      font-weight: 600;
      padding: 10px 18px;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: inherit;
    }

    .btn:hover {
      background: var(--bg-tertiary);
      border-color: var(--border-light);
    }

    .btn:active {
      transform: scale(0.98);
    }

    .btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .btn-copy {
      background: var(--bg-secondary);
      border: 1px solid var(--border-medium);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 600;
      padding: 6px 12px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: inherit;
      white-space: nowrap;
    }

    .btn-copy:hover {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    .btn-copy:disabled {
      background: var(--severity-minor-bg);
      color: var(--severity-minor);
      border-color: var(--severity-minor);
    }

    /* Empty State */
    .empty {
      text-align: center;
      padding: 80px 24px;
      color: var(--text-secondary);
      font-size: 19px;
    }

    /* Footer */
    footer {
      margin-top: 80px;
      padding-top: 24px;
      border-top: 1px solid var(--border-medium);
      color: var(--text-tertiary);
      font-size: 12px;
      line-height: 1.66667;
    }

    /* Technical Details */
    .tech-details {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-medium);
      border-radius: 12px;
      padding: 20px;
      margin: 16px 0;
    }

    .tech-section {
      margin-bottom: 16px;
    }

    .tech-section:last-child {
      margin-bottom: 0;
    }

    .tech-label {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-tertiary);
      margin-bottom: 8px;
    }

    .tech-value {
      font-family: "SF Mono", Monaco, monospace;
      font-size: 13px;
      color: var(--text-primary);
      word-break: break-all;
      background: var(--bg-primary);
      padding: 12px;
      border-radius: 8px;
      border: 1px solid var(--border-medium);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .tech-value code {
      flex: 1;
    }

    .tech-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .tech-badge {
      font-family: "SF Mono", Monaco, monospace;
      font-size: 11px;
      background: var(--bg-primary);
      border: 1px solid var(--border-medium);
      color: var(--text-secondary);
      padding: 4px 8px;
      border-radius: 6px;
      font-weight: 500;
    }

    .tech-toggle {
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 0;
      margin-top: 16px;
      border-top: 1px solid var(--border-medium);
      color: var(--text-secondary);
      font-size: 14px;
      font-weight: 600;
      user-select: none;
      transition: color 0.2s ease;
    }

    .tech-toggle:hover {
      color: var(--text-primary);
    }

    .tech-toggle-icon {
      width: 16px;
      height: 16px;
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .tech-details[open] .tech-toggle-icon {
      transform: rotate(90deg);
    }

    .tech-toggle-content {
      padding-top: 16px;
    }

    /* Pages Section */
    .pages-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 24px;
      font-size: 14px;
    }

    .pages-table th {
      text-align: left;
      color: var(--text-tertiary);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-size: 11px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-medium);
    }

    .pages-table td {
      padding: 16px;
      border-bottom: 1px solid var(--border-medium);
    }

    .pages-table tr:last-child td {
      border-bottom: none;
    }

    .pages-table tr:hover {
      background: var(--bg-secondary);
    }

    /* Responsive */
    @media (max-width: 768px) {
      .container {
        padding: 40px 20px 60px;
      }

      h1 {
        font-size: 36px;
        padding-right: 0;
        margin-bottom: 20px;
      }

      .subtitle {
        font-size: 19px;
      }

      .theme-toggle {
        position: static;
        margin-bottom: 24px;
        width: fit-content;
      }

      .summary {
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
      }

      .tab-bar {
        width: 100%;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }

      .group-header {
        padding: 16px;
      }

      .group-content {
        padding: 0 16px 16px;
      }

      .finding {
        padding: 16px;
      }

      .group-meta {
        flex-wrap: wrap;
      }
    }

    /* Element grouping styles (legacy compatibility) */
    .element-controls {
      margin-bottom: 1.5rem;
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    .element-controls button {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      color: var(--fg);
      font-size: 0.85rem;
      font-weight: 600;
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      cursor: pointer;
      transition: background 0.2s, border-color 0.2s;
      font-family: inherit;
    }
    .element-controls button:hover {
      background: var(--code-bg);
      border-color: var(--link);
    }
    .element-controls button:focus-visible {
      outline: 2px solid var(--link);
      outline-offset: 2px;
    }

    .element-group {
      border: 1px solid var(--border);
      border-left-width: 4px;
      border-radius: 0.5rem;
      margin-bottom: 1rem;
      background: var(--card);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
      transition: box-shadow 0.2s;
    }
    .element-group:hover { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08); }
    .element-group[data-max-severity="blocker"] { border-left-color: #dc2626; }
    .element-group[data-max-severity="severe"] { border-left-color: #ea580c; }
    .element-group[data-max-severity="major"] { border-left-color: #d97706; }
    .element-group[data-max-severity="minor"] { border-left-color: #65a30d; }
    .element-group[data-max-severity="review"] { border-left-color: #2563eb; }

    .element-group summary {
      cursor: pointer;
      list-style: none;
      padding: 1rem 1.5rem;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      user-select: none;
      transition: background 0.2s;
    }
    .element-group summary::-webkit-details-marker { display: none; }
    .element-group summary:hover { background: var(--code-bg); }
    .element-group summary:focus-visible {
      outline: 2px solid var(--link);
      outline-offset: -2px;
    }

    .element-label {
      font-weight: 600;
      font-size: 1rem;
      flex: 1;
      min-width: 200px;
    }

    .badge-tag {
      font-family: "SF Mono", Menlo, Monaco, monospace;
      font-size: 0.75rem;
      padding: 0.15rem 0.5rem;
      border-radius: 0.25rem;
      background: var(--code-bg);
      color: var(--muted);
      font-weight: 500;
    }

    .badge-count {
      font-size: 0.75rem;
      padding: 0.15rem 0.6rem;
      border-radius: 999px;
      font-weight: 600;
      border: 1px solid transparent;
    }
    .badge-count[data-severity="blocker"] {
      background: rgba(220, 38, 38, 0.15);
      color: #dc2626;
      border-color: rgba(220, 38, 38, 0.3);
    }
    .badge-count[data-severity="severe"] {
      background: rgba(234, 88, 12, 0.15);
      color: #ea580c;
      border-color: rgba(234, 88, 12, 0.3);
    }
    .badge-count[data-severity="major"] {
      background: rgba(217, 119, 6, 0.15);
      color: #d97706;
      border-color: rgba(217, 119, 6, 0.3);
    }
    .badge-count[data-severity="minor"] {
      background: rgba(101, 163, 13, 0.15);
      color: #65a30d;
      border-color: rgba(101, 163, 13, 0.3);
    }
    .badge-count[data-severity="review"] {
      background: rgba(37, 99, 235, 0.15);
      color: #2563eb;
      border-color: rgba(37, 99, 235, 0.3);
    }

    .badge-severity {
      font-size: 0.7rem;
      padding: 0.2rem 0.6rem;
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
    }
    .badge-severity[data-severity="blocker"] {
      background: rgba(220, 38, 38, 0.15);
      color: #dc2626;
    }
    .badge-severity[data-severity="severe"] {
      background: rgba(234, 88, 12, 0.15);
      color: #ea580c;
    }
    .badge-severity[data-severity="major"] {
      background: rgba(217, 119, 6, 0.15);
      color: #d97706;
    }
    .badge-severity[data-severity="minor"] {
      background: rgba(101, 163, 13, 0.15);
      color: #65a30d;
    }
    .badge-severity[data-severity="review"] {
      background: rgba(37, 99, 235, 0.15);
      color: #2563eb;
    }

    .expand-icon {
      display: inline-block;
      transition: transform 0.2s;
      font-size: 0.8rem;
      color: var(--muted);
      margin-right: 0.5rem;
    }
    details[open] .expand-icon { transform: rotate(90deg); }

    .element-group-content {
      padding: 0 1.5rem 1rem 1.5rem;
      border-top: 1px solid var(--border);
    }
    .element-group-content .finding {
      margin-top: 1rem;
    }

    @media (max-width: 720px) {
      .element-group summary {
        flex-direction: column;
        align-items: flex-start;
      }
      .element-label {
        min-width: 100%;
      }
    }

    /* Technical details styles */
    .tech-details {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      padding: 1rem;
      margin-bottom: 1rem;
      font-size: 0.9rem;
    }

    .tech-primary {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }

    .tech-id {
      display: inline-block;
      font-family: "SF Mono", Menlo, Monaco, monospace;
      font-size: 0.85rem;
      font-weight: 600;
      background: rgba(37, 99, 235, 0.15);
      color: var(--link);
      padding: 0.25rem 0.6rem;
      border-radius: 0.25rem;
      border: 1px solid rgba(37, 99, 235, 0.3);
    }

    .tech-selector-block {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .tech-code-block {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 0.25rem;
      padding: 0.5rem;
      overflow-x: auto;
    }

    .tech-code-block code {
      flex: 1;
      font-size: 0.85rem;
      word-break: break-all;
    }

    .tech-copy-btn {
      flex-shrink: 0;
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--fg);
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      cursor: pointer;
      transition: all 0.2s;
      font-family: inherit;
      white-space: nowrap;
    }

    .tech-copy-btn:hover {
      background: var(--link);
      color: #fff;
      border-color: var(--link);
    }

    .tech-copy-btn:disabled {
      background: rgba(101, 163, 13, 0.15);
      color: #65a30d;
      border-color: rgba(101, 163, 13, 0.3);
      cursor: default;
    }

    .tech-copy-btn:focus-visible {
      outline: 2px solid var(--link);
      outline-offset: 2px;
    }

    .tech-item {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.5rem;
    }

    .tech-label {
      color: var(--muted);
      font-weight: 600;
      font-size: 0.85rem;
      min-width: 120px;
    }

    .tech-link {
      color: var(--link);
      text-decoration: none;
      word-break: break-all;
    }

    .tech-link:hover {
      text-decoration: underline;
    }

    .attr-badge-list {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.375rem;
    }

    .attr-badge {
      display: inline-block;
      font-family: "SF Mono", Menlo, Monaco, monospace;
      font-size: 0.75rem;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--muted);
      padding: 0.2rem 0.5rem;
      border-radius: 0.25rem;
      font-weight: 500;
    }

    .tech-more {
      font-size: 0.75rem;
      color: var(--muted);
      font-style: italic;
    }

    .attr-list {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      font-size: 0.85rem;
    }

    .tech-secondary {
      margin-top: 0.75rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
    }

    .tech-secondary-label {
      cursor: pointer;
      color: var(--muted);
      font-weight: 600;
      font-size: 0.85rem;
      list-style: none;
      user-select: none;
      padding: 0.25rem 0;
      transition: color 0.2s;
    }

    .tech-secondary-label::-webkit-details-marker {
      display: none;
    }

    .tech-secondary-label::before {
      content: "▸ ";
      display: inline-block;
      transition: transform 0.2s;
      margin-right: 0.25rem;
    }

    .tech-secondary[open] .tech-secondary-label::before {
      transform: rotate(90deg);
    }

    .tech-secondary-label:hover {
      color: var(--fg);
    }

    .tech-secondary-label:focus-visible {
      outline: 2px solid var(--link);
      outline-offset: 2px;
      border-radius: 0.25rem;
    }

    .tech-secondary-content {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-top: 0.75rem;
    }

    @media (max-width: 720px) {
      .tech-label {
        min-width: 100%;
      }
      .tech-item {
        flex-direction: column;
        align-items: flex-start;
      }
    }

    /* Keyboard-trap evidence panel */
    .kbd-evidence {
      margin-top: 16px;
      padding: 16px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-medium);
      border-radius: 12px;
    }
    .kbd-evidence-title {
      margin: 0 0 10px;
      font-size: 0.95rem;
      font-weight: 700;
    }
    .kbd-direction { margin-bottom: 12px; }
    .kbd-subtitle {
      font-weight: 600;
      font-size: 0.85rem;
      margin: 14px 0 6px;
      opacity: 0.85;
    }
    .kbd-cycle-list {
      list-style: none;
      margin: 0;
      padding: 0;
      border: 1px solid var(--border-light);
      border-radius: 8px;
      overflow: hidden;
      background: var(--bg-primary);
    }
    .kbd-cycle-step {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-light);
      flex-wrap: wrap;
    }
    .kbd-cycle-step:last-child { border-bottom: none; }
    .kbd-cycle-num {
      flex: 0 0 auto;
      width: 22px; height: 22px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 50%;
      background: color-mix(in srgb, var(--severity-blocker, #e11d48) 15%, transparent);
      font-size: 0.8rem; font-weight: 700;
    }
    .kbd-cycle-name { font-weight: 600; }
    .kbd-cycle-role {
      font-size: 0.75rem;
      padding: 1px 6px;
      border-radius: 4px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-light);
      opacity: 0.85;
    }
    .kbd-cycle-sel { font-size: 0.78rem; opacity: 0.7; margin-left: auto; }
    .kbd-loopback {
      margin-top: 6px;
      font-size: 0.82rem;
      font-style: italic;
      opacity: 0.8;
    }
    .kbd-keys-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 4px;
      background: var(--bg-primary);
      border: 1px solid var(--border-light);
      border-radius: 8px;
      overflow: hidden;
    }
    .kbd-keys-table th, .kbd-keys-table td {
      text-align: left;
      padding: 6px 12px;
      border-bottom: 1px solid var(--border-light);
      font-size: 0.85rem;
    }
    .kbd-keys-table tr:last-child td { border-bottom: none; }
    .kbd-keys-table kbd {
      padding: 2px 6px;
      border: 1px solid var(--border-medium);
      border-radius: 4px;
      font-family: ui-monospace, monospace;
      font-size: 0.8rem;
    }
    .kbd-modal { margin-top: 6px; font-size: 0.85rem; line-height: 1.5; }
    .kbd-shot-img {
      max-width: 100%;
      border: 1px solid var(--border-medium);
      border-radius: 8px;
      margin-top: 4px;
    }

    /* Incomplete findings split panel styles */
    .incomplete-split-panel {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-top: 16px;
      padding: 16px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-medium);
      border-radius: 12px;
    }

    @media (max-width: 768px) {
      .incomplete-split-panel {
        grid-template-columns: 1fr;
      }
    }

    .incomplete-diagnostic,
    .incomplete-verify {
      padding: 16px;
      border-radius: 8px;
    }

    .incomplete-diagnostic {
      background: var(--bg-primary);
      border: 1px solid var(--border-light);
    }

    .incomplete-verify {
      background: color-mix(in srgb, var(--severity-review) 5%, transparent);
      border: 1px solid color-mix(in srgb, var(--severity-review) 20%, transparent);
    }

    .incomplete-panel-title {
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin: 0 0 12px 0;
      color: var(--text-tertiary);
    }

    .diag-table {
      width: 100%;
      font-size: 13px;
      border-collapse: collapse;
    }

    .diag-table td {
      padding: 6px 8px;
      border-bottom: 1px solid var(--border-light);
    }

    .diag-table tr:last-child td {
      border-bottom: none;
    }

    .diag-key {
      font-weight: 500;
      white-space: nowrap;
      color: var(--text-secondary);
      width: 40%;
    }

    .diag-value {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Monaco, Menlo, Consolas, "Liberation Mono", "Courier New", monospace;
      word-break: break-all;
    }

    .diag-message {
      font-size: 14px;
      margin-bottom: 12px;
      color: var(--text-secondary);
      font-style: italic;
    }

    .incomplete-reason {
      font-size: 14px;
      color: var(--text-secondary);
      margin-bottom: 12px;
    }

    .incomplete-steps {
      padding-left: 20px;
      font-size: 14px;
      line-height: 1.6;
    }

    .incomplete-steps li {
      margin-bottom: 6px;
    }

    .incomplete-ref-link {
      font-size: 13px;
      color: var(--accent);
      margin-top: 12px;
      display: inline-block;
      text-decoration: none;
    }

    .incomplete-ref-link:hover {
      color: var(--accent-hover);
    }

    .diag-color-swatch {
      display: inline-block;
      width: 14px;
      height: 14px;
      border-radius: 3px;
      border: 1px solid var(--border-light);
      vertical-align: middle;
      margin-right: 6px;
    }

    /* Related nodes expandable list */
    .related-nodes {
      margin-top: 16px;
      border-top: 1px solid var(--border-medium);
      padding-top: 12px;
    }

    .related-nodes summary {
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-secondary);
      user-select: none;
      list-style: none;
      padding: 4px 0;
    }

    .related-nodes summary::-webkit-details-marker {
      display: none;
    }

    .related-nodes summary::before {
      content: "▸ ";
      display: inline-block;
      transition: transform 0.2s;
      margin-right: 6px;
      font-size: 20px;
    }

    .related-nodes[open] summary::before {
      transform: rotate(90deg);
    }

    .related-nodes-list {
      list-style: none;
      padding: 8px 0 0 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .related-node-item {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-medium);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 13px;
    }

    .related-node-target {
      font-family: "SF Mono", Monaco, Menlo, monospace;
      font-size: 12px;
      color: var(--text-tertiary);
      margin-bottom: 4px;
      word-break: break-all;
    }

    .related-node-html {
      font-family: "SF Mono", Monaco, Menlo, monospace;
      font-size: 12px;
      color: var(--text-secondary);
      background: var(--bg-primary);
      border: 1px solid var(--border-light);
      border-radius: 4px;
      padding: 6px 8px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }

    /* Required Manual Audits tab */
    .manual-level-heading {
      font-size: 22px;
      font-weight: 600;
      letter-spacing: -0.003em;
      margin: 32px 0 12px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .manual-level-heading:first-child {
      margin-top: 0;
    }
    .manual-level-count {
      font-size: 13px;
      color: var(--text-tertiary);
      background: var(--bg-secondary);
      padding: 4px 10px;
      border-radius: 12px;
      font-weight: 600;
    }
    .manual-level-group {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .manual-audit {
      border-left: 4px solid var(--severity-review);
    }
    .manual-audit[data-level="A"] {
      border-left-color: var(--severity-blocker);
    }
    .manual-audit[data-level="AA"] {
      border-left-color: var(--severity-severe);
    }
    .manual-audit[data-level="AAA"] {
      border-left-color: var(--severity-review);
    }
    .manual-steps {
      padding-left: 24px;
      margin: 8px 0 0;
      font-size: 15px;
      line-height: 1.6;
      color: var(--text-primary);
    }
    .manual-steps li {
      margin-bottom: 8px;
    }
    .manual-steps li:last-child {
      margin-bottom: 0;
    }
    .page-filter {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      margin: 16px 0 24px;
      padding: 14px 18px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-medium);
      border-radius: 14px;
      position: sticky;
      top: 8px;
      z-index: 5;
      backdrop-filter: blur(8px);
    }
    .page-filter label {
      font-weight: 600;
      color: var(--text-primary);
      font-size: 14px;
    }
    .page-filter select {
      flex: 1;
      min-width: 240px;
      max-width: 640px;
      padding: 8px 12px;
      border-radius: 10px;
      border: 1px solid var(--border-light);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 14px;
      font-family: inherit;
    }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <button class="theme-toggle" id="theme-toggle" aria-label="Toggle theme">
        <svg class="theme-icon-sun" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clip-rule="evenodd" />
        </svg>
        <svg class="theme-icon-moon" fill="currentColor" viewBox="0 0 20 20">
          <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
        </svg>
        <span id="theme-label">Light</span>
      </button>
      <h1>Accessibility Report</h1>
      <p class="subtitle">${targetLabel}</p>

      <div class="meta">
        <span class="meta-item"><strong>Level</strong> ${escape(state.plan.level)}</span>
        <span class="meta-item"><strong>Scan ID</strong> ${escape(state.scanId.slice(0, 8))}</span>
        <span class="meta-item"><strong>Duration</strong> ${(summary.durationMs / 1000).toFixed(1)}s</span>
        <span class="meta-item"><strong>Provider</strong> ${escape(state.meta.llmProvider.toUpperCase())}${state.meta.llmMockMode ? " (mock)" : ""}</span>
        <span class="meta-item"><strong>Cost</strong> $${summary.costUsd.toFixed(4)}</span>
      </div>
    </header>

    ${renderWcagSummaryBox(state, summary)}

    <div class="summary">${cards}</div>

    ${pageFilterSection}

    ${pagesSection}

    ${tabBar}

    ${
      summary.total === 0
        ? `<div class="empty">No findings detected at level ${escape(state.plan.level)}.</div>`
        : `
    <div role="tabpanel" id="panel-wcag" class="tab-panel" data-active="true" aria-labelledby="tab-wcag">
      ${wcagRuleSections}
    </div>

    <div role="tabpanel" id="panel-review" class="tab-panel" data-active="false" aria-labelledby="tab-review">
      ${reviewNeededSections}
    </div>

    <div role="tabpanel" id="panel-passes" class="tab-panel" data-active="false" aria-labelledby="tab-passes">
      ${passesSections}
    </div>

    <div role="tabpanel" id="panel-inapplicable" class="tab-panel" data-active="false" aria-labelledby="tab-inapplicable">
      ${inapplicableSections}
    </div>
    `
    }

    <div role="tabpanel" id="panel-manual" class="tab-panel" data-active="${summary.total === 0 ? "true" : "false"}" aria-labelledby="tab-manual">
      ${manualAuditsSection}
    </div>

    <footer>
      Generated by a11y-scout v${escape(state.meta.version)}.
      Findings labeled "Review" are AI-surfaced candidates and require human verification.
      a11y-scout never auto-claims AAA conformance. See <code>AGENTS.md</code> for the responsibility model.
    </footer>
  </div>

  ${pageCountsScript}

  <script>
    (function() {
      'use strict';

      // Theme toggle
      const themeToggle = document.getElementById('theme-toggle');
      const themeLabel = document.getElementById('theme-label');
      const html = document.documentElement;

      // Initialize theme from localStorage or system preference
      function initTheme() {
        const savedTheme = localStorage.getItem('a11y-report-theme');
        if (savedTheme) {
          html.setAttribute('data-theme', savedTheme);
          updateThemeLabel(savedTheme);
        } else {
          // Use system preference
          const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
          const theme = prefersDark ? 'dark' : 'light';
          html.setAttribute('data-theme', theme);
          updateThemeLabel(theme);
        }
      }

      function updateThemeLabel(theme) {
        if (themeLabel) {
          themeLabel.textContent = theme === 'dark' ? 'Dark' : 'Light';
        }
      }

      if (themeToggle) {
        themeToggle.addEventListener('click', () => {
          const currentTheme = html.getAttribute('data-theme');
          const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
          html.setAttribute('data-theme', newTheme);
          localStorage.setItem('a11y-report-theme', newTheme);
          updateThemeLabel(newTheme);
        });
      }

      initTheme();

      // Tab navigation
      const tabList = document.querySelector('[role="tablist"]');
      if (tabList) {
        const tabs = Array.from(tabList.querySelectorAll('[role="tab"]'));
        const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));

        function activateTab(tab) {
          // Deactivate all tabs
          tabs.forEach(t => {
            t.setAttribute('aria-selected', 'false');
            t.setAttribute('tabindex', '-1');
          });

          // Activate selected tab
          tab.setAttribute('aria-selected', 'true');
          tab.setAttribute('tabindex', '0');
          tab.focus();

          // Show corresponding panel
          const panelId = tab.getAttribute('aria-controls');
          panels.forEach(p => {
            if (p.id === panelId) {
              p.setAttribute('data-active', 'true');
            } else {
              p.setAttribute('data-active', 'false');
            }
          });
        }

        // Click handler
        tabList.addEventListener('click', (e) => {
          const tab = e.target.closest('[role="tab"]');
          if (tab) activateTab(tab);
        });

        // Keyboard navigation
        tabList.addEventListener('keydown', (e) => {
          const tab = e.target.closest('[role="tab"]');
          if (!tab) return;

          const currentIndex = tabs.indexOf(tab);
          let nextIndex = currentIndex;

          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            nextIndex = currentIndex === 0 ? tabs.length - 1 : currentIndex - 1;
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            nextIndex = currentIndex === tabs.length - 1 ? 0 : currentIndex + 1;
          } else if (e.key === 'Home') {
            e.preventDefault();
            nextIndex = 0;
          } else if (e.key === 'End') {
            e.preventDefault();
            nextIndex = tabs.length - 1;
          } else {
            return;
          }

          activateTab(tabs[nextIndex]);
        });
      }

      // Expand/Collapse All functionality for all views
      function setupExpandCollapseBtn(btnId, panelId) {
        const btn = document.getElementById(btnId);
        if (!btn) return;

        btn.addEventListener('click', () => {
          const panel = document.getElementById(panelId);
          if (!panel) return;

          const groups = panel.querySelectorAll('.group');
          const allOpen = Array.from(groups).every(g => g.hasAttribute('open'));

          groups.forEach(group => {
            if (allOpen) {
              group.removeAttribute('open');
            } else {
              group.setAttribute('open', '');
            }
          });

          btn.textContent = allOpen ? 'Expand All' : 'Collapse All';
        });
      }

      setupExpandCollapseBtn('wcag-expand-all', 'panel-wcag');
      setupExpandCollapseBtn('element-expand-all', 'panel-element');
      setupExpandCollapseBtn('manual-expand-all', 'panel-manual');
      setupExpandCollapseBtn('review-expand-all', 'panel-review');

      // Copy to clipboard functionality
      document.addEventListener('click', function(e) {
        const btn = e.target.closest('.btn-copy');
        if (!btn) return;

        const text = btn.dataset.copy;
        if (!text) return;

        // Try modern clipboard API first
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => {
            showCopySuccess(btn);
          }).catch(() => {
            fallbackCopy(text, btn);
          });
        } else {
          fallbackCopy(text, btn);
        }
      });

      function showCopySuccess(btn) {
        const original = btn.textContent;
        btn.textContent = '✓ Copied';
        btn.disabled = true;
        setTimeout(() => {
          btn.textContent = original;
          btn.disabled = false;
        }, 2000);
      }

      function fallbackCopy(text, btn) {
        // Fallback for non-HTTPS contexts or older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        try {
          const success = document.execCommand('copy');
          if (success) {
            showCopySuccess(btn);
          }
        } catch (err) {
          console.error('Copy failed:', err);
        } finally {
          document.body.removeChild(textarea);
        }
      }

      // Page filter — multi-page reports only. Hides finding cards + group
      // wrappers whose data-page-url(s) don't match the selected page, and
      // recomputes the summary numbers from a precomputed counts JSON block.
      const filterSelect = document.getElementById('page-filter-select');
      const countsNode = document.getElementById('a11y-page-counts');
      let pageCounts = null;
      if (countsNode) {
        try { pageCounts = JSON.parse(countsNode.textContent || 'null'); }
        catch (e) { pageCounts = null; }
      }

      function applyPageFilter(selected) {
        const showAll = selected === '__all__';

        document.querySelectorAll('.finding[data-page-url]').forEach(card => {
          if (showAll) {
            card.hidden = false;
          } else {
            const u = card.getAttribute('data-page-url');
            card.hidden = u !== selected;
          }
        });

        document.querySelectorAll('.group[data-page-urls]').forEach(grp => {
          if (showAll) {
            grp.hidden = false;
            return;
          }
          let urls = [];
          try { urls = JSON.parse(grp.getAttribute('data-page-urls') || '[]'); }
          catch (e) { urls = []; }
          grp.hidden = !urls.includes(selected);
        });

        // Severity groups built from already-grouped findings carry no
        // data-page-urls. Hide them when every child .finding is hidden.
        document.querySelectorAll('.group').forEach(grp => {
          if (grp.hasAttribute('data-page-urls')) return;
          const cards = grp.querySelectorAll('.finding');
          if (cards.length === 0) return;
          const anyVisible = Array.from(cards).some(c => !c.hidden);
          grp.hidden = !anyVisible;
        });

        if (pageCounts) {
          const entry = pageCounts[selected] || pageCounts.__all__;
          if (entry) {
            setText('summary-total', entry.total);
            setText('summary-passes', entry.passes);
            setText('summary-review', entry.reviewNeeded);
            setText('summary-na', entry.inapplicable);
            setText('tab-passes-count', entry.passes);
            setText('tab-review-count', entry.reviewNeeded);
            setText('tab-inapplicable-count', entry.inapplicable);
            document.querySelectorAll('.card[data-severity]').forEach(card => {
              const sev = card.getAttribute('data-severity');
              const countEl = card.querySelector('.count');
              if (countEl && entry[sev] != null) countEl.textContent = String(entry[sev]);
            });
          }
        }
      }

      function setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = String(value);
      }

      if (filterSelect) {
        filterSelect.addEventListener('change', e => applyPageFilter(e.target.value));
      }
    })();
  </script>
</body>
</html>`;
}

function renderWcagSummaryBox(state: ScanState, summary: ReturnType<typeof summarizeFindings>): string {
  // Calculate the counts
  const totalIssues = summary.total;
  const passedAudits = summary.passes;
  const requiresManualReview = state.findings.filter(f => f.requiresHumanReview).length;
  const notApplicable = summary.inapplicable;

  return `
    <div style="background: var(--bg-secondary); border-radius: 18px; padding: 32px; margin: 48px 0; border: 1px solid var(--border-medium);">
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 24px;">
        <svg width="24" height="24" viewBox="0 0 20 20" fill="currentColor" style="color: var(--text-secondary);">
          <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd" />
        </svg>
        <h2 style="margin: 0; font-size: 21px; font-weight: 600; color: var(--text-primary);">WCAG ${escape(state.plan.level)} Criteria:</h2>
      </div>

      <div style="display: grid; gap: 12px;">
        <!-- Total Issues -->
        <div style="background: var(--bg-primary); border-radius: 14px; padding: 20px; display: flex; align-items: center; justify-content: space-between; transition: all 0.2s ease;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="color: ${totalIssues > 0 ? "var(--severity-blocker)" : "var(--text-secondary)"};">
              <circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="2" fill="none"/>
              <path d="M10 6v4M10 14h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
            <span style="font-size: 16px; font-weight: 500; color: var(--text-primary);">Total Issues</span>
          </div>
          <span id="summary-total" style="font-size: 28px; font-weight: 600; color: ${totalIssues > 0 ? "var(--severity-blocker)" : "var(--text-secondary)"}; min-width: 60px; text-align: right;">${totalIssues}</span>
        </div>

        <!-- Passed Audits -->
        <div style="background: var(--bg-primary); border-radius: 14px; padding: 20px; display: flex; align-items: center; justify-content: space-between; transition: all 0.2s ease;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" style="color: var(--success);">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
            </svg>
            <span style="font-size: 16px; font-weight: 500; color: var(--text-primary);">Passed Audits</span>
          </div>
          <span id="summary-passes" style="font-size: 28px; font-weight: 600; color: var(--success); min-width: 60px; text-align: right;">${passedAudits}</span>
        </div>

        <!-- Required Manual Review -->
        <div style="background: var(--bg-primary); border-radius: 14px; padding: 20px; display: flex; align-items: center; justify-content: space-between; transition: all 0.2s ease;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" style="color: var(--severity-review);">
              <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" />
              <path fill-rule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clip-rule="evenodd" />
            </svg>
            <span style="font-size: 16px; font-weight: 500; color: var(--text-primary);">Required Manual Review</span>
          </div>
          <span id="summary-review" style="font-size: 28px; font-weight: 600; color: var(--severity-review); min-width: 60px; text-align: right;">${requiresManualReview}</span>
        </div>

        <!-- Not Applicable -->
        <div style="background: var(--bg-primary); border-radius: 14px; padding: 20px; display: flex; align-items: center; justify-content: space-between; transition: all 0.2s ease;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" style="color: var(--text-secondary);">
              <path fill-rule="evenodd" d="M13.477 14.89A6 6 0 015.11 6.524l8.367 8.368zm1.414-1.414L6.524 5.11a6 6 0 018.367 8.367zM18 10a8 8 0 11-16 0 8 8 0 0116 0z" clip-rule="evenodd" />
            </svg>
            <span style="font-size: 16px; font-weight: 500; color: var(--text-primary);">Not Applicable</span>
          </div>
          <span id="summary-na" style="font-size: 28px; font-weight: 600; color: var(--text-secondary); min-width: 60px; text-align: right;">${notApplicable}</span>
        </div>
      </div>
    </div>
  `;
}

function renderSection(sev: Severity, findings: Finding[]): string {
  const items = findings.map(renderFinding).join("\n");
  const pageUrlsAttr = findingsPageUrlsAttr(findings);
  return `
    <details class="group" data-severity="${sev}" ${pageUrlsAttr} open>
      <summary class="group-header">
        <svg class="chevron" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd" />
        </svg>
        <span class="group-title">${SEVERITY_LABEL[sev]}</span>
        <div class="group-meta">
          <span class="badge badge-${sev}">${sev}</span>
          <span class="badge-count">${findings.length} ${findings.length === 1 ? 'issue' : 'issues'}</span>
        </div>
      </summary>
      <div class="group-content">
        ${items}
      </div>
    </details>`;
}

/**
 * Build a `data-page-urls='[...]'` attribute (single-quoted JSON) from the
 * union of `pageUrl` values across a finding list. Empty string when no
 * finding carries `pageUrl` — the client-side filter then treats the group
 * as "always visible".
 */
function findingsPageUrlsAttr(findings: Finding[]): string {
  return pageUrlsAttr(extractFindingPageUrls(findings));
}

function extractFindingPageUrls(findings: Finding[]): string[] {
  const set = new Set<string>();
  for (const f of findings) {
    if (f.pageUrl) set.add(f.pageUrl);
  }
  return [...set];
}

function pageUrlsAttr(urls: string[]): string {
  if (urls.length === 0) return "";
  const json = JSON.stringify(urls)
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "\\u003c");
  return `data-page-urls='${json}'`;
}

function renderFinding(f: Finding): string {
  const badges: string[] = [];
  badges.push(
    `<span class="badge badge-${f.severity}">WCAG ${escape(f.wcagSc)} ${escape(f.wcagLevel)}</span>`,
  );
  badges.push(`<span class="badge badge-${f.severity}">${escape(f.source)}</span>`);
  if (f.aiGenerated && f.confidence) {
    badges.push(
      `<span class="badge badge-ai">AI ${escape(f.confidence)}</span>`,
    );
  }
  if (f.requiresHumanReview) {
    badges.push(`<span class="badge badge-review">Review needed</span>`);
  }

  const metaRows: string[] = [];

  if (f.ruleId) {
    const ruleLabel =
      f.relatedRuleIds.length > 0
        ? `${escape(f.ruleId)} <span class="meta-aux">(also: ${f.relatedRuleIds.map((r) => escape(r)).join(", ")})</span>`
        : escape(f.ruleId);
    metaRows.push(`
      <div class="meta-row">
        <span class="meta-label">Rule</span>
        <span class="meta-value">${ruleLabel}</span>
      </div>
    `);
  }

  if (f.pageUrl) {
    metaRows.push(`
      <div class="meta-row">
        <span class="meta-label">Page</span>
        <a href="${escape(f.pageUrl)}" target="_blank" rel="noopener" class="meta-value">${escape(truncateUrl(f.pageUrl, 80))}</a>
      </div>
    `);
  }

  if (f.filePath && f.line) {
    metaRows.push(`
      <div class="meta-row">
        <span class="meta-label">Location</span>
        <span class="meta-value">${escape(f.filePath)}:${f.line}:${f.column ?? 0}</span>
      </div>
    `);
  }

  if (f.selector) {
    metaRows.push(`
      <div class="meta-row">
        <span class="meta-label">Selector</span>
        <span class="meta-value">${escape(f.selector)}</span>
      </div>
    `);
  }

  const html = f.htmlSnippet
    ? `<pre><code>${escape(f.htmlSnippet.slice(0, 800))}</code></pre>`
    : "";

  let remediationHtml = "";
  if (f.incompleteData) {
    remediationHtml = renderIncompleteSplitPanel(f);
  } else if (f.remediation) {
    remediationHtml = `<div class="remediation"><strong class="remediation-label">How to fix</strong><div class="remediation-body">${formatRemediation(f.remediation)}</div></div>`;
  }

  const aiFixHtml = f.aiFixedHtml
    ? `<div class="ai-fixed-html">
        <div class="ai-fixed-html-label"><span class="ai-fixed-html-tag">AI</span>Suggested fix</div>
        <pre><code>${escape(f.aiFixedHtml)}</code></pre>
        <div class="ai-fixed-html-note">Advisory only — review before applying.</div>
      </div>`
    : "";

  const keyboardEvidenceSection = renderKeyboardEvidence(f);
  const focusVisibilitySection = renderFocusVisibilityEvidence(f);
  const focusIndicatorSection = renderFocusIndicatorEvidence(f);
  const modalLeakSection = renderModalLeakEvidence(f);
  const focusOrderSection = renderFocusOrderEvidence(f);

  const relatedNodesSection = renderRelatedNodes(f);

  // The canonical W3C Understanding doc (from the WCAG catalog) is the only link
  // rendered as "Learn More". docUrl (deque / GitHub rule docs) is intentionally omitted.
  const helpLinks: string[] = [];
  if (f.helpUrl) {
    helpLinks.push(
      `<a href="${escape(f.helpUrl)}" target="_blank" rel="noopener">Learn More</a>`,
    );
  }
  const helpLink =
    helpLinks.length > 0
      ? `<div class="finding-links">${helpLinks.join(" ")}</div>`
      : "";

  return `
    <div class="finding" data-page-url="${escape(f.pageUrl ?? "")}">
      <div class="finding-header">
        <h3 class="finding-title">${escape(f.title)}</h3>
        <div class="finding-badges">${badges.join("")}</div>
      </div>
      <p class="finding-desc">${escape(f.description)}</p>
      ${metaRows.length > 0 ? `<div class="finding-meta">${metaRows.join("")}</div>` : ""}
      ${html}
      ${keyboardEvidenceSection}
      ${focusVisibilitySection}
      ${focusIndicatorSection}
      ${modalLeakSection}
      ${focusOrderSection}
      ${remediationHtml}
      ${aiFixHtml}
      ${relatedNodesSection}
      ${helpLink}
    </div>`;
}

/**
 * Render structured evidence for a keyboard-trap finding: the direction, the
 * annotated focus cycle, the keys-attempted table, modal context, and the
 * screenshot of the trap point. Empty string for non-keyboard findings.
 */
function renderKeyboardEvidence(f: Finding): string {
  const ev = f.keyboardEvidence;
  if (!ev) return "";

  const directionLabel =
    ev.direction === "both"
      ? "Tab and Shift+Tab (both directions)"
      : ev.direction === "backward"
        ? "Shift+Tab (backward)"
        : "Tab (forward)";

  const cycleItems = ev.cycle
    .map((step, i) => {
      const name = step.name ? `“${escape(step.name)}”` : "<em>(no accessible name)</em>";
      return `
        <li class="kbd-cycle-step">
          <span class="kbd-cycle-num">${i + 1}</span>
          <span class="kbd-cycle-name">${name}</span>
          <span class="kbd-cycle-role">${escape(step.role)}</span>
          <code class="kbd-cycle-sel">${escape(step.selector)}</code>
        </li>`;
    })
    .join("");

  const cycleBlock =
    ev.cycle.length > 0
      ? `
        <div class="kbd-cycle">
          <div class="kbd-subtitle">Focus cycle (${ev.cycle.length} element${ev.cycle.length === 1 ? "" : "s"})</div>
          <ol class="kbd-cycle-list">${cycleItems}</ol>
          <div class="kbd-loopback">↺ returns to step 1 — focus never reached the page body</div>
        </div>`
      : "";

  const keyRows = ev.keysAttempted
    .map(
      (k) => `
        <tr>
          <td class="kbd-key"><kbd>${escape(k.key)}</kbd></td>
          <td class="kbd-key-result">${escape(k.result)}</td>
        </tr>`,
    )
    .join("");
  const keysBlock = ev.keysAttempted.length
    ? `<table class="kbd-keys-table"><thead><tr><th>Key</th><th>Result</th></tr></thead><tbody>${keyRows}</tbody></table>`
    : "";

  const modalBlock = ev.modal
    ? `
      <div class="kbd-modal">
        <div class="kbd-subtitle">Modal context</div>
        <div>Dialog: <code>${escape(ev.modal.selector)}</code></div>
        ${
          ev.modal.closeControl
            ? `<div>Close control found in cycle: “${escape(ev.modal.closeControl.name)}” (<code>${escape(ev.modal.closeControl.selector)}</code>) — present, but could not be safely activated automatically. Verify it dismisses the dialog for keyboard users.</div>`
            : `<div>No close control detected in the cycle.</div>`
        }
      </div>`
    : "";

  const shotBlock = ev.screenshotDataUri
    ? `
      <div class="kbd-shot">
        <div class="kbd-subtitle">Screenshot at trap point</div>
        <img class="kbd-shot-img" src="${ev.screenshotDataUri}" alt="Screenshot showing the trapped region outlined in red" />
      </div>`
    : "";

  return `
    <div class="kbd-evidence">
      <h4 class="kbd-evidence-title">Keyboard Trap Evidence</h4>
      <div class="kbd-direction"><strong>Trapped on:</strong> ${escape(directionLabel)}</div>
      ${cycleBlock}
      ${keysBlock}
      ${modalBlock}
      ${shotBlock}
    </div>`;
}

/** Point 1 — off-screen / invisible focus evidence. Empty for other findings. */
function renderFocusVisibilityEvidence(f: Finding): string {
  const ev = f.focusVisibilityEvidence;
  if (!ev) return "";
  const reasonLabel: Record<string, string> = {
    offscreen: "Off-screen (outside the viewport)",
    "display-none": "display:none (focusable but not rendered)",
    "visibility-hidden": "visibility:hidden",
    "opacity-zero": "opacity:0 (fully transparent)",
    "zero-area": "Zero width or height",
  };
  const guardNote =
    ev.reason === "offscreen" && ev.scrolledIntoViewFailed
      ? `<div class="kbd-modal">An explicit scrollIntoView() could not bring this element into view, so it is genuinely stranded off-screen — not merely below the fold.</div>`
      : "";
  const shotBlock = ev.screenshotDataUri
    ? `
      <div class="kbd-shot">
        <div class="kbd-subtitle">Screenshot at focus point</div>
        <img class="kbd-shot-img" src="${ev.screenshotDataUri}" alt="Screenshot showing the focused element outlined in red" />
      </div>`
    : "";
  return `
    <div class="kbd-evidence">
      <h4 class="kbd-evidence-title">Focus Visibility Evidence</h4>
      <div class="kbd-direction"><strong>Reason:</strong> ${escape(reasonLabel[ev.reason] ?? ev.reason)}</div>
      <div class="kbd-modal">Observed at Tab step ${ev.tabIndex}. Element rect: ${Math.round(ev.rect.width)}×${Math.round(ev.rect.height)} at (${Math.round(ev.rect.x)}, ${Math.round(ev.rect.y)}); viewport ${ev.viewport.width}×${ev.viewport.height}.</div>
      ${guardNote}
      ${shotBlock}
    </div>`;
}

/** Point 2 — focus-indicator evidence. Confirms indicator EXISTENCE, not contrast. */
function renderFocusIndicatorEvidence(f: Finding): string {
  const ev = f.focusIndicatorEvidence;
  if (!ev) return "";
  const verificationLabel =
    ev.verification === "screenshot-verified"
      ? "Screenshot-verified (no focus indicator pixels changed)"
      : ev.skipReason === "user-opt-out"
        ? "Style-delta only (screenshots disabled by --no-focus-indicator-screenshots)"
        : "Style-delta only (screenshot verification skipped under crawl)";
  const ratioBlock =
    typeof ev.changedPixelRatio === "number"
      ? `<div class="kbd-modal">Changed-pixel ratio between unfocused and focused: ${(ev.changedPixelRatio * 100).toFixed(2)}% (below the ${(0.5).toFixed(1)}% threshold for a detectable indicator).</div>`
      : "";
  const countBlock =
    typeof ev.candidateCount === "number"
      ? (() => {
          const rescanHint =
            ev.skipReason === "user-opt-out"
              ? "Rerun without <code>--no-focus-indicator-screenshots</code> to confirm."
              : "Rescan this URL outside the crawl (run a single-page scan) to confirm.";
          return `<div class="kbd-modal">${ev.candidateCount} focusable element${ev.candidateCount === 1 ? "" : "s"} on this page showed no computed-style focus indicator. ${rescanHint}</div>`;
        })()
      : "";
  const propsBlock = ev.comparedProperties.length
    ? `<div class="kbd-modal">Compared computed-style properties: <code>${ev.comparedProperties.map((p) => escape(p)).join(", ")}</code>.</div>`
    : "";
  const shotBlock = ev.screenshotDataUri
    ? `
      <div class="kbd-shot">
        <div class="kbd-subtitle">Focused-state screenshot</div>
        <img class="kbd-shot-img" src="${ev.screenshotDataUri}" alt="Screenshot of the element while keyboard-focused" />
      </div>`
    : "";
  return `
    <div class="kbd-evidence">
      <h4 class="kbd-evidence-title">Focus Indicator Evidence</h4>
      <div class="kbd-direction"><strong>Verification:</strong> ${escape(verificationLabel)}</div>
      ${ratioBlock}
      ${countBlock}
      ${propsBlock}
      <div class="kbd-modal"><em>Requires human review — this check confirms whether a focus indicator <strong>exists</strong>, not whether its contrast or size is sufficient.</em></div>
      ${shotBlock}
    </div>`;
}

/** Point 3 — modal focus leak evidence. Empty for other findings. */
function renderModalLeakEvidence(f: Finding): string {
  const ev = f.modalLeakEvidence;
  if (!ev) return "";
  const kindLabel: Record<string, string> = {
    "dialog-modal": "Top-layer modal (opened via showModal())",
    "modal-true": 'aria-modal="true"',
    "role-dialog": 'role="dialog" (modality not declared)',
  };
  const directionLabel =
    ev.direction === "backward" ? "Shift+Tab (backward)" : "Tab (forward)";
  const leakedName = ev.leakedToName
    ? `“${escape(ev.leakedToName)}”`
    : "<em>(no accessible name)</em>";
  const shotBlock = ev.screenshotDataUri
    ? `
      <div class="kbd-shot">
        <div class="kbd-subtitle">Screenshot of the open dialog</div>
        <img class="kbd-shot-img" src="${ev.screenshotDataUri}" alt="Screenshot showing the open modal dialog outlined in red" />
      </div>`
    : "";
  return `
    <div class="kbd-evidence">
      <h4 class="kbd-evidence-title">Modal Focus Leak Evidence</h4>
      <div class="kbd-direction"><strong>Leaked on:</strong> ${escape(directionLabel)}</div>
      <div class="kbd-modal">Dialog: <code>${escape(ev.modalSelector)}</code> — ${escape(kindLabel[ev.modalKind] ?? ev.modalKind)}.</div>
      <div class="kbd-modal">Focus left the dialog subtree to ${leakedName} <span class="kbd-cycle-role">${escape(ev.leakedToRole)}</span> (<code>${escape(ev.leakedToSelector)}</code>).</div>
      ${shotBlock}
    </div>`;
}

/** Point 4 — geometric tab-order divergence evidence. Empty for other findings. */
function renderFocusOrderEvidence(f: Finding): string {
  const ev = f.focusOrderEvidence;
  if (!ev) return "";

  // Build a lookup from selector → {name, role} using the rich tabOrder list so
  // the dom/visual selector-only lists can be shown human-readably.
  const meta = new Map(ev.tabOrder.map((s) => [s.selector, s]));
  const label = (sel: string): string => {
    const m = meta.get(sel);
    if (!m) return `<code class="kbd-cycle-sel">${escape(sel)}</code>`;
    const name = m.name ? `"${escape(m.name)}"` : "<em>(no name)</em>";
    return `${name} <span class="kbd-cycle-role">${escape(m.role)}</span> <code class="kbd-cycle-sel">${escape(sel)}</code>`;
  };

  const seqList = (selectors: string[]): string =>
    `<ol class="kbd-cycle-list">${selectors
      .map(
        (sel, i) =>
          `<li class="kbd-cycle-step"><span class="kbd-cycle-num">${i + 1}</span><span class="kbd-cycle-name">${label(sel)}</span></li>`,
      )
      .join("")}</ol>`;

  const tabSelectors = ev.tabOrder.map((s) => s.selector);

  const jumpsBlock = ev.jumps.length
    ? `<div class="kbd-modal"><div class="kbd-subtitle">Largest focus jumps (against reading order)</div>${ev.jumps
        .map(
          (j) =>
            `<div>From ${label(j.fromSelector)} → ${label(j.toSelector)} (reading-rank Δ ${j.visualRankDelta})</div>`,
        )
        .join("")}</div>`
    : "";

  return `
    <div class="kbd-evidence">
      <h4 class="kbd-evidence-title">Focus Order Evidence</h4>
      <div class="kbd-direction"><strong>Compared ${ev.elementCount} focusable element${ev.elementCount === 1 ? "" : "s"}</strong> (${ev.writingDirection.toUpperCase()} reading order).</div>
      <div class="kbd-modal">Keyboard order vs visual reading order: <strong>${(ev.tauTabVsVisual * 100).toFixed(0)}%</strong> of element pairs out of order. Keyboard order vs source order: <strong>${(ev.tauTabVsDom * 100).toFixed(0)}%</strong>. Both exceed their thresholds, so focus diverges from <em>both</em> what the eye and the source expect.</div>
      ${jumpsBlock}
      <div class="kbd-cycle">
        <div class="kbd-subtitle">Keyboard (Tab) order</div>
        ${seqList(tabSelectors)}
      </div>
      <div class="kbd-cycle">
        <div class="kbd-subtitle">Expected visual reading order</div>
        ${seqList(ev.visualOrderSelectors)}
      </div>
      <div class="kbd-modal"><em>Requires human review — reading order is subjective. This check flags a likely mismatch; confirm whether the tab sequence is logical for this page.</em></div>
    </div>`;
}

function renderIncompleteSplitPanel(f: Finding): string {
  const data = f.incompleteData;
  if (!data) return "";

  const guidance = getIncompleteGuidance(f.ruleId, data.checkId);

  const diagnosticPanel = renderDiagnosticData(data);
  const verifyPanel = renderVerificationSteps(guidance);

  return `
    <div class="incomplete-split-panel">
      ${diagnosticPanel}
      ${verifyPanel}
    </div>`;
}

// axe-core diagnostic data keys that aren't useful to surface in reports.
// `urlProps` (from identical-links-same-purpose) is a nested URL-parts object
// that renders as unhelpful noise (e.g. "[object Object]").
const DIAG_HIDDEN_KEYS = new Set(["urlProps"]);

function renderDiagnosticData(data: NonNullable<Finding["incompleteData"]>): string {
  let tableRows = "";

  if (data.data && typeof data.data === "object") {
    const entries = Object.entries(data.data as Record<string, unknown>)
      .filter(([k, v]) => v != null && v !== "" && !DIAG_HIDDEN_KEYS.has(k))
      .slice(0, 8);

    for (const [key, value] of entries) {
      const label = camelToLabel(key);
      const formattedValue = formatDiagValue(key, value);
      tableRows += `
        <tr>
          <td class="diag-key">${escape(label)}</td>
          <td class="diag-value">${formattedValue}</td>
        </tr>`;
    }
  }

  return `
    <div class="incomplete-diagnostic">
      <h4 class="incomplete-panel-title">Diagnostic Data</h4>
      <div class="diag-message">${escape(data.message)}</div>
      ${tableRows ? `<table class="diag-table">${tableRows}</table>` : ""}
    </div>`;
}

function renderRelatedNodes(f: Finding): string {
  if (!f.relatedNodes || f.relatedNodes.length === 0) return "";

  const items = f.relatedNodes
    .map(
      (rn) => `
      <li class="related-node-item">
        <div class="related-node-target">${escape(rn.target.join(" > "))}</div>
        <div class="related-node-html"><code>${escape(rn.html)}</code></div>
      </li>`
    )
    .join("");

  return `
    <details class="related-nodes">
      <summary>Related Elements (${f.relatedNodes.length})</summary>
      <ul class="related-nodes-list">
        ${items}
      </ul>
    </details>`;
}

function renderVerificationSteps(guidance: ReturnType<typeof getIncompleteGuidance>): string {
  const steps = guidance.verificationSteps
    .map((step) => `<li>${escape(step)}</li>`)
    .join("");

  const wcagLink = guidance.wcagRef
    ? `<a href="https://www.w3.org/WAI/WCAG22/Understanding/${guidance.wcagRef}" target="_blank" rel="noopener" class="incomplete-ref-link">WCAG ${guidance.wcagRef} →</a>`
    : "";

  return `
    <div class="incomplete-verify">
      <h4 class="incomplete-panel-title">What to Verify</h4>
      <div class="incomplete-reason">${escape(guidance.reason)}</div>
      <ol class="incomplete-steps">${steps}</ol>
      ${wcagLink}
    </div>`;
}

function camelToLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
    .trim();
}

function formatDiagValue(key: string, value: unknown): string {
  const strValue = String(value);

  // Check for hex color codes
  if (/^#[0-9a-fA-F]{6}$/i.test(strValue)) {
    return `<span class="diag-color-swatch" style="background-color: ${escape(strValue)};"></span>${escape(strValue)}`;
  }

  // Format numbers
  if (typeof value === "number") {
    return escape(strValue);
  }

  // Default: escape and return
  return escape(strValue);
}

function renderTabBar(
  passesCount: number,
  inapplicableCount: number,
  reviewNeededCount: number,
  manualAuditsTotal: number,
  hasFindings: boolean,
): string {
  // When the scan produced no findings, the WCAG / Review / Passes / N/A tabs
  // are still rendered above as empty panels — hide them in the tab bar so the
  // user lands directly on the static Manual Audits tab.
  const findingsTabs = hasFindings
    ? `
      <button role="tab" id="tab-wcag" aria-selected="true" aria-controls="panel-wcag" tabindex="0">
        By WCAG Rule
      </button>
      <button role="tab" id="tab-review" aria-selected="false" aria-controls="panel-review" tabindex="-1">
        Review Needed (<span id="tab-review-count">${reviewNeededCount}</span>)
      </button>
      <button role="tab" id="tab-passes" aria-selected="false" aria-controls="panel-passes" tabindex="-1">
        Passes (<span id="tab-passes-count">${passesCount}</span>)
      </button>
      <button role="tab" id="tab-inapplicable" aria-selected="false" aria-controls="panel-inapplicable" tabindex="-1">
        Not Applicable (<span id="tab-inapplicable-count">${inapplicableCount}</span>)
      </button>`
    : "";
  return `
    <div role="tablist" class="tab-bar" aria-label="Findings grouping">
      ${findingsTabs}
      <button role="tab" id="tab-manual" aria-selected="${hasFindings ? "false" : "true"}" aria-controls="panel-manual" tabindex="${hasFindings ? "-1" : "0"}">
        Required Manual Audits (${manualAuditsTotal})
      </button>
    </div>`;
}

function renderPassesView(passes: import("../types.js").PassedRule[]): string {
  if (passes.length === 0) {
    return `<div class="empty">No passed rules detected.</div>`;
  }

  const totalNodes = passes.reduce((sum, p) => sum + p.nodeCount, 0);

  const summaryCard = `
    <div class="card" style="background: var(--success-bg); border-color: var(--success); margin-bottom: 24px;">
      <div class="count" style="color: var(--success);">${totalNodes}</div>
      <div class="card-label">Elements Passed Checks</div>
    </div>
  `;

  const rows = passes
    .map((p) => {
      const attr = pageUrlsAttr(p.pageUrls);
      return `
        <details class="group" data-severity="pass" ${attr} style="border-color: var(--success);">
          <summary class="group-header">
            <svg class="chevron" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd" />
            </svg>
            <span class="group-title">${escape(p.ruleId)}</span>
            <div class="group-meta">
              <span class="badge" style="background: var(--success-bg); color: var(--success); font-size: 11px; padding: 4px 10px; border-radius: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;">WCAG ${escape(p.wcagSc)} (${escape(p.wcagLevel)})</span>
              <span class="badge-count" style="background: var(--success-bg); color: var(--success);">${p.nodeCount} nodes</span>
            </div>
          </summary>
          <div class="group-content">
            <p style="margin-bottom: 12px; color: var(--text-secondary);">${escape(p.description)}</p>
            ${p.helpUrl ? `<p style="margin-bottom: 0;"><a href="${escape(p.helpUrl)}" target="_blank" rel="noopener" style="color: var(--accent);">Learn more ↗</a></p>` : ""}
          </div>
        </details>
      `;
    })
    .join("\n");

  return summaryCard + rows;
}

function renderInapplicableView(inapplicable: import("../types.js").InapplicableRule[], isCrawl: boolean): string {
  if (inapplicable.length === 0) {
    return `<div class="empty">No inapplicable rules detected.</div>`;
  }

  const summary = `
    <div style="background: var(--bg-secondary); border: 1px solid var(--border-medium); border-radius: 12px; padding: 20px; margin-bottom: 24px;">
      <p style="color: var(--text-secondary); margin: 0;">
        These <strong>${inapplicable.length}</strong> rules found no matching elements on any scanned page.
        They represent checks that were not relevant to your content, not failures.
      </p>
    </div>
  `;

  const rows = inapplicable
    .map((r) => {
      const pagesList = isCrawl && r.pageUrls.length > 0
        ? `
          <details style="margin-top: 12px;">
            <summary style="cursor: pointer; color: var(--text-tertiary); font-size: 14px;">
              Pages (${Math.min(r.pageUrls.length, 5)}${r.pageUrls.length > 5 ? ` of ${r.pageUrls.length}` : ""})
            </summary>
            <ul style="margin: 8px 0 0 20px; font-size: 13px; color: var(--text-secondary);">
              ${r.pageUrls.slice(0, 5).map((url) => `<li>${escape(url)}</li>`).join("")}
              ${r.pageUrls.length > 5 ? `<li style="font-style: italic;">...and ${r.pageUrls.length - 5} more</li>` : ""}
            </ul>
          </details>
        `
        : "";

      const attr = pageUrlsAttr(r.pageUrls);
      return `
        <div class="group" ${attr} style="border: 1px solid var(--border-medium); border-radius: 12px; padding: 20px; margin-bottom: 12px;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <span style="font-weight: 600; font-size: 16px;">${escape(r.ruleId)}</span>
            <div style="display: flex; gap: 8px; align-items: center;">
              <span class="badge badge-minor">WCAG ${escape(r.wcagSc)} (${escape(r.wcagLevel)})</span>
              <span style="font-size: 13px; color: var(--text-tertiary);">No matching elements</span>
            </div>
          </div>
          <p style="color: var(--text-secondary); margin: 0;">${escape(r.description)}</p>
          ${r.helpUrl ? `<p style="margin-top: 8px; margin-bottom: 0;"><a href="${escape(r.helpUrl)}" target="_blank" rel="noopener" style="color: var(--accent); font-size: 14px;">Learn more ↗</a></p>` : ""}
          ${pagesList}
        </div>
      `;
    })
    .join("\n");

  return summary + rows;
}

/**
 * Render the static "Required Manual Audits" tab. Always rendered, content
 * does not depend on findings — this is the human checklist that complements
 * the automated coverage. Source: src/reports/manual-audits.ts.
 */
function renderManualAuditsView(): string {
  // Filter to show only "Manual Only" items in the report
  const grouped = manualAuditsByLevel("Manual Only");
  const total = manualAuditsCount("Manual Only");
  const counts = {
    A: grouped.A.length,
    AA: grouped.AA.length,
    AAA: grouped.AAA.length,
  };

  const intro = `
    <div style="background: var(--bg-secondary); border: 1px solid var(--border-medium); border-radius: 12px; padding: 20px; margin-bottom: 24px;">
      <p style="margin: 0 0 8px 0; font-size: 16px; color: var(--text-primary);">
        <strong>${total}</strong> WCAG 2.2 success criteria require manual audit because they cannot be fully automated by tools.
      </p>
      <p style="margin: 0; font-size: 14px; color: var(--text-secondary);">
        This list is the same on every report. Use it as your post-scan checklist — the automated findings on the other tabs cover what tools can prove; this tab covers the rest.
        Counts: <strong>${counts.A}</strong> at Level A · <strong>${counts.AA}</strong> at Level AA · <strong>${counts.AAA}</strong> at Level AAA.
      </p>
    </div>
    <div class="controls">
      <button class="btn" id="manual-expand-all" type="button">Expand All</button>
    </div>
  `;

  const sections = (["A", "AA", "AAA"] as const)
    .map((level) => {
      const audits = grouped[level];
      if (audits.length === 0) return "";
      const items = audits.map(renderManualAuditItem).join("\n");
      return `
        <h3 class="manual-level-heading">Level ${escape(level)} <span class="manual-level-count">${audits.length}</span></h3>
        <div class="manual-level-group">${items}</div>
      `;
    })
    .join("\n");

  return intro + sections;
}

function renderManualAuditItem(audit: ManualAudit): string {
  const categoryLabel: Record<ManualAudit["category"], string> = {
    manual: "Manual only",
    partial: "Partial automation — verify nuance",
    llm: "LLM-flagged — verify candidates",
  };
  const helpUrl = understandingUrlForSc(audit.sc);
  const steps = audit.howToTest
    .map((s) => `<li>${escape(s)}</li>`)
    .join("");

  return `
    <details class="group manual-audit" data-level="${escape(audit.level)}">
      <summary class="group-header">
        <svg class="chevron" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd" />
        </svg>
        <span class="group-title">WCAG ${escape(audit.sc)} ${escape(audit.title)}</span>
        <div class="group-meta">
          <span class="badge badge-review">Level ${escape(audit.level)}</span>
          <span class="badge badge-${audit.category === "manual" ? "blocker" : audit.category === "partial" ? "major" : "review"}">${escape(categoryLabel[audit.category])}</span>
        </div>
      </summary>
      <div class="group-content">
        <p style="margin: 0 0 12px 0; font-weight: 600; color: var(--text-primary);">How to test</p>
        <ol class="manual-steps">${steps}</ol>
        <p style="margin: 16px 0 0 0;">
          <a href="${escape(helpUrl)}" target="_blank" rel="noopener" style="font-size: 14px;">WCAG ${escape(audit.sc)} Understanding doc ↗</a>
        </p>
      </div>
    </details>
  `;
}

function renderWcagRuleView(findings: Finding[]): string {
  const grouped = groupByWcagRule(findings);
  if (grouped.size === 0) {
    return `<div class="empty">No findings detected.</div>`;
  }

  const controls = `
    <div class="controls">
      <button class="btn" id="wcag-expand-all" type="button">Expand All</button>
    </div>
  `;

  const sections = [...grouped.entries()]
    .map(([rule, items]) => {
      const maxSeverity = getMaxSeverity(items);
      return { rule, items, maxSeverity };
    })
    .sort((a, b) => {
      // Sort by severity first (blocker -> severe -> major -> minor -> review)
      const severityOrder: Record<Severity, number> = {
        blocker: 0,
        severe: 1,
        major: 2,
        minor: 3,
        review: 4,
      };
      const severityDiff = severityOrder[a.maxSeverity] - severityOrder[b.maxSeverity];
      if (severityDiff !== 0) return severityDiff;

      // If same severity, sort by WCAG SC numerically
      return compareSc(a.rule, b.rule);
    })
    .map(({ rule, items, maxSeverity }) => {
      const findingsHtml = items.map(renderFinding).join("\n");
      const pageUrlsAttr = findingsPageUrlsAttr(items);
      return `
        <details class="group" data-severity="${maxSeverity}" ${pageUrlsAttr} open>
          <summary class="group-header">
            <svg class="chevron" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd" />
            </svg>
            <span class="group-title">WCAG ${escape(rule)}</span>
            <div class="group-meta">
              <span class="badge badge-${maxSeverity}">${maxSeverity}</span>
              <span class="badge-count">${items.length} ${items.length === 1 ? 'issue' : 'issues'}</span>
            </div>
          </summary>
          <div class="group-content">
            ${findingsHtml}
          </div>
        </details>`;
    })
    .join("\n");

  return controls + sections;
}

function renderElementView(findings: Finding[]): string {
  const groups = groupByElementInstance(findings);
  if (groups.length === 0) {
    return `<div class="empty">No findings detected.</div>`;
  }

  const controls = `
    <div class="controls">
      <button class="btn" id="element-expand-all" type="button">Expand All</button>
      <span style="color: var(--text-tertiary); font-size: 14px; margin-left: auto;">${groups.length} unique elements</span>
    </div>`;

  const groupsHtml = groups
    .map((group) => {
      const findingsHtml = group.findings.map(renderFinding).join("\n");
      const techDetails = extractTechnicalDetails(group.findings[0]!);
      const techDetailsHtml = renderTechnicalDetailsNew(techDetails);
      const pageUrlsAttr = findingsPageUrlsAttr(group.findings);

      return `
        <details class="group" data-severity="${group.maxSeverity}" ${pageUrlsAttr} open>
          <summary class="group-header">
            <svg class="chevron" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd" />
            </svg>
            <span class="group-title">${escape(group.label)}</span>
            <div class="group-meta">
              <span class="badge badge-${group.maxSeverity}">&lt;${escape(group.tagName)}&gt;</span>
              <span class="badge badge-${group.maxSeverity}">${group.maxSeverity}</span>
              <span class="badge-count">${group.findings.length} ${group.findings.length === 1 ? 'issue' : 'issues'}</span>
            </div>
          </summary>
          <div class="group-content">
            ${techDetailsHtml}
            ${findingsHtml}
          </div>
        </details>`;
    })
    .join("\n");

  return controls + groupsHtml;
}

function renderReviewNeededView(findings: Finding[]): string {
  const reviewFindings = findings.filter(f => f.requiresHumanReview);

  if (reviewFindings.length === 0) {
    return `<div class="empty">No findings require human review.</div>`;
  }

  const infoBox = `
    <div style="background: var(--severity-review-bg); border: 1px solid var(--severity-review); border-radius: 12px; padding: 20px; margin-bottom: 24px;">
      <div style="display: flex; align-items: flex-start; gap: 12px;">
        <svg width="24" height="24" viewBox="0 0 20 20" fill="currentColor" style="color: var(--severity-review); flex-shrink: 0; margin-top: 2px;">
          <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd" />
        </svg>
        <div>
          <h3 style="margin: 0 0 8px 0; font-size: 17px; font-weight: 600; color: var(--text-primary);">Human Review Required</h3>
          <p style="margin: 0; color: var(--text-secondary); font-size: 15px; line-height: 1.5;">
            ${reviewFindings.length === 1
              ? `This <strong>1</strong> finding requires manual verification.`
              : `These <strong>${reviewFindings.length}</strong> findings require manual verification.`
            }
            AI-generated findings and certain complex accessibility checks need human judgment to confirm they are actual issues in your specific context.
          </p>
        </div>
      </div>
    </div>
  `;

  const controls = `
    <div class="controls">
      <button class="btn" id="review-expand-all" type="button">Collapse All</button>
    </div>
  `;

  // Group by WCAG rule, matching the "By WCAG Rule" tab structure
  const grouped = groupByWcagRule(reviewFindings);

  const sections = [...grouped.entries()]
    .map(([rule, items]) => {
      const maxSeverity = getMaxSeverity(items);
      return { rule, items, maxSeverity };
    })
    .sort((a, b) => {
      // Sort by severity first (blocker -> severe -> major -> minor -> review)
      const severityOrder: Record<Severity, number> = {
        blocker: 0,
        severe: 1,
        major: 2,
        minor: 3,
        review: 4,
      };
      const severityDiff = severityOrder[a.maxSeverity] - severityOrder[b.maxSeverity];
      if (severityDiff !== 0) return severityDiff;

      // If same severity, sort by WCAG SC numerically
      return compareSc(a.rule, b.rule);
    })
    .map(({ rule, items, maxSeverity }) => {
      const findingsHtml = items.map(renderFinding).join("\n");
      const pageUrlsAttr = findingsPageUrlsAttr(items);
      return `
        <details class="group" data-severity="${maxSeverity}" ${pageUrlsAttr} open>
          <summary class="group-header">
            <svg class="chevron" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd" />
            </svg>
            <span class="group-title">WCAG ${escape(rule)}</span>
            <div class="group-meta">
              <span class="badge badge-${maxSeverity}">${maxSeverity}</span>
              <span class="badge-count">${items.length} ${items.length === 1 ? 'issue' : 'issues'}</span>
            </div>
          </summary>
          <div class="group-content">
            ${findingsHtml}
          </div>
        </details>`;
    })
    .join("\n");

  return infoBox + controls + sections;
}

function renderTechnicalDetailsNew(details: TechnicalDetails): string {
  const sections: string[] = [];

  // Primary identifiers
  if (details.selector) {
    sections.push(`
      <div class="tech-section">
        <div class="tech-label">CSS Selector</div>
        <div class="tech-value">
          <code>${escape(details.selector)}</code>
          <button class="btn-copy" data-copy="${escape(details.selector)}" title="Copy selector">Copy</button>
        </div>
      </div>
    `);
  }

  if (details.elementId) {
    sections.push(`
      <div class="tech-section">
        <div class="tech-label">Element ID</div>
        <div class="tech-value">
          <code>#${escape(details.elementId)}</code>
        </div>
      </div>
    `);
  }

  if (details.classes.length > 0) {
    const classBadges = details.classes
      .slice(0, 8)
      .map((c) => `<span class="tech-badge">${escape(c)}</span>`)
      .join("");
    const more =
      details.classes.length > 8
        ? ` <span style="color: var(--text-tertiary); font-size: 12px;">+${details.classes.length - 8} more</span>`
        : "";
    sections.push(`
      <div class="tech-section">
        <div class="tech-label">Classes</div>
        <div class="tech-badges">${classBadges}${more}</div>
      </div>
    `);
  }

  if (sections.length === 0) return "";

  return `<div class="tech-details">${sections.join("")}</div>`;
}

interface PageCounts {
  blocker: number;
  severe: number;
  major: number;
  minor: number;
  review: number;
  total: number;
  passes: number;
  inapplicable: number;
  reviewNeeded: number;
}

type CountsByPage = Record<string, PageCounts>;

function emptyCounts(): PageCounts {
  return {
    blocker: 0,
    severe: 0,
    major: 0,
    minor: 0,
    review: 0,
    total: 0,
    passes: 0,
    inapplicable: 0,
    reviewNeeded: 0,
  };
}

function computePageCounts(state: ScanState): CountsByPage {
  const byPage: CountsByPage = { __all__: emptyCounts() };
  for (const url of state.meta.pagesScanned) {
    byPage[url] = emptyCounts();
  }
  for (const f of state.findings) {
    const all = byPage.__all__!;
    all[f.severity]++;
    all.total++;
    if (f.requiresHumanReview) all.reviewNeeded++;
    const bucket = f.pageUrl ? byPage[f.pageUrl] : undefined;
    if (bucket) {
      bucket[f.severity]++;
      bucket.total++;
      if (f.requiresHumanReview) bucket.reviewNeeded++;
    }
  }
  for (const p of state.passes) {
    byPage.__all__!.passes += p.nodeCount;
    for (const u of p.pageUrls) {
      const b = byPage[u];
      if (b) b.passes += p.nodeCount;
    }
  }
  for (const r of state.inapplicable) {
    byPage.__all__!.inapplicable += 1;
    for (const u of r.pageUrls) {
      const b = byPage[u];
      if (b) b.inapplicable += 1;
    }
  }
  return byPage;
}

function renderPageFilterControl(state: ScanState): string {
  const titleByUrl = new Map<string, string | undefined>();
  for (const ev of state.evidence) {
    titleByUrl.set(ev.url, ev.title);
  }
  const options = state.meta.pagesScanned
    .map((url) => {
      const title = titleByUrl.get(url);
      const visible = title
        ? `${escape(title)} — ${escape(truncateUrl(url, 60))}`
        : escape(truncateUrl(url, 80));
      return `<option value="${escape(url)}">${visible}</option>`;
    })
    .join("");
  return `
    <div class="page-filter">
      <label for="page-filter-select">Filter by page</label>
      <select id="page-filter-select">
        <option value="__all__">All pages (${state.meta.pagesScanned.length})</option>
        ${options}
      </select>
    </div>
  `;
}

function renderPagesSection(state: ScanState): string {
  const counts = new Map<string, number>();
  for (const f of state.findings) {
    if (!f.pageUrl) continue;
    counts.set(f.pageUrl, (counts.get(f.pageUrl) ?? 0) + 1);
  }
  const rows = state.meta.pagesScanned
    .map(
      (u) =>
        `<tr><td><a href="${escape(u)}" target="_blank" rel="noopener">${escape(u)}</a></td><td style="text-align:right">${counts.get(u) ?? 0}</td></tr>`,
    )
    .join("");
  const skipped = state.meta.pagesSkipped
    .map(
      (s) =>
        `<tr><td><code>${escape(s.url)}</code></td><td style="text-align:right;color:var(--muted)">skipped</td></tr>`,
    )
    .join("");
  return `
    <section class="section">
      <h2>Pages scanned (${state.meta.pagesScanned.length})</h2>
      <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
        <thead>
          <tr style="text-align:left;color:var(--muted);">
            <th style="padding:0.5rem 0;border-bottom:1px solid var(--border);">URL</th>
            <th style="padding:0.5rem 0;border-bottom:1px solid var(--border);text-align:right;">Findings</th>
          </tr>
        </thead>
        <tbody>${rows}${skipped}</tbody>
      </table>
    </section>`;
}

function groupBySeverity(findings: Finding[]): Record<Severity, Finding[]> {
  const out: Record<Severity, Finding[]> = {
    blocker: [],
    severe: [],
    major: [],
    minor: [],
    review: [],
  };
  for (const f of findings) {
    out[f.severity].push(f);
  }
  return out;
}

function groupByWcagRule(findings: Finding[]): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.wcagSc} ${f.wcagLevel}`;
    const existing = out.get(key);
    if (existing) {
      existing.push(f);
    } else {
      out.set(key, [f]);
    }
  }
  // Sort by WCAG SC numerically
  return new Map(
    [...out.entries()].sort((a, b) => compareSc(a[0], b[0]))
  );
}

interface ElementGroup {
  key: string;
  label: string;
  tagName: string;
  findings: Finding[];
  score: number;
  maxSeverity: Severity;
}

function groupByElementInstance(findings: Finding[]): ElementGroup[] {
  const instanceMap = new Map<string, Finding[]>();

  // Group findings by element instance
  for (const f of findings) {
    const key = deriveElementInstanceKey(f);
    const existing = instanceMap.get(key);
    if (existing) {
      existing.push(f);
    } else {
      instanceMap.set(key, [f]);
    }
  }

  // Convert to ElementGroup array with computed properties
  const groups: ElementGroup[] = [];
  const labelCounts = new Map<string, number>();

  for (const [key, groupFindings] of instanceMap.entries()) {
    const label = deriveElementLabel(groupFindings);
    const tagName = extractTagName(groupFindings[0]!);
    const score = elementGroupScore(groupFindings);
    const maxSeverity = getMaxSeverity(groupFindings);

    // Handle duplicate labels
    const count = labelCounts.get(label) ?? 0;
    labelCounts.set(label, count + 1);
    const uniqueLabel = count > 0 ? `${label} (${count})` : label;

    groups.push({
      key,
      label: uniqueLabel,
      tagName,
      findings: groupFindings,
      score,
      maxSeverity,
    });
  }

  // Sort by score (descending), then by count (descending), then alphabetically
  return groups.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.findings.length !== b.findings.length)
      return b.findings.length - a.findings.length;
    return a.label.localeCompare(b.label);
  });
}

function deriveElementInstanceKey(f: Finding): string {
  // Runtime scans: use URL + selector
  if (f.pageUrl && f.selector) {
    return `url:${f.pageUrl}|sel:${f.selector}`;
  }

  // Repo scans: use file path + line
  if (f.filePath && f.line) {
    return `file:${f.filePath}|line:${f.line}`;
  }

  // Fallback to finding ID if available
  return `finding:${f.id ?? Math.random()}`;
}

function parseHtmlSnippet(
  snippet: string | undefined,
): { tag: string; identifiers: Record<string, string> } {
  const identifiers: Record<string, string> = {};

  if (!snippet) {
    return { tag: "unknown", identifiers };
  }

  // Extract tag name
  const tagMatch = snippet.match(/<(\w+)/);
  const tag = tagMatch?.[1]?.toLowerCase() ?? "unknown";

  // Extract attributes
  const attrPatterns = [
    { name: "aria-label", regex: /aria-label=["']([^"']+)["']/i },
    { name: "alt", regex: /alt=["']([^"']+)["']/i },
    { name: "title", regex: /title=["']([^"']+)["']/i },
    { name: "id", regex: /id=["']([^"']+)["']/i },
    { name: "name", regex: /name=["']([^"']+)["']/i },
    { name: "href", regex: /href=["']([^"']+)["']/i },
    { name: "src", regex: /src=["']([^"']+)["']/i },
  ];

  for (const { name, regex } of attrPatterns) {
    const match = snippet.match(regex);
    if (match?.[1]) {
      identifiers[name] = match[1];
    }
  }

  // Extract text content (between tags)
  const textMatch = snippet.match(/>([^<]+)</);
  if (textMatch?.[1]) {
    const text = textMatch[1].trim();
    if (text.length > 0 && text.length < 50) {
      identifiers.text = text;
    }
  }

  return { tag, identifiers };
}

function deriveElementLabel(findings: Finding[]): string {
  const f = findings[0]!;
  const { tag, identifiers } = parseHtmlSnippet(f.htmlSnippet);

  // Use extractTagName which has better fallback logic
  const actualTag = extractTagName(f);

  // Use friendly tag name
  const tagDisplay = TAG_DISPLAY_NAME[actualTag] ?? actualTag.toUpperCase();

  // Build identifier part
  let identifier = "";

  // Prioritize human-readable identifiers
  if (identifiers["aria-label"]) {
    identifier = `'${truncate(identifiers["aria-label"], 40)}'`;
  } else if (identifiers.text) {
    identifier = `'${truncate(identifiers.text, 40)}'`;
  } else if (identifiers.alt) {
    identifier = `'${truncate(identifiers.alt, 40)}'`;
  } else if (identifiers.title) {
    identifier = `'${truncate(identifiers.title, 40)}'`;
  } else if (identifiers.src) {
    const filename = identifiers.src.split("/").pop() ?? identifiers.src;
    identifier = `'${truncate(filename, 40)}'`;
  } else if (identifiers.href) {
    const path = identifiers.href.split("?")[0] ?? identifiers.href;
    const display = path.split("/").pop() ?? path;
    identifier = `'${truncate(display, 40)}'`;
  } else if (identifiers.id) {
    identifier = `#${identifiers.id}`;
  } else if (identifiers.name) {
    identifier = `[name="${identifiers.name}"]`;
  }

  // Build location part
  let location = "";
  if (f.pageUrl) {
    try {
      const url = new URL(f.pageUrl);
      location = ` on ${url.pathname === "/" ? "/" : truncate(url.pathname, 30)}`;
    } catch {
      location = ` on ${truncate(f.pageUrl, 30)}`;
    }
  } else if (f.filePath && f.line) {
    const filename = f.filePath.split("/").pop() ?? f.filePath;
    location = ` in ${filename}:${f.line}`;
  }

  // Combine parts
  if (identifier) {
    return `${tagDisplay} ${identifier}${location}`;
  } else if (f.selector) {
    return `${tagDisplay} ${truncate(f.selector, 40)}${location}`;
  } else {
    return `${tagDisplay}${location}`;
  }
}

function elementGroupScore(findings: Finding[]): number {
  const weights: Record<Severity, number> = {
    blocker: 100,
    severe: 50,
    major: 20,
    minor: 5,
    review: 1,
  };

  return findings.reduce((sum, f) => sum + weights[f.severity], 0);
}

function extractTagName(f: Finding): string {
  const { tag } = parseHtmlSnippet(f.htmlSnippet);
  if (tag !== "unknown") return tag;

  // Try selector as fallback
  if (f.selector) {
    const match = f.selector.match(/^([a-z][a-z0-9]*)/i);
    if (match?.[1]) return match[1].toLowerCase();
  }

  // Try to infer from ESLint rule ID for static scanner findings
  if (f.source === "eslint-jsx-a11y" && f.ruleId) {
    const tagFromRule = inferTagFromEslintRule(f.ruleId);
    if (tagFromRule) return tagFromRule;
  }

  if (f.source === "eslint-angular-template" && f.ruleId) {
    const tagFromRule = inferTagFromAngularRule(f.ruleId);
    if (tagFromRule) return tagFromRule;
  }

  return "unknown";
}

/**
 * Infer HTML tag from ESLint jsx-a11y rule ID.
 * Returns the most likely element type for the rule.
 */
function inferTagFromEslintRule(ruleId: string): string | null {
  const ruleToTag: Record<string, string> = {
    "jsx-a11y/alt-text": "img",
    "jsx-a11y/anchor-has-content": "a",
    "jsx-a11y/anchor-is-valid": "a",
    "jsx-a11y/anchor-ambiguous-text": "a",
    "jsx-a11y/aria-activedescendant-has-tabindex": "div",
    "jsx-a11y/autocomplete-valid": "input",
    "jsx-a11y/click-events-have-key-events": "div",
    "jsx-a11y/control-has-associated-label": "button",
    "jsx-a11y/heading-has-content": "h1",
    "jsx-a11y/html-has-lang": "html",
    "jsx-a11y/iframe-has-title": "iframe",
    "jsx-a11y/img-redundant-alt": "img",
    "jsx-a11y/interactive-supports-focus": "div",
    "jsx-a11y/label-has-associated-control": "label",
    "jsx-a11y/label-has-for": "label",
    "jsx-a11y/media-has-caption": "video",
    "jsx-a11y/mouse-events-have-key-events": "div",
    "jsx-a11y/no-access-key": "input",
    "jsx-a11y/no-aria-hidden-on-focusable": "button",
    "jsx-a11y/no-autofocus": "input",
    "jsx-a11y/no-distracting-elements": "marquee",
    "jsx-a11y/no-interactive-element-to-noninteractive-role": "button",
    "jsx-a11y/no-noninteractive-element-interactions": "div",
    "jsx-a11y/no-noninteractive-element-to-interactive-role": "div",
    "jsx-a11y/no-noninteractive-tabindex": "div",
    "jsx-a11y/no-onchange": "select",
    "jsx-a11y/no-redundant-roles": "button",
    "jsx-a11y/no-static-element-interactions": "div",
    "jsx-a11y/prefer-tag-over-role": "div",
    "jsx-a11y/role-has-required-aria-props": "div",
    "jsx-a11y/role-supports-aria-props": "div",
    "jsx-a11y/tabindex-no-positive": "div",
  };

  return ruleToTag[ruleId] ?? null;
}

/**
 * Infer HTML tag from Angular template ESLint rule ID.
 * Returns the most likely element type for the rule.
 */
function inferTagFromAngularRule(ruleId: string): string | null {
  const ruleToTag: Record<string, string> = {
    "@angular-eslint/template/alt-text": "img",
    "@angular-eslint/template/elements-content": "button",
    "@angular-eslint/template/interactive-supports-focus": "div",
    "@angular-eslint/template/label-has-associated-control": "label",
    "@angular-eslint/template/click-events-have-key-events": "div",
    "@angular-eslint/template/mouse-events-have-key-events": "div",
    "@angular-eslint/template/no-autofocus": "input",
    "@angular-eslint/template/no-distracting-elements": "marquee",
    "@angular-eslint/template/role-has-required-aria": "div",
    "@angular-eslint/template/table-scope": "th",
    "@angular-eslint/template/valid-aria": "div",
  };

  return ruleToTag[ruleId] ?? null;
}

function getMaxSeverity(findings: Finding[]): Severity {
  const severityOrder: Severity[] = [
    "blocker",
    "severe",
    "major",
    "minor",
    "review",
  ];

  for (const severity of severityOrder) {
    if (findings.some((f) => f.severity === severity)) {
      return severity;
    }
  }

  return "review";
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

function compareSc(a: string, b: string): number {
  // Extract SC numbers and level: "1.3.1 AA" → [1, 3, 1], "AA"
  const parseKey = (key: string): [number[], string] => {
    const parts = key.split(" ");
    const sc = parts[0]?.split(".").map(Number) ?? [];
    const level = parts[1] ?? "";
    return [sc, level];
  };

  const [aSc, aLevel] = parseKey(a);
  const [bSc, bLevel] = parseKey(b);

  // Compare SC numerically
  for (let i = 0; i < Math.max(aSc.length, bSc.length); i++) {
    const aPart = aSc[i] ?? 0;
    const bPart = bSc[i] ?? 0;
    if (aPart !== bPart) return aPart - bPart;
  }

  // If SC is equal, compare level (A < AA < AAA)
  return aLevel.localeCompare(bLevel);
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatRemediation(text: string): string {
  const truncated = text.length > 600 ? text.slice(0, 600) + "…" : text;
  const escaped = escape(truncated);
  const withLinks = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`,
  );
  return withLinks.replace(/\n/g, "<br>");
}
