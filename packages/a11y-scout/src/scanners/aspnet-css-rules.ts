/**
 * ASP.NET CSS / LESS / SCSS accessibility rule checks.
 * Extracted from static.ts for maintainability.
 * Entry point: scanCssA11yPatterns()
 */
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import {
  type AspxScanIssue,
  type StaticScanProgressEvent,
  normalizePath,
  shouldSkipStaticFile,
  escapeRegex,
  getLineColumn,
  listFilesWithExtensions,
  logStaticPhaseWorkload,
  logStaticPhaseProgress,
} from "./aspnet-scanner-utils.js";

// ─── Phase scanner ─────────────────────────────────────────────────────────────

export async function scanCssA11yPatterns(
  repoPath: string,
  onProgress?: (event: StaticScanProgressEvent) => void,
): Promise<{ filesScanned: number; issues: AspxScanIssue[] }> {
  const cssExts = [".css", ".less", ".scss"];
  const files = await listFilesWithExtensions(repoPath, cssExts);
  const issues: AspxScanIssue[] = [];

  // Cap content fed to regex and skip deep heuristics on very large stylesheets.
  const CSS_SCAN_CONTENT_WINDOW = 256 * 1024;
  const CSS_DEEP_HEURISTICS_WINDOW = 128 * 1024;

  logStaticPhaseWorkload("aspnet:css-patterns", files.length);

  let processed = 0;

  for (const absPath of files) {
    let rawContent = "";
    try {
      rawContent = await readFile(absPath, "utf8");
    } catch {
      continue;
    }
    const relPath = normalizePath(relative(repoPath, absPath));
    if (shouldSkipStaticFile(relPath)) {
      continue;
    }
    if (hasCssSkipHeader(rawContent)) {
      continue;
    }
    const content = rawContent.length > CSS_SCAN_CONTENT_WINDOW
      ? rawContent.slice(0, CSS_SCAN_CONTENT_WINDOW)
      : rawContent;
    const scanContent = stripCssDataUrisForScan(content);
    const lowerContent = scanContent.toLowerCase();

    processed += 1;
    logStaticPhaseProgress(
      "aspnet:css-patterns",
      processed,
      files.length,
      relPath,
      onProgress,
    );

    const runDeepHeuristics = content.length <= CSS_DEEP_HEURISTICS_WINDOW;

    if (lowerContent.includes("outline")) {
      issues.push(...findOutlineNone(scanContent, relPath));
    }
    if (lowerContent.includes("pointer-events")) {
      issues.push(...findPointerEventsNone(scanContent, relPath));
    }
    if (lowerContent.includes("animation")) {
      issues.push(...findCssInfiniteAnimation(scanContent, relPath));
    }
    if (lowerContent.includes(":focus") || lowerContent.includes("focus-visible")) {
      issues.push(...findCssColorOnlyFocus(scanContent, relPath));
    }

    if (runDeepHeuristics && lowerContent.includes(":hover")) {
      issues.push(...findCssHoverOnlyReveal(scanContent, relPath));
    }

    if (lowerContent.includes("font-size")) {
      issues.push(...findCssFontSizeZero(scanContent, relPath));
      issues.push(...findCssFixedBaseFontPx(scanContent, relPath));
      issues.push(...findCssImportantFontSizePx(scanContent, relPath));
    }
    if (lowerContent.includes("line-height")) {
      issues.push(...findCssLineHeightImportantLow(scanContent, relPath));
    }

    if (
      runDeepHeuristics
      && (lowerContent.includes("!important")
        || lowerContent.includes("letter-spacing")
        || lowerContent.includes("word-spacing")
        || lowerContent.includes("margin")
        || lowerContent.includes("padding"))
    ) {
      issues.push(...findCssSpacingImportant(scanContent, relPath));
    }

    if (lowerContent.includes("min-width")) {
      issues.push(...findCssMinWidthWithoutFallback(scanContent, relPath));
    }

    if (
      runDeepHeuristics
      && (lowerContent.includes("width") || lowerContent.includes("height"))
      && (lowerContent.includes("button")
        || lowerContent.includes("[role=")
        || lowerContent.includes("input")
        || lowerContent.includes("select")
        || lowerContent.includes(" a")
        || lowerContent.startsWith("a")
        || lowerContent.includes(",a")
        || lowerContent.includes("\na"))
    ) {
      issues.push(...findCssTargetSizeTooSmall(scanContent, relPath));
    }
  }

  return { filesScanned: files.length, issues };
}

// ─── CSS / LESS / SCSS checks ──────────────────────────────────────────────────

