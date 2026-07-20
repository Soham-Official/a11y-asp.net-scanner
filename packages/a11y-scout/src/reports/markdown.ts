import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding, ScanState, Severity } from "../types.js";
import { summarizeFindings } from "../agents/graph.js";
import { getIncompleteGuidance } from "../incomplete-guidance.js";
import {
  manualAuditsByLevel,
  manualAuditsCount,
} from "./manual-audits.js";

const SEVERITY_BADGES: Record<Severity, string> = {
  blocker: "BLOCKER",
  severe: "SEVERE",
  major: "MAJOR",
  minor: "MINOR",
  review: "REVIEW",
};

export async function writeMarkdownReport(
  state: ScanState,
  outDir: string,
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, "report.md");
  const md = renderMarkdown(state);
  await writeFile(path, md);
  return path;
}

export function renderMarkdown(state: ScanState): string {
  const summary = summarizeFindings(state);
  const isCrawl = state.plan.crawl?.enabled ?? false;
  const pageCount = state.meta.pagesScanned.length;
  const isMultiPage = pageCount > 1;
  const targetLabel =
    state.plan.mode === "url"
      ? isCrawl
        ? `Crawl starting at \`${state.plan.target}\` (${pageCount} pages)`
        : `URL \`${state.plan.target}\``
      : state.plan.mode === "repo"
        ? `Repo \`${state.plan.target}\``
        : isMultiPage
          ? `Fixture \`${state.plan.target}\` (${pageCount} pages)`
          : `Fixture \`${state.plan.target}\``;

  const lines: string[] = [];
  lines.push(`# a11y-scout report`);
  lines.push("");
  lines.push(`- **Target:** ${targetLabel}`);
  lines.push(`- **WCAG level:** ${state.plan.level}`);
  lines.push(`- **Scan ID:** \`${state.scanId}\``);
  lines.push(
    `- **Started:** ${state.startedAt}  •  **Duration:** ${(summary.durationMs / 1000).toFixed(1)}s`,
  );
  lines.push(
    `- **LLM provider:** \`${state.meta.llmProvider.toUpperCase()}\`${state.meta.llmMockMode ? "  *(mock mode)*" : ""}`,
  );
  lines.push(`- **LLM cost:** $${summary.costUsd.toFixed(4)}`);
  lines.push("");

  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| Severity | Count |`);
  lines.push(`|---|---:|`);
  lines.push(`| Blocker | ${summary.blockers} |`);
  lines.push(`| Severe | ${summary.severe} |`);
  lines.push(`| Major | ${summary.major} |`);
  lines.push(`| Minor | ${summary.minor} |`);
  lines.push(`| Review (AI-flagged) | ${summary.review} |`);
  lines.push(`| **Total** | **${summary.total}** |`);
  lines.push(`| ✅ Passed checks | ${summary.passes} |`);
  lines.push(`| ℹ️ Not applicable | ${summary.inapplicable} |`);
  lines.push("");

  if (isMultiPage) {
    const counts = new Map<string, number>();
    for (const f of state.findings) {
      if (!f.pageUrl) continue;
      counts.set(f.pageUrl, (counts.get(f.pageUrl) ?? 0) + 1);
    }
    lines.push(`## Pages scanned (${state.meta.pagesScanned.length})`);
    lines.push("");
    lines.push(`| URL | Findings |`);
    lines.push(`|---|---:|`);
    for (const u of state.meta.pagesScanned) {
      lines.push(`| ${u} | ${counts.get(u) ?? 0} |`);
    }
    if (state.meta.pagesSkipped.length > 0) {
      lines.push("");
      lines.push(`_Skipped ${state.meta.pagesSkipped.length} URL(s) (timeouts, errors, or off-origin)._`);
    }
    lines.push("");
  }

  if (summary.total === 0) {
    lines.push(`> No findings detected at level ${state.plan.level}.`);
    lines.push("");
    return lines.join("\n");
  }

  const grouped = groupBySeverity(state.findings);
  for (const sev of [
    "blocker",
    "severe",
    "major",
    "minor",
    "review",
  ] as const) {
    const list = grouped[sev];
    if (!list.length) continue;
    lines.push(`## ${SEVERITY_BADGES[sev]} (${list.length})`);
    lines.push("");
    for (const f of list) {
      lines.push(`### ${f.title}`);
      lines.push("");
      const tagBits: string[] = [];
      tagBits.push(`WCAG ${f.wcagSc} (${f.wcagLevel})`);
      tagBits.push(`Source: ${f.source}`);
      tagBits.push(`Rule: \`${f.ruleId}\``);
      if (f.relatedRuleIds.length > 0)
        tagBits.push(
          `Also flagged by: ${f.relatedRuleIds.map((r) => `\`${r}\``).join(", ")}`,
        );
      if (f.aiGenerated && f.confidence)
        tagBits.push(`AI confidence: ${f.confidence}`);
      if (f.requiresHumanReview) tagBits.push(`**requires human review**`);
      lines.push(tagBits.join(" • "));
      lines.push("");
      lines.push(f.description);
      lines.push("");
      if (f.pageUrl) lines.push(`- Page: ${f.pageUrl}`);
      if (f.selector) lines.push(`- Selector: \`${f.selector}\``);
      if (f.filePath)
        lines.push(
          `- File: \`${f.filePath}${f.line ? `:${f.line}:${f.column ?? 0}` : ""}\``,
        );
      if (f.htmlSnippet) {
        lines.push("");
        lines.push("```html");
        lines.push(f.htmlSnippet.slice(0, 500));
        lines.push("```");
      }

      if (f.incompleteData) {
        const guidance = getIncompleteGuidance(f.ruleId, f.incompleteData.checkId);
        lines.push("");
        lines.push(`> **Diagnostic:** ${f.incompleteData.message}`);

        if (f.incompleteData.data && typeof f.incompleteData.data === "object") {
          const entries = Object.entries(
            f.incompleteData.data as Record<string, unknown>
          )
            .filter(([k, v]) => v != null && v !== "" && k !== "urlProps")
            .slice(0, 8);

          if (entries.length > 0) {
            lines.push(">");
            for (const [key, value] of entries) {
              const label = key
                .replace(/([A-Z])/g, " $1")
                .replace(/^./, (str) => str.toUpperCase())
                .trim();
              lines.push(`> - **${label}:** \`${String(value)}\``);
            }
          }
        }

        lines.push("");
        lines.push(`> **What to verify** (${guidance.label}):`);
        for (const [i, step] of guidance.verificationSteps.entries()) {
          lines.push(`> ${i + 1}. ${step}`);
        }

        if (guidance.wcagRef) {
          lines.push(">");
          lines.push(
            `> [WCAG ${guidance.wcagRef} →](https://www.w3.org/WAI/WCAG22/Understanding/${guidance.wcagRef})`
          );
        }
      } else if (f.remediation) {
        lines.push("");
        lines.push(`> ${f.remediation.slice(0, 600)}`);
      }

      if (f.aiFixedHtml) {
        lines.push("");
        lines.push("**AI Suggested Fix** _(advisory — review before applying)_");
        lines.push("");
        lines.push("```html");
        lines.push(f.aiFixedHtml);
        lines.push("```");
      }

      // Keyboard-trap evidence: direction, focus cycle, keys attempted, modal.
      if (f.keyboardEvidence) {
        const ev = f.keyboardEvidence;
        const directionLabel =
          ev.direction === "both"
            ? "Tab and Shift+Tab (both directions)"
            : ev.direction === "backward"
              ? "Shift+Tab (backward)"
              : "Tab (forward)";
        lines.push("");
        lines.push(`> **Keyboard trap evidence**`);
        lines.push(`> - Trapped on: **${directionLabel}**`);

        if (ev.cycle.length > 0) {
          lines.push(">");
          lines.push(`> Focus cycle (${ev.cycle.length} element${ev.cycle.length === 1 ? "" : "s"}):`);
          for (const [i, step] of ev.cycle.entries()) {
            const name = step.name ? `"${step.name}"` : "(no accessible name)";
            lines.push(`> ${i + 1}. ${name} — \`${step.role}\` \`${step.selector}\``);
          }
          lines.push(`> ↺ returns to step 1 — focus never reached the page body`);
        }

        if (ev.keysAttempted.length > 0) {
          lines.push(">");
          lines.push(`> | Key | Result |`);
          lines.push(`> |---|---|`);
          for (const k of ev.keysAttempted) {
            lines.push(`> | \`${k.key}\` | ${k.result} |`);
          }
        }

        if (ev.modal) {
          lines.push(">");
          lines.push(`> Modal: \`${ev.modal.selector}\``);
          if (ev.modal.closeControl) {
            lines.push(
              `> Close control in cycle: "${ev.modal.closeControl.name}" (\`${ev.modal.closeControl.selector}\`) — present but not auto-verified.`,
            );
          }
        }

        if (ev.screenshotDataUri) {
          lines.push(">");
          lines.push(`> 📸 Screenshot of the trap point is embedded in the HTML report.`);
        }
      }

      // Point 1 — off-screen / invisible focus.
      if (f.focusVisibilityEvidence) {
        const ev = f.focusVisibilityEvidence;
        const reasonLabel: Record<string, string> = {
          offscreen: "off-screen (outside the viewport)",
          "display-none": "display:none (focusable but not rendered)",
          "visibility-hidden": "visibility:hidden",
          "opacity-zero": "opacity:0 (fully transparent)",
          "zero-area": "zero width or height",
        };
        lines.push("");
        lines.push(`> **Focus visibility evidence**`);
        lines.push(`> - Reason: **${reasonLabel[ev.reason] ?? ev.reason}**`);
        lines.push(
          `> - Observed at Tab step ${ev.tabIndex}; rect ${Math.round(ev.rect.width)}×${Math.round(ev.rect.height)} at (${Math.round(ev.rect.x)}, ${Math.round(ev.rect.y)}), viewport ${ev.viewport.width}×${ev.viewport.height}.`,
        );
        if (ev.reason === "offscreen" && ev.scrolledIntoViewFailed) {
          lines.push(
            `> - An explicit scrollIntoView() could not bring it into view — genuinely stranded off-screen.`,
          );
        }
        if (ev.screenshotDataUri) {
          lines.push(`> 📸 Screenshot embedded in the HTML report.`);
        }
      }

      // Point 2 — focus indicator (existence, not contrast).
      if (f.focusIndicatorEvidence) {
        const ev = f.focusIndicatorEvidence;
        lines.push("");
        lines.push(`> **Focus indicator evidence**`);
        const verificationLabel =
          ev.verification === "screenshot-verified"
            ? "screenshot-verified (no indicator pixels changed)"
            : ev.skipReason === "user-opt-out"
              ? "style-delta only (screenshots disabled by `--no-focus-indicator-screenshots`)"
              : "style-delta only (screenshots skipped under crawl)";
        lines.push(`> - Verification: **${verificationLabel}**`);
        if (typeof ev.changedPixelRatio === "number") {
          lines.push(
            `> - Changed-pixel ratio focused vs unfocused: ${(ev.changedPixelRatio * 100).toFixed(2)}% (below the 0.5% detection threshold).`,
          );
        }
        if (typeof ev.candidateCount === "number") {
          const rescanHint =
            ev.skipReason === "user-opt-out"
              ? "rerun without `--no-focus-indicator-screenshots` to confirm."
              : "rescan this URL outside the crawl (run a single-page scan) to confirm.";
          lines.push(
            `> - ${ev.candidateCount} element${ev.candidateCount === 1 ? "" : "s"} showed no computed-style indicator; ${rescanHint}`,
          );
        }
        lines.push(
          `> - _Requires human review — confirms indicator existence, not contrast/size._`,
        );
        if (ev.screenshotDataUri) {
          lines.push(`> 📸 Focused-state screenshot embedded in the HTML report.`);
        }
      }

      // Point 3 — modal focus leak.
      if (f.modalLeakEvidence) {
        const ev = f.modalLeakEvidence;
        const kindLabel: Record<string, string> = {
          "dialog-modal": "top-layer modal (showModal())",
          "modal-true": 'aria-modal="true"',
          "role-dialog": 'role="dialog" (modality not declared)',
        };
        const directionLabel =
          ev.direction === "backward" ? "Shift+Tab (backward)" : "Tab (forward)";
        const leakedName = ev.leakedToName
          ? `"${ev.leakedToName}"`
          : "(no accessible name)";
        lines.push("");
        lines.push(`> **Modal focus leak evidence**`);
        lines.push(`> - Leaked on: **${directionLabel}**`);
        lines.push(`> - Dialog: \`${ev.modalSelector}\` — ${kindLabel[ev.modalKind] ?? ev.modalKind}.`);
        lines.push(
          `> - Focus left the dialog to ${leakedName} \`${ev.leakedToRole}\` \`${ev.leakedToSelector}\`.`,
        );
        if (ev.screenshotDataUri) {
          lines.push(`> 📸 Screenshot embedded in the HTML report.`);
        }
      }

      // Point 4 — geometric tab-order divergence.
      if (f.focusOrderEvidence) {
        const ev = f.focusOrderEvidence;
        const meta = new Map(ev.tabOrder.map((s) => [s.selector, s] as const));
        const label = (sel: string): string => {
          const m = meta.get(sel);
          if (!m) return `\`${sel}\``;
          const name = m.name ? `"${m.name}"` : "(no name)";
          return `${name} \`${m.role}\` \`${sel}\``;
        };
        lines.push("");
        lines.push(`> **Focus order evidence**`);
        lines.push(
          `> - Compared ${ev.elementCount} focusable elements (${ev.writingDirection.toUpperCase()} reading order).`,
        );
        lines.push(
          `> - Keyboard vs visual reading order: **${(ev.tauTabVsVisual * 100).toFixed(0)}%** of pairs out of order; keyboard vs source order: **${(ev.tauTabVsDom * 100).toFixed(0)}%**.`,
        );
        if (ev.jumps.length > 0) {
          lines.push(">");
          lines.push(`> Largest focus jumps (against reading order):`);
          for (const j of ev.jumps) {
            lines.push(
              `> - ${label(j.fromSelector)} → ${label(j.toSelector)} (reading-rank Δ ${j.visualRankDelta})`,
            );
          }
        }
        lines.push(">");
        lines.push(`> Keyboard (Tab) order:`);
        ev.tabOrder.forEach((s, i) => {
          lines.push(`> ${i + 1}. ${label(s.selector)}`);
        });
        lines.push(">");
        lines.push(`> Expected visual reading order:`);
        ev.visualOrderSelectors.forEach((sel, i) => {
          lines.push(`> ${i + 1}. ${label(sel)}`);
        });
        lines.push(
          `> - _Requires human review — reading order is subjective._`,
        );
      }

      // Render related nodes for violations (not incomplete, which has its own display)
      if (!f.incompleteData && f.relatedNodes && f.relatedNodes.length > 0) {
        lines.push("");
        lines.push(`> **Related Elements** (${f.relatedNodes.length}):`);
        for (const [i, rn] of f.relatedNodes.entries()) {
          lines.push(`> ${i + 1}. \`${rn.target.join(" > ")}\``);
          if (rn.html) {
            lines.push(`>    \`${rn.html.slice(0, 120)}\``);
          }
        }
      }

      const links: string[] = [];
      if (f.helpUrl) links.push(`[Learn More](${f.helpUrl})`);
      if (links.length > 0) {
        lines.push(links.join(" · "));
      }
      lines.push("");
    }
  }

  // Passed rules section
  if (state.passes.length > 0) {
    lines.push(`## ✅ Passed Rules (${state.passes.length})`);
    lines.push("");
    lines.push(`<details>`);
    lines.push(`<summary>View all passed rules</summary>`);
    lines.push("");
    lines.push(`| Rule ID | WCAG SC | Level | Nodes Passed |`);
    lines.push(`|---|---|---|---:|`);
    for (const p of state.passes) {
      lines.push(`| \`${p.ruleId}\` | ${p.wcagSc} | ${p.wcagLevel} | ${p.nodeCount} |`);
    }
    lines.push("");
    lines.push(`</details>`);
    lines.push("");
  }

  // Inapplicable rules section
  if (state.inapplicable.length > 0) {
    lines.push(`## ℹ️ Not Applicable Rules (${state.inapplicable.length})`);
    lines.push("");
    lines.push(`<details>`);
    lines.push(`<summary>View all not applicable rules</summary>`);
    lines.push("");
    lines.push(`These rules found no matching elements on any scanned page. They represent checks that were not relevant to your content, not failures.`);
    lines.push("");
    lines.push(`| Rule ID | WCAG SC | Level |`);
    lines.push(`|---|---|---|`);
    for (const r of state.inapplicable) {
      lines.push(`| \`${r.ruleId}\` | ${r.wcagSc} | ${r.wcagLevel} |`);
    }
    lines.push("");
    lines.push(`</details>`);
    lines.push("");
  }

  // Static "Required Manual Audits" section. Identical on every report —
  // the human checklist for what tools cannot fully verify. Source of truth:
  // src/reports/manual-audits.ts. Filter to show only "Manual Only" items.
  const manualAudits = manualAuditsByLevel("Manual Only");
  const total = manualAuditsCount("Manual Only");
  lines.push(`## Required Manual Audits (${total})`);
  lines.push("");
  lines.push(
    `These WCAG 2.2 success criteria require manual audit because they cannot be fully automated by tools. This list is identical on every report — use it as your post-scan checklist.`,
  );
  lines.push("");
  lines.push(
    `Counts: **${manualAudits.A.length}** at Level A · **${manualAudits.AA.length}** at Level AA · **${manualAudits.AAA.length}** at Level AAA.`,
  );
  lines.push("");
  for (const level of ["A", "AA", "AAA"] as const) {
    const audits = manualAudits[level];
    if (audits.length === 0) continue;
    lines.push(`### Level ${level} (${audits.length})`);
    lines.push("");
    for (const audit of audits) {
      const categoryLabel: Record<typeof audit.category, string> = {
        manual: "Manual only",
        partial: "Partial automation — verify nuance",
        llm: "LLM-flagged — verify candidates",
      };
      lines.push(`#### WCAG ${audit.sc} — ${audit.title}`);
      lines.push("");
      lines.push(`_${categoryLabel[audit.category]}_`);
      lines.push("");
      lines.push(`**How to test:**`);
      lines.push("");
      for (const step of audit.howToTest) {
        lines.push(`1. ${step}`);
      }
      lines.push("");
    }
  }

  lines.push(`---`);
  lines.push(
    `Generated by a11y-scout v${state.meta.version}. Findings tagged with "requires human review" are AI-surfaced candidates and never constitute a conformance claim. See AGENTS.md for the responsibility model.`,
  );
  return lines.join("\n");
}

function groupBySeverity(
  findings: Finding[],
): Record<Severity, Finding[]> {
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
