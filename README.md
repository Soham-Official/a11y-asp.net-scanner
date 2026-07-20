# a11y-scout

AI-powered WCAG 2.0 / 2.1 / 2.2 accessibility scanner for Hyland. It scans live URLs (single page or same-origin crawl), authenticated pages, and source repositories, and plugs into **Playwright** and **WebdriverIO** test suites as a drop-in helper. All LLM calls go through the Hyland AI Platform (HAIP) Model Gateway — **no external LLM, no data egress**.

> **This README is for developers working *on* a11y-scout.** If you just want to *use* the tool, read [docs/USAGE.md](./docs/USAGE.md) (full CLI + fixture guide) or, if you received a distributed package, [docs/installation-guide.md](./docs/installation-guide.md).

---

## Prerequisites

- **Node.js >= 20** (pinned in [`.nvmrc`](./.nvmrc)). Run `nvm use` to pick it up.
- **npm** (ships with Node). This repo uses npm workspaces — do not use yarn/pnpm.
- **Chromium**, installed via Playwright (see below).

## Setup

```bash
nvm use                          # Node 20
npm install                      # installs all workspaces
npx playwright install chromium  # browser used by the runtime scanner
cp .env.example .env             # then fill in credentials (see below)
```

### Configure an LLM provider

a11y-scout auto-detects its LLM backend from the environment. You do **not** need credentials to develop — without them the tool runs in deterministic **mock mode** (axe / keyboard / reflow checks still run; AI content-quality and AAA agents are skipped).

Pick one and put it in `.env`:

```bash
# AWS Bedrock — authenticate with AWS SSO (e.g. Claude Code's profile)
A11Y_LLM_PROVIDER=bedrock
AWS_PROFILE=your-aws-sso-profile
AWS_REGION=us-east-1

# HAIP — authenticate with a Hyland AI Platform API key
A11Y_LLM_PROVIDER=haip
HAIP_API_KEY=<get from AI Platform - Team 1>

# Mock — CI / offline, no credentials needed
A11Y_LLM_PROVIDER=mock
```

Provider detection priority when `A11Y_LLM_PROVIDER` is unset: `CLAUDE_CODE_USE_BEDROCK` / `AWS_PROFILE` → bedrock, then `HAIP_API_KEY` → haip, then mock. See [`.env.example`](./.env.example) for the full variable list.

Verify your setup:

```bash
npm run doctor   # prints active provider (bedrock | haip | mock) and READY status
```

## Everyday commands

Run these from the repo root.

```bash
npm run build              # build all workspace packages (tsc)
npm run typecheck          # type-check every workspace, no emit
npm run test               # run per-package test suites (vitest)
npm run smoke              # end-to-end smoke test — the primary V1 gate
npm run lint               # lint every workspace

# Run the CLI without building (tsx), args pass through:
npm run cli -- scan-url https://example.com --level AA
npm run cli -- scan-repo ./path/to/app
npm run cli -- fix-repo --dry-run
npm run doctor

# Shorthands:
npm run scan:url -- https://example.com
npm run scan:repo -- ./path
npm run dist               # build distributable .tgz packages into ./distribution
```

**Before opening a PR:** `npm run typecheck && npm run smoke`

For the full catalog of CLI flags and workflows (crawling, auth capture, per-check tuning), see [docs/USAGE.md](./docs/USAGE.md).

---

## Repository layout

```text
a11y-scanner/
├── packages/                       # npm workspaces (the shipped code)
│   ├── a11y-scout/                 # core engine + CLI  ← everything lives here
│   ├── a11y-scout-playwright/      # @a11y-scout/playwright test fixture
│   └── a11y-scout-webdriverio/     # @a11y-scout/webdriverio test helper
├── examples/                       # runnable demos (also workspaces)
│   ├── playwright-demo/
│   └── webdriverio-demo/
├── scripts/
│   └── audit-axe-mappings.ts       # compares our WCAG map vs axe-core metadata
├── distribution/                   # generated .tgz packages for internal sharing
├── docs/
│   ├── USAGE.md                    # end-user usage guide (CLI + fixtures)
│   └── installation-guide.md       # guide for teams consuming the packages
├── generate-distribution.sh        # builds ./distribution (`npm run dist`)
├── .env.example                    # every env var with defaults
├── tsconfig.base.json              # shared TS config; packages extend this
├── AGENTS.md                       # the agent contract / non-negotiable rules
└── README.md                       # you are here
```

### The three packages

| Package | npm name | What it is |
|---|---|---|
| `packages/a11y-scout` | `a11y-scout` | **The core.** The scan engine, the agent pipeline, the LLM provider layer, the auto-fixer, the report writers, and the `a11y-scout` CLI. The other two packages depend on this one. |
| `packages/a11y-scout-playwright` | `@a11y-scout/playwright` | A drop-in fixture that extends `@playwright/test` with an `a11y` object so existing Playwright suites can run scans inline. Thin wrapper over the core. |
| `packages/a11y-scout-webdriverio` | `@a11y-scout/webdriverio` | The same idea for WebdriverIO — a helper that drives the core engine against pages rendered in a WebdriverIO test. Mirrors the Playwright package. |

Both wrapper packages depend on `a11y-scout` and reach the engine through its **framework-agnostic driver layer** (`src/driver/`), so no scanner code imports Playwright or WebdriverIO directly.

> **Build order matters:** `a11y-scout` must build before the two wrappers. `npm run build` handles this via workspace ordering — keep it that way in CI.

### Inside `packages/a11y-scout/src`

