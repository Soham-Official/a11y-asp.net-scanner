/**
 * Apply generated fixes to source files.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FixAction, FixResult } from "../types.js";

/**
 * Lines on either side of `action.lineNumber` to consider when narrowing the
 * search. ~11 lines total covers realistic multi-line JSX elements; if the
 * action's `original` doesn't fit, we fall back to the whole-file path.
 */
const WINDOW_RADIUS = 5;

/**
 * Apply a single fix action to a file.
 *
 * Tries a line-scoped window match first when `action.lineNumber` is set —
 * the LLM can then describe a multi-line JSX element without having to
 * reproduce indentation byte-for-byte across the whole file. Falls back to
 * the whole-file match when the window is empty, ambiguous, or too small.
 */
export function applyFix(
  action: FixAction,
  repoRoot: string = process.cwd(),
): FixResult {
  const absolutePath = resolve(repoRoot, action.filePath);

  try {
    const content = readFileSync(absolutePath, "utf-8");
    const lines = content.split("\n");

    if (action.lineNumber && action.lineNumber > 0) {
      const start = Math.max(0, action.lineNumber - 1 - WINDOW_RADIUS);
      const end = Math.min(lines.length, action.lineNumber + WINDOW_RADIUS);
      const windowText = lines.slice(start, end).join("\n");
      const windowCount = countOccurrences(windowText, action.original);
      if (windowCount === 1) {
        const newWindow = windowText.replace(
          action.original,
          action.replacement,
        );
        const updatedLines = [
          ...lines.slice(0, start),
          ...newWindow.split("\n"),
          ...lines.slice(end),
        ];
        writeFileSync(absolutePath, updatedLines.join("\n"), "utf-8");
        return { action, applied: true };
      }
      // window match was 0 or >1 — fall through to whole-file path so we
      // still preserve today's behavior for single-line edits.
    }

    if (!content.includes(action.original)) {
      return {
        action,
        applied: false,
        error: "Original string not found in file (file may have changed)",
      };
    }

    const occurrences = countOccurrences(content, action.original);
    if (occurrences > 1) {
      return {
        action,
        applied: false,
        error: `Original string appears ${occurrences} times (ambiguous match)`,
      };
    }

    const updated = content.replace(action.original, action.replacement);
    writeFileSync(absolutePath, updated, "utf-8");

    return { action, applied: true };
  } catch (error) {
    return {
      action,
      applied: false,
      error:
        error instanceof Error ? error.message : "Unknown error applying fix",
    };
  }
}

/**
 * Apply multiple fixes, skipping failures.
 */
export function applyFixes(
  actions: FixAction[],
  repoRoot: string = process.cwd(),
): FixResult[] {
  return actions.map((action) => applyFix(action, repoRoot));
}

/**
 * Count occurrences of a substring.
 */
function countOccurrences(text: string, search: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

/**
 * Group fix results by category for commit organization.
 */
export function groupResultsByCategory(
  results: FixResult[],
): Map<string, FixResult[]> {
  const groups = new Map<string, FixResult[]>();

  for (const result of results) {
    const category = result.action.category;
    if (!groups.has(category)) {
      groups.set(category, []);
    }
    groups.get(category)!.push(result);
  }

  return groups;
}