function stripCssDataUrisForScan(content: string): string {
  return content.replace(/url\((['"]?)data:[^)'"]+\1\)/gi, "url(__A11Y_DATA_URI__)");
}

function findOutlineNone(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, "");
  // Match CSS rules that contain outline: none/0
  const ruleRegex = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const ruleMatch of stripped.matchAll(ruleRegex)) {
    const selector = (ruleMatch[1] ?? "").trim();
    const body = ruleMatch[2] ?? "";
    if (!/outline\s*:\s*(?:none|0)/i.test(body)) continue;

    // Only flag if selector targets a focusable element and applies at focus time.
    // Must contain :focus, :focus-visible, :focus-within or be an unqualified rule.
    const isFocusRule = /:(?:focus|focus-visible|focus-within)/i.test(selector);
    const isInteractiveSelector =
      /(button|a\b|input|select|textarea|\[role\s*=\s*['"](?:button|link|menuitem|tab|checkbox|radio)['"]|\[tabindex\s*(?:>|=)\s*['"]?0['"]?\])/i.test(selector);
    const isUnqualified = !/:/.test(selector) && isInteractiveSelector;

    if (!isFocusRule && !isUnqualified) continue;

    // Pass if the same selector (or paired :focus rule) provides an alternative indicator.
    const baseSel = selector.replace(/:focus(?:-visible|-within)?/g, "").trim();
    const hasFocusPair = new RegExp(escapeRegex(baseSel) + "\\s*:\\s*(?:focus|focus-visible|focus-within)\\s*\\{[^}]*(?:outline|box-shadow|border|background)[^}]*\\}", "i").test(stripped);
    if (hasFocusPair) continue;

    // Pass if an alternative focus indicator is set in the same rule or a paired rule.
    if (/(?:outline|box-shadow|border|background)\s*:/i.test(body)) continue;

    const index = ruleMatch.index ?? 0;
    const { line, column } = getLineColumn(stripped, index);
    issues.push({
      ruleId: "aspnet/css-outline-none",
      title: "outline:none removes the visible focus indicator",
      description:
        "`outline: none` suppresses the browser's default focus ring on a focusable element. " +
        "Provide an alternative focus indicator (box-shadow, border, or outline in another color) to help keyboard users see their position (WCAG 2.4.7 / 2.4.11).",
      wcagSc: "2.4.7",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 200),
    });
  }
  return issues;
}

function findPointerEventsNone(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const ruleRegex = /([^{}]+)\{([\s\S]*?)\}/g;
  const INTERACTIVE_TAGS = /(button|\ba\b|input|select|textarea)/i;
  const ARIA_WIDGET_ROLE = /role\s*=\s*['"](?:button|link|menuitem|tab|checkbox|radio|option)['"]\b/i;

  for (const match of content.matchAll(ruleRegex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (!/pointer-events\s*:\s*none/i.test(body)) continue;

    // Pass if selector targets descendants/decorative icon nodes.
    // e.g., "button svg", "button .icon", "button::before", etc.
    const isDescendantSelector = /\s+[.#\[>~:]|:(?:before|after|first-child|last-child)/i.test(selector);
    if (isDescendantSelector) continue;

    const decorativeTargetSelector =
      /(?:^|[\s>+~])(?:svg|i)\b|\.(?:icon|symbol)\b|::(?:before|after)\b/i.test(selector);
    if (decorativeTargetSelector) continue;

    // Must match an interactive element tag or role in the *base* selector itself.
    if (!INTERACTIVE_TAGS.test(selector) && !ARIA_WIDGET_ROLE.test(selector)) continue;

    // Pass if a sibling :hover / :focus / :active rule re-enables pointer-events.
    const baseSelector = selector.replace(/:[^\s{]+/g, "").trim();
    const siblingRulePattern = new RegExp(
      escapeRegex(baseSelector) + "\\s*:\\s*(?:hover|focus|active)\\s*\\{[^}]*pointer-events\\s*:",
      "i"
    );
    if (siblingRulePattern.test(content)) continue;

    const fullRule = match[0] ?? "";
    const openBraceOffset = fullRule.indexOf("{");
    const declarationOffset = body.search(/pointer-events\s*:\s*none/i);
    const index = (match.index ?? 0) + Math.max(0, openBraceOffset + 1) + Math.max(0, declarationOffset);
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-pointer-events-none",
      title: "pointer-events:none on interactive selectors blocks interaction",
      description:
        "An interactive element (button, link, input) has pointer-events:none, blocking all click/tap input. Use aria-disabled with keyboard handling for disabled states, or remove pointer-events:none (WCAG 2.1.1).",
      wcagSc: "2.1.1",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 200),
    });
  }

  return issues;
}

function findCssInfiniteAnimation(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const match of content.matchAll(regex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (!/animation-iteration-count\s*:\s*infinite/i.test(body)) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-infinite-animation",
      title: "Infinite animation detected",
      description: "animation-iteration-count: infinite can create persistent motion without a pause/stop mechanism (WCAG 2.2.2).",
      wcagSc: "2.2.2",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 200),
    });
  }

  return issues;
}

function findCssColorOnlyFocus(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  if (isThirdPartyStylesheetPath(filePath)) return issues;
  const focusBlockRegex = /([^{}]+:(?:focus|focus-visible)[^{}]*)\{([\s\S]*?)\}/gi;

  for (const match of content.matchAll(focusBlockRegex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (isThirdPartySelector(selector) && !isProjectOverrideFile(filePath)) continue;
    if (/(?:\.readOnly\b|\.disabled\b|\[readonly\]|\[disabled\]|\[aria-disabled\s*=\s*['"]true['"])/i.test(selector)) continue;

    const hasHighlightFocusClass = /\.highlightFocus\b/i.test(selector);
    if (hasHighlightFocusClass && /\b(?:background|background-color|border(?:-color|-width|-style)?|box-shadow)\s*:/i.test(body)) {
      continue;
    }

    // Author-declared intent: other well-known focus-class name tokens
    const hasDeclaredFocusClass = /\.(?:focusRing|hasFocus|keyboardFocus|visibleFocus)\b/i.test(selector);
    if (hasDeclaredFocusClass && /\b(?:background|background-color|border(?:-color|-width|-style)?|box-shadow)\s*:/i.test(body)) {
      continue;
    }

    const isFocusVisible = /:focus-visible/i.test(selector);
    if (!isFocusVisible) {
      const focusVisiblePair = buildPairedFocusVisibleSelector(selector);
      if (focusVisiblePair) {
        const pairRegex = new RegExp(`${escapeRegex(focusVisiblePair)}\\s*\\{([\\s\\S]*?)\\}`, "i");
        const pairBody = pairRegex.exec(content)?.[1] ?? "";
        if (pairBody && /\b(?:outline\s*:\s*(?!none\b|0\b)[^;]+|box-shadow\s*:[^;]+|border(?:-color|-width|-style)?\s*:[^;]+|background(?:-color)?\s*:[^;]+)/i.test(pairBody)) {
          continue;
        }
      }
    }

    const hasColor = /\bcolor\s*:\s*[^;]+/i.test(body);
    const hasBackgroundSignal = /\b(?:background|background-color)\s*:\s*[^;]+/i.test(body);
    const hasStrongIndicator = /\b(?:outline|box-shadow|border(?:-color|-width|-style)?|text-decoration|transform)\s*:/i.test(body);
    if (!hasColor || hasBackgroundSignal || hasStrongIndicator) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-focus-text-color-only",
      title: "Focus style appears text-color-only",
      description: "Focus indication appears to change only text color; include non-color indicators such as outline, border, shadow, text-decoration, or transform (WCAG 1.4.11 / 2.4.7).",
      wcagSc: "1.4.11",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

function findCssHoverOnlyReveal(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const ruleRegex = /([^{}]+)\{([\s\S]*?)\}/g;
  const rules = Array.from(content.matchAll(ruleRegex));

  const normalizeBaseSelector = (selector: string): string =>
    selector
      .replace(/:hover/gi, "")
      .replace(/:focus-visible/gi, "")
      .replace(/:focus-within/gi, "")
      .replace(/:focus/gi, "")
      .replace(/:active/gi, "")
      .replace(/\s+/g, " ")
      .trim();

  const revealsHiddenContent = (body: string): boolean => {
    return /\bdisplay\s*:\s*(?:block|inline|inline-block|flex|grid|table|table-row|table-cell)\b/i.test(body)
      || /\bvisibility\s*:\s*visible\b/i.test(body)
      || /\bopacity\s*:\s*1(?:\.0+)?\b/i.test(body)
      || /\btransform\s*:\s*[^;]*(?:scale\((?!0(?:\.0+)?)|translate[XY]?\((?!0(?:px|%|rem|em)?\)))/i.test(body)
      || /\b(?:height|max-height)\s*:\s*(?:[1-9]\d*|\d+\.\d+)(?:px|em|rem|%|vh)\b/i.test(body)
      || /\boverflow\s*:\s*(?:visible|auto|scroll)\b/i.test(body);
  };

  const isPurelyCosmeticChange = (body: string): boolean => {
    const hasRevealProperties = /\b(?:display|visibility|opacity|transform|height|max-height|overflow)\s*:/i.test(body);
    const hasColorOnly = /\b(?:color|background|background-color|border-color|text-decoration-color)\s*:/i.test(body);
    return !hasRevealProperties && hasColorOnly;
  };

  const extractSelectorClassNames = (selector: string): string[] =>
    Array.from(selector.matchAll(/\.([\w-]+)/g))
      .map((m) => m[1] ?? "")
      .filter(Boolean);

  const focusRevealBaseSelectors = new Set<string>();
  for (const rule of rules) {
    const selectorGroup = (rule[1] ?? "").trim();
    const body = rule[2] ?? "";
    if (!selectorGroup || !revealsHiddenContent(body) || isPurelyCosmeticChange(body)) continue;

    const selectors = selectorGroup.split(",").map((s) => s.trim()).filter(Boolean);
    for (const selector of selectors) {
      if (!/:(?:focus|focus-within|focus-visible)/i.test(selector)) continue;
      focusRevealBaseSelectors.add(normalizeBaseSelector(selector));
    }
  }

  const focusableClassNames = new Set<string>();
  const interactiveContextRegex = /class\s*=\s*['\"]([^'\"]+)['\"][\s\S]{0,600}?(?:<a\b|<button\b|<input\b|<select\b|<textarea\b|tabindex\s*=\s*['\"]?0)/gi;
  for (const match of content.matchAll(interactiveContextRegex)) {
    const classAttr = match[1] ?? "";
    for (const className of classAttr.split(/\s+/)) {
      const normalized = className.trim();
      if (normalized.length > 0) {
        focusableClassNames.add(normalized);
      }
    }
  }

  const hasFocusHandlers = /onfocus|focusin|addEventListener\s*\(\s*['\"]focus(?:in)?['\"]|\.on\s*\(\s*['\"]focus(?:in)?['\"]/i.test(content);
  const jsReferencedClassNames = new Set<string>();
  if (hasFocusHandlers) {
    const classSelectorRegex = /(?:querySelector|matches|closest)\s*\(\s*['\"][^'\"]*\.([\w-]+)/gi;
    for (const match of content.matchAll(classSelectorRegex)) {
      const className = (match[1] ?? "").trim();
      if (className.length > 0) {
        jsReferencedClassNames.add(className);
      }
    }

    const classContainsRegex = /classList\.contains\s*\(\s*['\"]([\w-]+)['\"]\s*\)/gi;
    for (const match of content.matchAll(classContainsRegex)) {
      const className = (match[1] ?? "").trim();
      if (className.length > 0) {
        jsReferencedClassNames.add(className);
      }
    }
  }

  const focusableContextCache = new Map<string, boolean>();
  const focusJsCompanionCache = new Map<string, boolean>();

  const baseHasFocusableContext = (baseSelector: string): boolean => {
    const cached = focusableContextCache.get(baseSelector);
    if (cached !== undefined) {
      return cached;
    }

    if (/(\ba\b|\bbutton\b|\binput\b|\bselect\b|\btextarea\b|\bsummary\b|\[tabindex|\[href|\[role\s*=\s*['"]?(?:button|link|menuitem|tab|option|treeitem|switch|checkbox|radio))/i.test(baseSelector)) {
      focusableContextCache.set(baseSelector, true);
      return true;
    }

    const classNames = extractSelectorClassNames(baseSelector);
    const hasFocusableClass = classNames.some((name) => focusableClassNames.has(name));
    focusableContextCache.set(baseSelector, hasFocusableClass);
    return hasFocusableClass;
  };

  const hasFocusJsCompanion = (baseSelector: string): boolean => {
    const cached = focusJsCompanionCache.get(baseSelector);
    if (cached !== undefined) {
      return cached;
    }

    if (!hasFocusHandlers) {
      focusJsCompanionCache.set(baseSelector, false);
      return false;
    }

    const classNames = extractSelectorClassNames(baseSelector);
    const hasCompanion = classNames.some((name) => jsReferencedClassNames.has(name));
    focusJsCompanionCache.set(baseSelector, hasCompanion);
    return hasCompanion;
  };

  for (const match of rules) {
    const selectorGroup = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    const selectors = selectorGroup.split(",").map((s) => s.trim()).filter(Boolean);
    const hoverSelectors = selectors.filter((s) => /:hover/i.test(s));
    if (hoverSelectors.length === 0) continue;
    if (!revealsHiddenContent(body)) continue;
    if (isPurelyCosmeticChange(body)) continue;

    for (const hoverSelector of hoverSelectors) {
      const baseSelector = normalizeBaseSelector(hoverSelector);
      if (!baseSelector) continue;

      // Skip false positives where the same grouped rule already includes focus equivalent.
      const hasFocusInSameRule = selectors.some((s) =>
        /:(?:focus|focus-within|focus-visible)/i.test(s) && normalizeBaseSelector(s) === baseSelector,
      );
      if (hasFocusInSameRule) continue;
      if (focusRevealBaseSelectors.has(baseSelector)) continue;

      if (!baseHasFocusableContext(baseSelector)) continue;
      if (hasFocusJsCompanion(baseSelector)) continue;

      const index = match.index ?? 0;
      const { line, column } = getLineColumn(content, index);
      issues.push({
        ruleId: "aspnet/css-hover-only-reveal",
        title: "Hover-only reveal without focus equivalent",
        description: "Rule reveals hidden content on :hover but no equivalent :focus/:focus-within/:focus-visible reveal was detected for keyboard users (WCAG 1.4.13).",
        wcagSc: "1.4.13",
        filePath,
        line,
        column,
        htmlSnippet: hoverSelector.slice(0, 220),
      });
    }
  }

  return issues;
}

function findCssLowContrastSameRule(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const ruleRegex = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const match of content.matchAll(ruleRegex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    const fg = parseColorFromCssProp(body, "color");
    const bg = parseColorFromCssProp(body, "background-color") ?? parseColorFromCssProp(body, "background");
    if (!fg || !bg) continue;

    const ratio = contrastRatio(fg, bg);
    const fontSize = parseCssPx(body, "font-size");
    const fontWeight = parseCssFontWeight(body);
    const isLarge = (fontSize !== null && fontSize >= 24) || (fontSize !== null && fontSize >= 18.5 && fontWeight >= 700);
    const threshold = isLarge ? 3 : 4.5;
    if (ratio >= threshold) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-low-contrast-same-rule",
      title: "Low text contrast detected in same CSS rule",
      description: `Same-rule foreground/background contrast is ${ratio.toFixed(2)}:1, below ${threshold}:1 threshold (${isLarge ? "large" : "normal"} text) (WCAG 1.4.3).`,
      wcagSc: "1.4.3",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

function findCssFontSizeZero(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const match of content.matchAll(regex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (!/\bfont-size\s*:\s*0(?:px|rem|em|%)?\b/i.test(body)) continue;

    const isVendor = /(jquery-ui|infragistics|\big-|\bui-)/i.test(filePath) || /(\big-|\bui-)/i.test(selector);
    const knownIconOrSpacer = /(\.ui-icon\b|\.icon\b|\.svg-|::before|::after|\.ui-menu-divider|\.ui-datepicker-row-break|\.ui-resizable-handle|\.ui-iggrid-)/i.test(selector);
    if (knownIconOrSpacer) continue;

    if (/(\bsvg\b|\bimg\b|input\s*\[\s*type\s*=\s*['"]image['"])/i.test(selector)) continue;

    const likelyTextSelector = /(\bp\b|\bh[1-6]\b|\bli\b|\btd\b|\bth\b|\blabel\b|\blegend\b|\bblockquote\b|\ba\b|\bbutton\b|\binput\b|\bselect\b|\btextarea\b|\.text\b|\.content\b|\.copy\b|\.caption\b|\.label\b|\.title\b)/i.test(selector);
    if (isVendor && !likelyTextSelector) continue;

    // Common whitespace-collapse pattern: parent font-size:0 and children restore font-size.
    const hasChildReset = new RegExp(`${escapeRegex(selector)}\\s*>?\\s*[^,{]+\\{[^}]*\\bfont-size\\s*:\\s*(?!0(?:px|rem|em|%)?\\b)[^;]+`, "i").test(content);
    if (hasChildReset) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: isVendor ? "aspnet/css-font-size-zero-informational" : "aspnet/css-font-size-zero",
      title: isVendor ? "font-size:0 can hide text content (informational)" : "font-size:0 can hide text content",
      description: isVendor
        ? "Vendor CSS uses font-size:0. Treat as informational unless visible text descendants are collapsed at runtime."
        : "font-size:0 on text-bearing selectors can remove readable text and hide content from sighted users (WCAG 1.4.4).",
      wcagSc: "1.4.4",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

function findCssFixedBaseFontPx(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  if (/\/font-(?:ar|he|ja|ko|zh|th|hi|bn)\.css$/i.test(normalizePath(filePath))) {
    return issues;
  }

  for (const match of content.matchAll(regex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (!hasRightmostHtmlOrBodyTarget(selector)) continue;
    if (selectorHasLanguageExemption(selector)) continue;
    if (!/\bfont-size\s*:\s*\d+(?:\.\d+)?px\b/i.test(body)) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-base-font-px",
      title: "Base html/body font-size set in px",
      description: "Fixed px base font sizes on html/body can reduce user text-resize flexibility in some environments (WCAG 1.4.4).",
      wcagSc: "1.4.4",
      filePath,
      line,
      column,
      htmlSnippet: selector,
    });
  }

  return issues;
}

function findCssImportantFontSizePx(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const match of content.matchAll(regex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (!/\bfont-size\s*:\s*\d+(?:\.\d+)?px\s*!important\b/i.test(body)) continue;

    // Exclude font-size:0 !important (covered by dedicated rule).
    if (/\bfont-size\s*:\s*0(?:\.0+)?px\s*!important\b/i.test(body)) continue;

    // Ignore decorative/icon-only containers.
    if (/(\.ui-icon\b|\.icon\b|\.svg-|::before|::after)/i.test(selector)) continue;

    // Only consider text-rendering selectors.
    if (!/(\bp\b|\bh[1-6]\b|\blabel\b|\blegend\b|\ba\b|\bbutton\b|\binput\b|\bselect\b|\btextarea\b|\.text\b|\.content\b|\.copy\b|\.caption\b)/i.test(selector)) {
      continue;
    }

    const isVendor = /(jquery-ui|infragistics|\big-|\bui-)/i.test(filePath) || /(\big-|\bui-)/i.test(selector);

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: isVendor ? "aspnet/css-font-size-px-important-informational" : "aspnet/css-font-size-px-important-warning",
      title: isVendor ? "font-size uses px with !important (informational)" : "font-size uses px with !important (warning)",
      description: isVendor
        ? "Vendor CSS uses px font-size with !important. Treat as informational unless override conflicts are observed at runtime."
        : "Using !important on px font-size is a best-practice warning. It may reduce user stylesheet override flexibility; prefer rem and avoid !important where possible.",
      wcagSc: "1.4.4",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

function findCssLineHeightImportantLow(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const match of content.matchAll(regex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    const lh = parseCssUnitlessOrNumber(body, "line-height");
    if (lh === null || lh >= 1.5) continue;
    if (!/\bline-height\s*:[^;]*!important\b/i.test(body)) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-line-height-important-low",
      title: "line-height < 1.5 with !important",
      description: "Forced low line-height with !important can block text-spacing adjustments needed by some users (WCAG 1.4.12).",
      wcagSc: "1.4.12",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

function findCssSpacingImportant(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  const nonTextContainerSelector =
    /(?:^|[\s>+~.#])(div|section|article|aside|main|nav|header|footer|wrapper|panel|container|layout|frame|viewer|chrome|splitter|resize-|foldersResize|ulc_|igdm_|ui-iggrid)/i;
  const textBearingSelector =
    /(^|[\s>+~,])(p|h[1-6]|li|td|th|label|legend|blockquote|a|button|input|select|textarea)\b|\.(?:text|content|copy|caption|label|title|description)\b/i;

  const parseImportantDeclarationValue = (body: string, prop: string): string | null => {
    const declRegex = new RegExp(`\\b${escapeRegex(prop)}\\s*:\\s*([^;]*?)!important\\b`, "i");
    const value = declRegex.exec(body)?.[1]?.trim();
    return value && value.length > 0 ? value : null;
  };

  const parseCssNumberUnit = (value: string): { num: number; unit: string } | null => {
    const m = /^(-?\d+(?:\.\d+)?)([a-z%]*)$/i.exec(value.trim());
    if (!m) return null;
    const num = Number(m[1]);
    const unit = (m[2] ?? "").toLowerCase();
    if (Number.isNaN(num)) return null;
    return { num, unit };
  };

  const isLikelyBlockingTextSpacingValue = (prop: string, rawValue: string): boolean => {
    const normalized = rawValue.trim().toLowerCase();
    if (/(inherit|initial|unset|normal|calc\(|var\()/i.test(normalized)) {
      return false;
    }

    const parsed = parseCssNumberUnit(normalized);
    if (!parsed) return false;
    const { num, unit } = parsed;

    // Do not flag values that already satisfy WCAG 1.4.12 spacing targets.
    if (prop === "line-height") {
      if (unit === "" && num >= 1.5) return false;
      if (unit === "%" && num >= 150) return false;
      if (unit === "em" && num >= 1.5) return false;
      // Fixed lengths or smaller values can block user overrides.
      return true;
    }

    if (prop === "letter-spacing") {
      if (unit === "em" && num >= 0.12) return false;
      if (unit === "px" && num >= 2) return false;
      return true;
    }

    if (prop === "word-spacing") {
      if (unit === "em" && num >= 0.16) return false;
      if (unit === "px" && num >= 3) return false;
      return true;
    }

    // Paragraph spacing target: 2em. Apply to margin/padding properties.
    if (prop === "margin" || prop === "margin-top" || prop === "margin-bottom" || prop === "padding") {
      if (unit === "em" && num >= 2) return false;
      if (unit === "px" && num >= 32) return false;
      return true;
    }

    return false;
  };

  for (const match of content.matchAll(regex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";

    // Only evaluate selectors likely to render text content.
    if (!textBearingSelector.test(selector)) continue;

    // Skip known structural/layout-only containers.
    if (nonTextContainerSelector.test(selector) && !/(p|h[1-6]|li|td|th|label|legend|blockquote|a|button|input|select|textarea)\b/i.test(selector)) {
      continue;
    }

    const importantTextSpacingProps = ["line-height", "letter-spacing", "word-spacing", "margin", "margin-top", "margin-bottom", "padding"];

    let shouldFlag = false;
    for (const prop of importantTextSpacingProps) {
      const value = parseImportantDeclarationValue(body, prop);
      if (!value) continue;

      // margin/padding should only be considered when selector is paragraph-like/text container.
      if ((prop === "margin" || prop === "margin-top" || prop === "margin-bottom" || prop === "padding") &&
        !/(p|li|td|th|blockquote|label|legend|h[1-6]|textarea|input|select|button|\.text|\.content|\.copy|\.description|\.caption)/i.test(selector)) {
        continue;
      }

      if (isLikelyBlockingTextSpacingValue(prop, value)) {
        shouldFlag = true;
        break;
      }
    }

    if (!shouldFlag) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-spacing-important",
      title: "Text spacing property forced with !important",
      description: "Forcing letter/word/paragraph spacing with !important can interfere with user text-spacing overrides (WCAG 1.4.12).",
      wcagSc: "1.4.12",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

function findCssMinWidthWithoutFallback(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const match of content.matchAll(regex)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    const minWidth = parseCssPx(body, "min-width");
    if (minWidth === null || minWidth <= 320) continue;
    if (!/(^|,|\s)(html|body|main|\.container|#app|\.layout-shell)\b/i.test(selector)) continue;

    const index = match.index ?? 0;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: "aspnet/css-min-width-large",
      title: "Large min-width on top-level container",
      description: "Top-level min-width above 320px may hinder narrow-viewport reflow unless responsive fallbacks exist (WCAG 1.4.10, heuristic).",
      wcagSc: "1.4.10",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

function findCssTargetSizeTooSmall(content: string, filePath: string): AspxScanIssue[] {
  const issues: AspxScanIssue[] = [];
  if (isThirdPartyStylesheetPath(filePath)) return issues;
  const regex = /([^{}]+)\{([\s\S]*?)\}/g;

  const parsePxDeclaration = (body: string, prop: string): number | null => {
    const m = new RegExp(`\\b${escapeRegex(prop)}\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\b`, "i").exec(body);
    if (!m?.[1]) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  };

  const parsePaddingPx = (body: string): { top: number; right: number; bottom: number; left: number } => {
    const fromSide = (prop: string): number => parsePxDeclaration(body, prop) ?? 0;

    const sideTop = fromSide("padding-top");
    const sideRight = fromSide("padding-right");
    const sideBottom = fromSide("padding-bottom");
    const sideLeft = fromSide("padding-left");
    if (sideTop || sideRight || sideBottom || sideLeft) {
      return { top: sideTop, right: sideRight, bottom: sideBottom, left: sideLeft };
    }

    const shorthand = /\bpadding\s*:\s*([^;]+?)(?:!important)?\s*(?:;|$)/i.exec(body)?.[1]?.trim() ?? "";
    if (!shorthand) return { top: 0, right: 0, bottom: 0, left: 0 };
    const values = shorthand.split(/\s+/).map((v) => {
      const m = /^(\d+(?:\.\d+)?)px$/i.exec(v.trim());
      return m?.[1] ? Number(m[1]) : NaN;
    });
    if (values.some((v) => Number.isNaN(v))) return { top: 0, right: 0, bottom: 0, left: 0 };
    if (values.length === 1) return { top: values[0] ?? 0, right: values[0] ?? 0, bottom: values[0] ?? 0, left: values[0] ?? 0 };
    if (values.length === 2) return { top: values[0] ?? 0, right: values[1] ?? 0, bottom: values[0] ?? 0, left: values[1] ?? 0 };
    if (values.length === 3) return { top: values[0] ?? 0, right: values[1] ?? 0, bottom: values[2] ?? 0, left: values[1] ?? 0 };
    return { top: values[0] ?? 0, right: values[1] ?? 0, bottom: values[2] ?? 0, left: values[3] ?? 0 };
  };

  const normalizeSelector = (selector: string): string => selector.replace(/\s+/g, " ").trim();
  const selectorList = Array.from(content.matchAll(regex)).map((m) => ({
    selector: (m[1] ?? "").trim(),
    body: m[2] ?? "",
    index: m.index ?? 0,
  }));

  // Precompute selectors that already enforce >=24px minimum size.
  const selectorsWithPairedMinRule = new Set<string>();
  for (const candidate of selectorList) {
    if (
      /\bmin-width\s*:\s*(2[4-9]|[3-9]\d|\d{3,})(?:\.\d+)?px\b/i.test(candidate.body)
      && /\bmin-height\s*:\s*(2[4-9]|[3-9]\d|\d{3,})(?:\.\d+)?px\b/i.test(candidate.body)
    ) {
      selectorsWithPairedMinRule.add(normalizeSelector(candidate.selector));
    }
  }

  for (const rule of selectorList) {
    const selector = rule.selector;
    const body = rule.body;

    if (isThirdPartySelector(selector) && !isProjectOverrideFile(filePath)) {
      continue;
    }

    const isVendor = /(jquery-ui|infragistics|\big-|ui-iggrid-|igdm_|\bui-|\bdx-|\bmat-|\bmdl-|\bant-|\.Mui)/i.test(filePath)
      || /(jquery-ui|infragistics|\big-|ui-iggrid-|igdm_|\bui-|\bdx-|\bmat-|\bmdl-|\bant-|\.Mui)/i.test(selector);
    const isScrollbarOrVendorPseudo = /::-webkit-scrollbar|::-webkit-scrollbar-button|scrollbar|\.ui-iggrid-|\.ig-|\.ui-/i.test(selector);
    const isKnownException = /(legend|swatch|chart|sparkline|thumbnail|icon-only|\.icon\b)/i.test(selector) || isScrollbarOrVendorPseudo;

    const targetsInteractive =
      /(\bbutton\b|\ba\b|\binput\b|\bselect\b|\[role\s*=\s*['"](?:button|link|menuitem|option|tab|treeitem|checkbox|radio|switch|gridcell)['"])/i.test(selector);
    if (!targetsInteractive) continue;

    // Inline prose links and footnote refs are spacing-exempt in WCAG 2.5.8.
    if (/\bp\s+a\b|\bprose\b[^,{]*\ba\b|\bfootnote\b|\bsup\s*a\b|a\.fnref\b/i.test(selector)) continue;

    // Background-image/icon sizing alone is not target-size evidence.
    if (/\bbackground-size\s*:/i.test(body) && !/\b(?:width|height)\s*:\s*\d+(?:\.\d+)?px\b/i.test(body)) continue;

    const width = parsePxDeclaration(body, "width");
    const height = parsePxDeclaration(body, "height");
    if (width === null || height === null) continue;
    if (width >= 24 || height >= 24) continue;

    const padding = parsePaddingPx(body);
    const effectiveWidth = width + padding.left + padding.right;
    const effectiveHeight = height + padding.top + padding.bottom;
    if (effectiveWidth >= 24 && effectiveHeight >= 24) continue;

    // Same-rule min sizes can satisfy the requirement.
    const minWidth = parsePxDeclaration(body, "min-width");
    const minHeight = parsePxDeclaration(body, "min-height");
    if ((minWidth ?? 0) >= 24 && (minHeight ?? 0) >= 24) continue;

    // Paired rules for the same selector may raise min dimensions.
    const normalized = normalizeSelector(selector);
    const hasPairedMinRule = selectorsWithPairedMinRule.has(normalized);
    if (hasPairedMinRule) continue;

    if (/input\s*\[\s*type\s*=\s*['"]?(?:checkbox|radio)['"]?\s*\]/i.test(selector)) {
      if (hasExpandedCheckboxRadioHitArea(content, selector, body)) {
        continue;
      }
    }

    if (hasSelectorContainerHitArea(content, selector, body)) {
      continue;
    }

    if (isKnownException && !isVendor) continue;

    const index = rule.index;
    const { line, column } = getLineColumn(content, index);
    issues.push({
      ruleId: isVendor ? "aspnet/css-target-size-too-small-informational" : "aspnet/css-target-size-too-small",
      title: isVendor
        ? "Interactive target size may be below 24x24px (informational)"
        : "Interactive target size may be below 24x24px",
      description: isVendor
        ? "Vendor stylesheet appears to set a small interactive target. Treat as informational; remediation may belong upstream."
        : "Small fixed interactive targets can be hard to operate by touch and motor-impaired users; aim for at least 24x24 CSS px (WCAG 2.5.8).",
      wcagSc: "2.5.8",
      filePath,
      line,
      column,
      htmlSnippet: selector.slice(0, 220),
    });
  }

  return issues;
}

// ─── CSS math / color helpers ─────────────────────────────────────────────────

function parseColorFromCssProp(body: string, prop: string): [number, number, number] | null {
  const regex = new RegExp(`\\b${escapeRegex(prop)}\\s*:\\s*([^;]+)`, "i");
  const value = regex.exec(body)?.[1]?.trim();
  if (!value) return null;

  const hexMatch = /^#([a-f0-9]{3}|[a-f0-9]{6})$/i.exec(value);
  if (hexMatch) {
    const hex = hexMatch[1] ?? "";
    if (hex.length === 3) {
      const h0 = hex.charAt(0);
      const h1 = hex.charAt(1);
      const h2 = hex.charAt(2);
      return [
        parseInt(h0 + h0, 16),
        parseInt(h1 + h1, 16),
        parseInt(h2 + h2, 16),
      ];
    }
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }

  const rgbMatch = /^rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(value);
  if (rgbMatch) {
    return [Number(rgbMatch[1] ?? 0), Number(rgbMatch[2] ?? 0), Number(rgbMatch[3] ?? 0)];
  }

  return null;
}

function relativeLuminance(rgb: [number, number, number]): number {
  const converted = rgb.map((v) => {
    const srgb = v / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  const r = converted[0] ?? 0;
  const g = converted[1] ?? 0;
  const b = converted[2] ?? 0;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseCssPx(body: string, prop: string): number | null {
  const regex = new RegExp(`\\b${escapeRegex(prop)}\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\b`, "i");
  const value = regex.exec(body)?.[1];
  return value ? Number(value) : null;
}

function parseCssFontWeight(body: string): number {
  const value = /\bfont-weight\s*:\s*(\d{3}|normal|bold)\b/i.exec(body)?.[1]?.toLowerCase();
  if (!value) return 400;
  if (value === "bold") return 700;
  if (value === "normal") return 400;
  return Number(value);
}

function parseCssUnitlessOrNumber(body: string, prop: string): number | null {
  const regex = new RegExp(`\\b${escapeRegex(prop)}\\s*:\\s*(\\d+(?:\\.\\d+)?)`, "i");
  const value = regex.exec(body)?.[1];
  return value ? Number(value) : null;
}

function hasCompensatingFocusStyle(content: string, index: number): boolean {
  const windowEnd = Math.min(content.length, index + 900);
  const window = content.slice(index, windowEnd);

  // If the same rule block declares a focus-visible/focus state with an
  // explicit outline/box-shadow, we treat outline:0 as intentional reset.
  const focusStyleRegex = /(?:&:)?:(?:focus-visible|focus)\b[\s\S]{0,220}?(?:outline\s*:\s*(?!none\b|0\b)[^;]+|box-shadow\s*:\s*[^;]+)/i;
  if (focusStyleRegex.test(window)) {
    return true;
  }

  // Also accept a direct positive focus ring after the reset within the same
  // local block, even if the selector isn't nested with &:focus-visible.
  const explicitFocusRingRegex = /(?:&:)?:(?:focus-visible|focus)\b[\s\S]{0,220}?outline\s*:\s*(?!none\b|0\b)[^;]+/i;
  return explicitFocusRingRegex.test(window);
}

// ─── CSS selector utilities ───────────────────────────────────────────────────

function hasRightmostHtmlOrBodyTarget(selectorGroup: string): boolean {
  const selectors = splitSelectors(selectorGroup);
  return selectors.some((selector) => {
    const rightmost = getRightmostSimpleSelector(selector);
    return rightmost === "html" || rightmost === "body";
  });
}

function selectorHasLanguageExemption(selectorGroup: string): boolean {
  return /:lang\s*\(\s*(?:ar|he|ja|ko|zh|th|hi|bn)\s*\)/i.test(selectorGroup);
}

function splitSelectors(selectorGroup: string): string[] {
  const selectors: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < selectorGroup.length; i += 1) {
    const ch = selectorGroup[i] ?? "";

    if (quote) {
      current += ch;
      if (ch === "\\") {
        const next = selectorGroup[i + 1] ?? "";
        if (next) {
          current += next;
          i += 1;
        }
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "(") {
      parenDepth += 1;
      current += ch;
      continue;
    }
    if (ch === ")") {
      if (parenDepth > 0) parenDepth -= 1;
      current += ch;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      current += ch;
      continue;
    }
    if (ch === "]") {
      if (bracketDepth > 0) bracketDepth -= 1;
      current += ch;
      continue;
    }

    if (ch === "," && parenDepth === 0 && bracketDepth === 0) {
      const token = current.trim();
      if (token) selectors.push(token);
      current = "";
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) selectors.push(tail);
  return selectors;
}

function getRightmostSimpleSelector(selector: string): string | null {
  const normalized = selector
    .replace(/\s+/g, " ")
    .replace(/::?[A-Za-z-]+(?:\([^)]*\))?/g, "")
    .trim();

  if (!normalized) return null;

  const parts = normalized
    .split(/\s*[>+~]\s*|\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const rightmost = parts[parts.length - 1] ?? "";
  if (!rightmost) return null;

  // Ignore compound selectors that include class/id/attrs in the rightmost token.
  if (/[.#\[]/.test(rightmost)) return null;

  const tag = rightmost.toLowerCase();
  return tag === "html" || tag === "body" ? tag : null;
}

// ─── CSS file / selector classification helpers ───────────────────────────────

function hasCssSkipHeader(content: string): boolean {
  const header = content.slice(0, 1600);
  if (/a11y-scan-skip-file\s*:/i.test(header)) return true;
  if (/\b(?:NOT\s+used|unused|deprecated|do\s+not\s+use)\b/i.test(header)) return true;
  return false;
}

function isProjectOverrideFile(filePath: string): boolean {
  return /(?:override|overrides|custom|site\.css)$/i.test(normalizePath(filePath));
}

function isThirdPartyStylesheetPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return /styles\/gis\/gismapviewer\.css$/i.test(normalized)
    || /reportingdashboards\/styles\/css\/dashboardviewer-[^/]+\.css$/i.test(normalized);
}

function isThirdPartySelector(selector: string): boolean {
  return /\.(?:ui-|ig-|ui-iggrid-|igdm_|dx-|mat-|mdl-|ant-|Mui)/i.test(selector);
}

// ─── CSS focus / hit-area helpers ─────────────────────────────────────────────

function buildPairedFocusVisibleSelector(selector: string): string | null {
  if (!/:focus(?!-visible)/i.test(selector)) return null;
  return selector.replace(/:focus(?!-visible)/gi, ":focus-visible");
}

function hasExpandedCheckboxRadioHitArea(content: string, selector: string, body: string): boolean {
  if (/\b(?:padding|min-width|min-height)\s*:/i.test(body)) return true;

  const base = selector
    .replace(/:focus-visible|:focus|:hover|:active/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const baseEscaped = escapeRegex(base);

  const expandedLabelRule = new RegExp(
    String.raw`${baseEscaped}[^{]*label[^{]*\{[^}]*\b(?:padding|min-width|min-height)\s*:\s*(?:2[4-9]|[3-9]\d|\d{3,})`,
    "i",
  );
  if (expandedLabelRule.test(content)) return true;

  const siblingLabelRule = new RegExp(
    String.raw`${baseEscaped}[^{]*(?:\+|~)\s*label[^{]*\{[^}]*\b(?:padding|min-width|min-height)\s*:`,
    "i",
  );
  if (siblingLabelRule.test(content)) return true;

  const wrapperRule = new RegExp(
    String.raw`(?:label|\.checkbox|\.radio|\.choice)[^{]*\{[^}]*\b(?:padding|min-width|min-height)\s*:\s*(?:2[4-9]|[3-9]\d|\d{3,})`,
    "i",
  );
  if (wrapperRule.test(content)) return true;

  return false;
}

function hasSelectorContainerHitArea(content: string, selector: string, body: string): boolean {
  if (/\b(?:padding|min-width|min-height)\s*:/i.test(body)) {
    const minWidth = parseCssPx(body, "min-width") ?? 0;
    const minHeight = parseCssPx(body, "min-height") ?? 0;
    const width = parseCssPx(body, "width") ?? 0;
    const height = parseCssPx(body, "height") ?? 0;
    if (Math.max(minWidth, width) >= 24 || Math.max(minHeight, height) >= 24) {
      return true;
    }
  }

  const classTokens = Array.from(selector.matchAll(/\.([A-Za-z_][\w-]*)/g)).map((m) => (m[1] ?? "").trim()).filter(Boolean);
  if (classTokens.length === 0) return false;

  for (const token of classTokens) {
    const escaped = escapeRegex(token);
    const classRule = new RegExp(
      String.raw`\.${escaped}(?:\b|[\s>+~:#\[])[^{]*\{[^}]*\b(?:padding|min-width|min-height)\s*:\s*(?:2[4-9]|[3-9]\d|\d{3,})`,
      "i",
    );
    if (classRule.test(content)) {
      return true;
    }

    const wrappedLabelRule = new RegExp(
      String.raw`\.${escaped}[^{]*(?:\+|~)?\s*label[^{]*\{[^}]*\b(?:padding|min-width|min-height)\s*:\s*(?:2[4-9]|[3-9]\d|\d{3,})`,
      "i",
    );
    if (wrappedLabelRule.test(content)) {
      return true;
    }
  }

  return false;
}

// hasCompensatingFocusStyle is used by findOutlineNone (above) but not exported.
// It's intentionally kept in this file rather than shared utils.
void hasCompensatingFocusStyle; // suppress unused-export lint if needed
