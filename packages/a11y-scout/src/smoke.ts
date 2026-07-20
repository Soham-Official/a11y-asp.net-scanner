/**
 * Smoke test: spins up a local HTTP server with a known-bad fixture page,
 * runs a11y-scout against it, and asserts that expected findings appear.
 *
 * Run via `npm run smoke`. Used in CI to catch regressions in the scanner pipeline.
 */
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { runScan, summarizeFindings } from "./agents/graph.js";
import { createLlmProvider } from "./llm/index.js";
import { writeHtmlReport } from "./reports/html.js";
import { writeJsonReport } from "./reports/json.js";
import { writeMarkdownReport } from "./reports/markdown.js";

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head><title>a11y-scout smoke fixture</title></head>
<body>
  <h1 style="color:#ddd;background:#fff">Welcome</h1>

  <!-- Missing alt text (WCAG 1.1.1) -->
  <img src="https://via.placeholder.com/150" />

  <!-- Empty link (WCAG 2.4.4) -->
  <a href="/somewhere"></a>

  <!-- Click-only handler, no keyboard support (WCAG 2.1.1) -->
  <div onclick="alert('hi')">Click me</div>

  <!-- Input without label (WCAG 3.3.2) -->
  <input type="text" />

  <!-- Generic link text (WCAG 2.4.4 / 2.4.9) -->
  <a href="/details">click here</a>
  <a href="/more">read more</a>
  <a href="/ts">TBA TLA OPI</a>

  <!-- Page lacks main landmark (best-practice) -->
  <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>
</body>
</html>`;

async function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveFn) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Failed to bind smoke server");
      }
      const url = `http://127.0.0.1:${addr.port}/`;
      const close = () =>
        new Promise<void>((r) => server.close(() => r()));
      resolveFn({ url, close });
    });
  });
}

async function main() {
  console.log(chalk.bold("a11y-scout smoke test"));
  console.log(chalk.dim("  Bringing up local fixture server..."));

  const { url, close } = await startFixtureServer();
  const outDir = await mkdtemp(join(tmpdir(), "a11y-scout-smoke-"));
  console.log(chalk.dim(`  Fixture: ${url}`));
  console.log(chalk.dim(`  Reports out: ${outDir}`));

  // Force mock mode so smoke test never spends real tokens.
  const llm = createLlmProvider({ provider: "mock" });

  try {
    const state = await runScan({
      mode: "url",
      target: url,
      level: "AAA",
      llm,
    });
    await Promise.all([
      writeJsonReport(state, outDir),
      writeMarkdownReport(state, outDir),
      writeHtmlReport(state, outDir),
    ]);

    const s = summarizeFindings(state);

    console.log("");
    console.log(chalk.bold("Findings"));
    console.log(`  Blockers: ${s.blockers}`);
    console.log(`  Severe:   ${s.severe}`);
    console.log(`  Major:    ${s.major}`);
    console.log(`  Minor:    ${s.minor}`);
    console.log(`  Review:   ${s.review}`);
    console.log(`  Total:    ${s.total}`);
    console.log("");

    const expectations: Array<[string, boolean, string]> = [
      [
        "Detects missing alt text (WCAG 1.1.1)",
        state.findings.some((f) => f.wcagSc === "1.1.1"),
        "image-alt rule should fire on the img tag",
      ],
      [
        "Detects empty/discernible-text link (WCAG 2.4.4)",
        state.findings.some(
          (f) =>
            f.ruleId === "link-name" ||
            f.wcagSc === "2.4.4" ||
            f.wcagSc === "4.1.2",
        ),
        "link-name rule should fire on the empty anchor",
      ],
      [
        "Detects unlabeled input (WCAG 3.3.2 / 4.1.2)",
        state.findings.some(
          (f) => f.wcagSc === "3.3.2" || f.wcagSc === "4.1.2" || f.ruleId === "label",
        ),
        "label rule should fire on the bare input",
      ],
      [
        "Reports total findings > 0",
        s.total > 0,
        "smoke fixture has known violations",
      ],
      [
        "Smoke runs in mock mode",
        state.meta.llmMockMode === true,
        "mock mode forced for repeatable CI",
      ],
    ];

    let failed = 0;
    console.log(chalk.bold("Assertions"));
    for (const [label, ok, hint] of expectations) {
      if (ok) {
        console.log(`  ${chalk.green("PASS")} ${label}`);
      } else {
        failed += 1;
        console.log(`  ${chalk.red("FAIL")} ${label}`);
        console.log(chalk.dim(`        ${hint}`));
      }
    }

    console.log("");
    console.log(chalk.bold("Reports written"));
    console.log(`  ${join(outDir, "report.html")}`);
    console.log(`  ${join(outDir, "report.md")}`);
    console.log(`  ${join(outDir, "report.json")}`);
    console.log("");

    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(chalk.red(`Smoke test crashed: ${(err as Error).message}`));
  if (process.env.DEBUG) console.error(err);
  process.exit(2);
});