```text
src/
├── cli.ts                  # Commander CLI: scan-url, scan-repo, fix-repo, doctor
├── index.ts                # library API (named exports for programmatic use)
├── smoke.ts                # the smoke test entry point
├── types.ts                # Zod schemas: Finding, ScanState, ScanPlan, CrawlOptions…
├── wcag.ts                 # single source of truth for WCAG SC → severity mapping
├── incomplete-guidance.ts  # human-review guidance for axe "incomplete" results
├── agents/                 # the pipeline (see below). No agent calls another directly.
│   ├── planner.ts          #   deterministic scanner selection
│   ├── scan-page.ts        #   per-page scan orchestration
│   ├── validator.ts        #   dedup + severity assignment
│   ├── content-quality.ts  #   A/AA LLM checks (alt quality, link text, titles…)
│   ├── aaa-semantic.ts     #   AAA-only LLM checks (reading level, jargon…)
│   ├── aggregate-pages.ts  #   consolidate multi-page findings
│   ├── graph.ts            #   orchestrates the whole pipeline
│   └── _llm-json.ts        #   shared lenient-JSON parsing for LLM output
├── scanners/               # deterministic checkers (no LLM)
│   ├── runtime.ts          #   Playwright + axe-core, plus collectPageEvidence
│   ├── keyboard.ts         #   five runtime keyboard/focus checks
│   ├── reflow.ts           #   WCAG 1.4.10 viewport-resize overflow probe
│   ├── crawler.ts          #   same-origin BFS multi-page crawl
│   ├── static.ts           #   eslint-plugin-jsx-a11y (React) + @angular-eslint (Angular)
│   ├── login.ts            #   headed auth-state capture
│   └── axe-config.ts       #   shared buildAxe() — tag set + force-enabled rules
├── driver/                 # framework-agnostic browser abstraction
│   ├── interfaces.ts       #   PageDriver / BrowserDriver / BrowserContextDriver / AxeRunConfig
│   ├── axe-shared.ts       #   driver-neutral axe helpers
│   └── playwright/         #   the only concrete driver today
├── llm/                    # provider-agnostic LLM layer
│   ├── provider.ts         #   LlmProvider interface
│   ├── base-provider.ts    #   BaseLlmProvider: cost metering, budget, mock builder
│   ├── haip-provider.ts    #   HAIP (API-key auth)
│   ├── bedrock-provider.ts #   AWS Bedrock (AWS SSO auth)
│   ├── mock-provider.ts    #   the single mock code path
│   ├── factory.ts          #   env-based provider auto-detection
│   └── cost-meter.ts       #   MODEL_PRICING, CostMeter, BudgetExceededError
├── fixer/                  # auto-fix pipeline (fix-repo)
│   ├── orchestrator.ts     #   load report → filter → generate → apply → commit
│   ├── report-loader.ts    #   loads JSON reports, filters fixable findings
│   ├── fix-agent.ts        #   LLM-powered fix generation (grouped by file)
│   ├── fix-applier.ts      #   string replacement with uniqueness validation
│   ├── git-safety.ts       #   working-tree checks, branch creation, commits
│   └── categories.ts       #   fixable-category definitions
├── reports/                # html.ts, markdown.ts, json.ts + emit/output-dir helpers
├── config/
│   └── focus-order.ts      #   thresholds for keyboard/tab-order checks
└── __tests__/              # fixtures + tests (including keyboard-regression.html)
```

---

## Architecture at a glance

The engine is a linear multi-agent pipeline. Agents never call each other directly — all orchestration lives in `agents/graph.ts`.

```text
Input → Planner → Scanner(s) → Validator → AAA Semantic → Content-Quality → Reporter
```

- **Planner** — deterministic; picks scanners from the input mode (URL / repo / fixture) and WCAG level.
- **Scanners** — deterministic, no LLM: axe-core runtime, keyboard/focus checks, reflow, crawler, static (ESLint).
- **Validator** — dedupes findings and assigns canonical severity from `wcag.ts`.
- **AAA Semantic** (LLM) — AAA-only SCs; runs only at `--level AAA`.
- **Content-Quality** (LLM) — A/AA SCs needing semantic judgement; runs at every level when a real provider is configured (skipped in mock).
- **Reporter** — writes HTML / Markdown / JSON to `./a11y-reports/`.

**Non-negotiable rules** (enforced across the codebase — see [AGENTS.md](./AGENTS.md) and [`.claude/CLAUDE.md`](./.claude/CLAUDE.md)):

1. Never auto-claim conformance from AI findings. Every AI finding is `requiresHumanReview: true, severity: "review"`.
2. Every AI finding carries `aiGenerated: true` and a `confidence` of `low | medium | high`.
3. No data egress — all LLM traffic goes through the HAIP gateway; `collectPageEvidence` never reads input `.value` (PII guard).
4. Cost transparency — report footers show HAIP token cost.
5. No agent calls another agent directly; orchestrate in `agents/graph.ts`.

---

## Coding conventions

- TypeScript **strict** mode with `noUncheckedIndexedAccess`. ESM (`"type": "module"`).
- **Named exports only** — no default exports. Filenames in `kebab-case.ts`.
- Zod schemas for all agent IO and external data (`src/types.ts`).
- **Conventional commits:** `feat(scope):`, `fix(scope):`, `docs(scope):`, `chore(scope):`.
- Every WCAG SC should have a fixture page with a known pass and a known fail.

## CI

GitHub Actions ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)): install → install Chromium → `npm run build` → `npm run smoke` (with `A11Y_HAIP_MOCK=1`). The smoke test is the primary gate; keep it green.

## Distribution

`npm run dist` (runs [`generate-distribution.sh`](./generate-distribution.sh)) packs each workspace into a `.tgz` under `distribution/`, along with a manifest (versions + SHA256 checksums) and an installation guide. That directory is what consuming teams install from — see [docs/installation-guide.md](./docs/installation-guide.md).

## License

Hyland Internal. See [LICENSE](./LICENSE).
