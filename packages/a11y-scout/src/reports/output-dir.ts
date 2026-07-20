import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function buildReportDir(baseDir: string, target: string, mode: "url" | "repo" | "fixture"): string {
  const slug = mode === "repo" ? slugFromPath(target) : slugFromUrl(target);
  const timestamp = formatTimestamp(new Date());
  return resolve(baseDir, `${slug}-${timestamp}`);
}

/**
 * Copy the just-written report files into `<baseDir>/latest/` so
 * downstream tooling (fix-repo, links in docs) can rely on a stable path.
 * Symlinks would be tidier but break on Windows without admin rights, so
 * we copy. Cheap — three small files per scan.
 */
export function promoteToLatest(reportDir: string): string {
  const baseDir = dirname(reportDir);
  const latestDir = join(baseDir, "latest");
  if (existsSync(latestDir)) {
    rmSync(latestDir, { recursive: true, force: true });
  }
  mkdirSync(latestDir, { recursive: true });
  for (const name of ["report.json", "report.md", "report.html"]) {
    const src = join(reportDir, name);
    if (existsSync(src)) {
      copyFileSync(src, join(latestDir, name));
    }
  }
  return latestDir;
}

export function buildReportSlug(target: string, mode: "url" | "repo" | "fixture"): string {
  return mode === "repo" ? slugFromPath(target) : slugFromUrl(target);
}

function slugFromUrl(url: string): string {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/\./g, "-");
  } catch {
    return sanitize(url);
  }
}

function slugFromPath(path: string): string {
  return sanitize(basename(resolve(path)));
}

function sanitize(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "scan";
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}
