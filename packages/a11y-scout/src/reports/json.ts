import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScanState } from "../types.js";
import { summarizeFindings } from "../agents/graph.js";

export async function writeJsonReport(
  state: ScanState,
  outDir: string,
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, "report.json");
  const summary = summarizeFindings(state);
  const payload = {
    scanId: state.scanId,
    summary,
    plan: state.plan,
    findings: state.findings,
    passes: state.passes,
    inapplicable: state.inapplicable,
    evidence: state.evidence.map((e) => ({
      url: e.url,
      title: e.title,
      headings: e.headings,
    })),
    cost: state.cost,
    meta: state.meta,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
  await writeFile(path, JSON.stringify(payload, null, 2));
  return path;
}
