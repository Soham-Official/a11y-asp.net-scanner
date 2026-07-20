# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

a11y-scout is an AI-powered WCAG 2.0/2.1/2.2 accessibility scanner for Hyland. It scans live URLs (single page or crawl), authenticated pages, source repositories, and integrates into Playwright and WebdriverIO test suites. All LLM calls go through the Hyland AI Platform (HAIP) Model Gateway — no external data egress.

## Commands

```bash
# Install & setup
npm install
npx playwright install chromium
cp .env.example .env  # fill in HAIP_API_KEY

# Build (all workspace packages)
npm run build

# Typecheck (no emit)
npm run typecheck

# Smoke test (the primary V1 test; use A11Y_HAIP_MOCK=1 for offline)
npm run smoke

# Run CLI directly (passes args through)
npm run cli -- scan-url https://example.com --level AA
npm run cli -- scan-url https://example.com --headed  # visible browser for debugging
npm run cli -- scan-url https://localhost:3000 --ignore-https-errors  # bypass SSL cert errors
npm run cli -- scan-url https://example.com --wait-until networkidle  # wait for JS frameworks to finish rendering
npm run cli -- scan-url https://example.com --extra-wait 2000  # add 2s delay for lazy-loaded content
npm run cli -- scan-repo ./path --level AA
npm run cli -- fix-repo  # auto-fix issues from latest report (stages changes, no commit)
npm run cli -- fix-repo --dry-run --confidence high  # preview high-confidence fixes
npm run cli -- fix-repo --branch --commit  # create branch + auto-commit (old behavior)
npm run cli -- doctor

# Shorthand CLI commands
npm run scan:url -- https://example.com
npm run scan:url -- https://example.com --headed
npm run scan:url -- https://localhost:3000 --ignore-https-errors
npm run scan:repo -- ./path
npm run doctor

# Audit axe-core WCAG mappings (compare against axe-core metadata)
npm run audit:axe-mappings
```

**Pre-PR checklist:** `npm run typecheck && npm run smoke`

## Architecture

npm workspaces monorepo with three packages:

- **`packages/a11y-scout`** — Core engine + CLI. Entry points: `src/cli.ts` (Commander CLI), `src/index.ts` (library API).
- **`packages/a11y-scout-playwright`** — `@a11y-scout/playwright` drop-in Playwright test fixture. Extends `@playwright/test` with an `a11y` fixture object.
- **`packages/a11y-scout-webdriverio`** — `@a11y-scout/webdriverio` drop-in WebdriverIO helper. Exports `scanPage(browser, opts)` / `generateReport(opts)`; mirrors the Playwright package's option surface.

### Agent Pipeline

```
Input → Planner → Scanner(s) → Validator → AAA Semantic → Content-Quality → Reporter
```

- **Planner** (`agents/planner.ts`) — deterministic; picks scanners based on mode/level. Adds `"content-quality"` for url/fixture modes regardless of level (the `!isMock` gate lives in graph.ts so the planner stays pure).
- **Scanners** (`scanners/`) — `runtime.ts` (Playwright + axe-core, plus extended `collectPageEvidence`), `keyboard.ts` (five runtime keyboard checks), `crawler.ts` (BFS same-origin crawl), `static.ts` (eslint-plugin-jsx-a11y for React + @angular-eslint/template for Angular), `login.ts` (storageState capture).
  - **Page Load Strategy:** Runtime scanner defaults to `waitUntil: "load"` to ensure JavaScript-rendered content is present before scanning. This catches dynamic DOM elements that would be missed with `domcontentloaded`. Users can override with `--wait-until domcontentloaded|load|networkidle` or add `--extra-wait <ms>` for lazy-loaded content.
  - **Keyboard Scanner:** Five runtime checks run in a single Tab walk after axe-core: (1) keyboard traps (WCAG 2.1.2), (2) off-screen/invisible focus (2.4.3), (3) missing focus indicators (2.4.7), (4) modal focus leaks (2.4.3/2.1.2), (5) tab-order divergence (2.4.3). All deterministic — no LLM, no data egress. On by default; `--no-keyboard` disables all, `--no-focus-checks` keeps traps only. Config in `src/config/focus-order.ts`.
  - **Page Evidence:** `collectPageEvidence` (in `runtime.ts`) gathers per-page snapshots used by both LLM agents — title, headings, links, `htmlLang`, images (alt + src + presence), form fields with computed accessible name, error/alert regions, language-of-parts samples, near-form instructions, plus a 4 KB visible-text sample. **Never reads input `.value`** — PII guard for authenticated pages.
