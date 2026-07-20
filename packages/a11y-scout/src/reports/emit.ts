import type { ScanState } from "../types.js";
import { writeHtmlReport } from "./html.js";
import { writeJsonReport } from "./json.js";
import { writeMarkdownReport } from "./markdown.js";
import { promoteToLatest } from "./output-dir.js";

export interface EmitReportsResult {
  jsonPath: string;
  mdPath: string;
  htmlPath: string;
}

/**
 * Write JSON, Markdown, and HTML reports for `state` under `outDir`, then
 * mirror them into `outDir/latest` so fix-repo and bookmarked links resolve
 * to a stable path. Single source of truth — used by both the CLI and the
 * Playwright fixture so report shape stays identical across surfaces.
 */
export async function emitReports(
  state: ScanState,
  outDir: string,
): Promise<EmitReportsResult> {
  const [jsonPath, mdPath, htmlPath] = await Promise.all([
    writeJsonReport(state, outDir),
    writeMarkdownReport(state, outDir),
    writeHtmlReport(state, outDir),
  ]);
  try {
    promoteToLatest(outDir);
  } catch {
    // Non-fatal: read-only fs / race. The timestamped reports are still
    // valid and the loader falls back to scanning them.
  }
  return { jsonPath, mdPath, htmlPath };
}