- **Validator** (`agents/validator.ts`) — deduplicates findings, assigns severity from `wcag.ts` catalog.
- **WCAG Catalog** (`src/wcag.ts`) — Hybrid runtime-first WCAG SC mapping: parses axe-core's tags by default (74 rules), with ~7 editorial overrides and ~9 best-practice assignments. Use `npm run audit:axe-mappings` to compare our mappings against axe-core's metadata.
- **AAA Semantic** (`agents/aaa-semantic.ts`) — HAIP LLM calls for AAA-only SCs (2.4.9 link purpose alone, 2.4.10 section headings, 3.1.3 unusual words, 3.1.4 abbreviations, 3.1.5 reading level, 3.3.5 help). Only runs at `--level AAA`.
- **Content-Quality** (`agents/content-quality.ts`) — HAIP LLM calls for A/AA SCs that need semantic judgement: 1.1.1 alt-text quality, 1.3.3 sensory characteristics, 2.4.2 page title, 2.4.4 link purpose in context, 2.5.3 label-in-name, 3.3.1 / 3.3.3 error identification & suggestion, 3.3.2 form-field labels, 1.3.5 input purpose, 2.4.6 headings & labels, 3.1.2 language of parts. Runs at every level (A, AA, AAA) when `!llm.isMock`. Per-page hard cap of 20 findings; honors `A11Y_MAX_COST_USD` cumulatively (skips remaining pages past 95% of cap). Shared lenient-JSON helpers with AAA Semantic live in `agents/_llm-json.ts`.
- **Graph** (`agents/graph.ts`) — orchestrates the pipeline. Agents never call each other directly. Content-Quality is invoked after AAA Semantic so cost is observed cumulatively across both LLM agents.
- **Reports** (`reports/`) — `html.ts`, `markdown.ts`, `json.ts`. Output to `./a11y-reports/`.

### LLM Provider Abstraction

**V1.2+** introduces a provider-agnostic LLM layer (`src/llm/`) to support multiple backends:

- **`llm/provider.ts`** — Core interface (`LlmProvider`) for chat requests.
- **`llm/base-provider.ts`** — `BaseLlmProvider` abstract class. Owns all behavior common to every provider: cost metering (via `CostMeter`), budget enforcement, `resolveModel` (reasoner/cheap/passthrough), and the single mock-response builder. Concrete providers implement only `chat()` transport and `describe()`.
- **`llm/haip-provider.ts`** — `HaipProvider extends BaseLlmProvider`. HAIP backend (API-key auth) via the OpenAI-compatible LiteLLM API. Real calls only — never mocks (the factory routes to `MockProvider` when no key is present).
- **`llm/bedrock-provider.ts`** — `BedrockProvider extends BaseLlmProvider`. AWS Bedrock via Converse API (AWS SSO auth).
- **`llm/mock-provider.ts`** — `MockProvider extends BaseLlmProvider`. The single mock code path for CI and offline development.
- **`llm/factory.ts`** — Auto-detects provider from environment (see detection logic below).
- **`llm/cost-meter.ts`** — The single source of truth for cost tracking: `MODEL_PRICING`, `CostMeter`, and `BudgetExceededError`. Every provider routes cost through here via `BaseLlmProvider` (no per-provider pricing tables).

**Provider detection priority:**
1. Explicit `A11Y_LLM_PROVIDER` env var (`bedrock` | `haip` | `mock`)
2. `CLAUDE_CODE_USE_BEDROCK=1` or `AWS_PROFILE` set → bedrock
3. `HAIP_API_KEY` set → haip
4. `A11Y_HAIP_MOCK=1` → mock
5. Default → haip (the factory falls back to `MockProvider` if no key)

**Choosing a backend:** Bedrock authenticates via AWS SSO (e.g. Claude Code's profile); HAIP authenticates via an API key. Both route through Hyland-controlled infrastructure with no external data egress. Zero code changes — only environment variables. **Both the scan pipeline and fixer consume `LlmProvider`** — the entire codebase is unified on the abstraction.

### HAIP Integration

`HaipProvider` (`src/llm/haip-provider.ts`) is the HAIP backend. It implements `LlmProvider` directly via `BaseLlmProvider` — there is no separate `HaipClient` or adapter wrapper. Key behaviors:
- Real calls only. The factory returns a `MockProvider` when `HAIP_API_KEY` is unset or `A11Y_HAIP_MOCK=1`, so there is exactly one mock path.
- Cost meter increments after every call; hard stops at `--max-cost-usd` / `A11Y_MAX_COST_USD` (budget checked before each call).
- Required metadata: `user_id` and `app_key` in every request body; `environment_id` only when set.
- Custom `User-Agent` header required by HAIP WAF.

### Auto-Fixer Pipeline (V1.2+)

```
Report → Fixer Orchestrator → LLM Agent → Applier → Git Commits
```

- **Orchestrator** (`fixer/orchestrator.ts`) — coordinates the workflow: load report → filter → generate → apply → commit.
- **Report Loader** (`fixer/report-loader.ts`) — loads JSON reports, filters fixable findings.
- **Fix Agent** (`fixer/fix-agent.ts`) — LLM-powered fix generation (groups by file for efficiency).
- **Applier** (`fixer/fix-applier.ts`) — string replacement with uniqueness validation.
- **Git Safety** (`fixer/git-safety.ts`) — working tree checks, branch creation, auto-commits by category.

**Phase 1 scope:** Safe mechanical fixes only (missing alt, lang, labels, button text). High-confidence only by default. HTML and React/JSX files.

## Coding Conventions

- TypeScript strict mode with `noUncheckedIndexedAccess: true`. ESM (`"type": "module"`).
- Zod schemas for all agent IO and external data (`src/types.ts`).
- Named exports only (no default exports). Files in `kebab-case.ts`.
- Conventional commits: `feat(scope):`, `fix(scope):`, `docs(scope):`, `chore(scope):`.
- Node >= 20 (see `.nvmrc`).

## Non-Negotiable Rules

1. **Never auto-claim conformance from AI findings (any level).** Both content-quality and AAA-semantic findings always have `requiresHumanReview: true, severity: "review"`.
2. **Every AI finding must have:** `aiGenerated: true`, `confidence: "low"|"medium"|"high"`, `requiresHumanReview: true`.
3. **No data egress.** All LLM calls go through HAIP gateway only. `collectPageEvidence` never reads input `.value` to keep user-entered PII out of prompts.
4. **Cost transparency.** Report footers show HAIP token cost.
5. **No agent calls another agent directly.** All orchestration in `agents/graph.ts`.

## Environment Variables

Required for real LLM: `HAIP_API_KEY`, `HAIP_ENVIRONMENT_ID`, `HAIP_USER_ID`. See `.env.example` for full list with defaults. Without a key, runs in mock mode (axe / keyboard / reflow still work; AAA findings become stubs and the **A/AA content-quality agent is skipped entirely** so CI runs stay deterministic).

## CI

GitHub Actions (`.github/workflows/ci.yml`): install → playwright chromium → `npm run build` → `npm run smoke` (with `A11Y_HAIP_MOCK=1`). Build order matters: `a11y-scout` must build before the `a11y-scout-playwright` and `a11y-scout-webdriverio` wrappers.
