# AGENTS.md - a11y-scout Agent Operating Manual

> This file is the contract between human contributors, AI coding agents (Cursor, Claude Code, Codex, Aider), and the a11y-scout runtime itself. Read it before changing anything in this repo.

**Last updated:** 2026-07-12
**Status:** runtime + crawl + auth scanning, React & Angular static scanning, A/AA + AAA LLM agents, an auto-fixer, a framework-agnostic driver layer (Playwright + WebdriverIO), and a pluggable LLM provider layer (Bedrock / HAIP / mock).

---

## 1. Mission

**Find every WCAG 2.0 / 2.1 / 2.2 issue we can on a Hyland web product, regardless of whether the input is a live URL, a source-code repository, or a Playwright/WebdriverIO test in flight -- with zero data egress and zero per-seat licensing cost.**

We are NOT trying to:
- Replace human accessibility experts (we surface findings, humans validate)
- Auto-claim AAA conformance (industry consensus: impossible to fully automate)
- Replace axe-core (we wrap it; it is the trusted deterministic core)

---

## 2. Repo layout

```
a11y-scanner/
├── package.json                       # npm workspace root
├── tsconfig.base.json                 # shared TS config
├── README.md                          # user-facing quickstart
├── AGENTS.md                          # THIS FILE
├── packages/
│   ├── a11y-scout/                    # main package: core engine + CLI bin
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── cli.ts                 # `a11y-scout` CLI (Commander): scan-url, scan-repo, fix-repo, doctor
│   │       ├── index.ts               # public exports for library use
│   │       ├── types.ts               # Zod schemas: Finding, ScanState, Report, PageEvidence
│   │       ├── wcag.ts                # WCAG SC catalog + severity map (single source of truth)
│   │       ├── version.ts             # VERSION read from package.json (CLI, HAIP UA, report stamp)
│   │       ├── smoke.ts               # smoke-test entry point
│   │       ├── incomplete-guidance.ts # human-verification guidance for axe "incomplete" results
│   │       ├── config/
│   │       │   └── focus-order.ts     # keyboard/focus scanner config
│   │       ├── driver/                # framework-agnostic browser-automation layer
│   │       │   ├── interfaces.ts      # PageDriver / BrowserDriver / BrowserContextDriver / AxeRunConfig
│   │       │   ├── axe-shared.ts      # shared axe-run helpers across drivers
│   │       │   └── playwright/        # the only concrete driver today
│   │       ├── llm/                   # provider abstraction
│   │       │   ├── provider.ts        # LlmProvider interface
│   │       │   ├── base-provider.ts   # shared cost metering, budget, model resolution, mock builder
│   │       │   ├── haip-provider.ts   # HAIP Model Gateway (OpenAI-compatible LiteLLM)
│   │       │   ├── bedrock-provider.ts# AWS Bedrock (Converse API), AWS SSO auth
│   │       │   ├── mock-provider.ts   # single mock code path for CI/offline
│   │       │   ├── factory.ts         # env-based provider auto-detection
│   │       │   └── cost-meter.ts      # MODEL_PRICING, CostMeter, BudgetExceededError
│   │       ├── scanners/
│   │       │   ├── axe-config.ts      # shared buildAxeConfig() — tag set + force-enabled rules
│   │       │   ├── reflow.ts          # WCAG 1.4.10 reflow probe
│   │       │   ├── runtime.ts         # runtime scan orchestration + collectPageEvidence
│   │       │   ├── keyboard.ts        # 5 runtime keyboard/focus checks, post-axe runtime step
│   │       │   ├── crawler.ts         # same-origin BFS multi-page crawler
│   │       │   ├── static.ts          # eslint-plugin-jsx-a11y (React) + @angular-eslint/template (Angular)
│   │       │   └── login.ts           # storageState capture/load
│   │       ├── agents/
│   │       │   ├── planner.ts         # deterministic scanner selection
│   │       │   ├── scan-page.ts       # single source of truth for "one page → per-page result"
│   │       │   ├── aggregate-pages.ts # merge per-page slices into one ScanState
│   │       │   ├── validator.ts       # dedupe + severity assignment
│   │       │   ├── content-quality.ts # A/AA LLM checks (alt quality, link text, page title, etc.)
│   │       │   ├── aaa-semantic.ts    # AAA-only LLM checks (link purpose, reading level, etc.)
│   │       │   ├── fix-html.ts        # per-finding AI-suggested HTML fix (never auto-applied)
│   │       │   ├── _llm-json.ts       # shared lenient JSON extraction for LLM agents
│   │       │   └── graph.ts           # hand-rolled async pipeline orchestrator
│   │       ├── fixer/                 # auto-fix pipeline (consumes LlmProvider)
│   │       │   ├── orchestrator.ts    # load report → filter → generate → apply → commit
│   │       │   ├── report-loader.ts   # load JSON report, filter fixable findings
│   │       │   ├── categories.ts      # ruleId → fix category; SUPPORTED_FIX_CATEGORIES
│   │       │   ├── fix-agent.ts       # LLM-powered fix generation (grouped by file)
│   │       │   ├── fix-applier.ts     # string replacement with uniqueness validation
│   │       │   └── git-safety.ts      # working-tree checks, branch creation, auto-commits
│   │       └── reports/
│   │           ├── emit.ts            # write all requested report formats
│   │           ├── html.ts            # standalone HTML report
│   │           ├── markdown.ts        # PR-comment-friendly Markdown
│   │           ├── json.ts            # machine-readable JSON
│   │           ├── manual-audits.ts   # static checklist of manual-only WCAG SCs
│   │           └── output-dir.ts      # report output-directory resolution
│   ├── a11y-scout-playwright/         # @a11y-scout/playwright fixture
│   │   └── src/index.ts               # `test` extended with `a11y` fixture
│   └── a11y-scout-webdriverio/        # @a11y-scout/webdriverio integration
│       └── src/index.ts               # mirrors the Playwright package
├── examples/
│   ├── playwright-demo/               # smoke-test target
│   └── webdriverio-demo/
└── .github/workflows/
    └── ci.yml                         # build + typecheck + smoke
```

### Driver abstraction

The engine (scanners, agents) consumes the interfaces in `src/driver/interfaces.ts`
(`PageDriver`, `BrowserDriver`, `BrowserContextDriver`, `AxeRunConfig`) and never imports
a concrete automation framework. Playwright is the only concrete driver today, encapsulated
under `driver/playwright/`. Future drivers (WebdriverIO, Puppeteer, Selenium) drop in by
implementing the same interfaces without touching engine code. Method shapes mirror
Playwright's `Page` so existing `page.evaluate()` payloads work unchanged; other frameworks
adapt, the engine never does.

---

## 3. Agent roster

The pipeline is a **hand-rolled async orchestrator** in `agents/graph.ts` (not LangGraph).
Per-page scanning lives in `scan-page.ts`; `aggregate-pages.ts` merges slices. Each agent has
a contract you must respect when modifying code.

| Agent | Inputs | Outputs | Owned WCAG SCs | Model | Cost budget |
|---|---|---|---|---|---|
| **Planner** | `{ target, mode, level }` | `ScanPlan` (which scanners + flags) | n/a | none (deterministic) | $0 |
| **StaticScanner** | repo path | `Finding[]` from eslint-plugin-jsx-a11y / @angular-eslint/template | static-detectable A/AA SCs (alt, ARIA, labels, etc.) | none | $0 |
| **RuntimeScanner** | URL + storageState (via driver) | `Finding[]` from axe-core + reflow + evidence | A / AA / AAA where deterministic | none | $0 |
| **KeyboardScanner** | live page (post-axe) | `Finding[]` + pass for keyboard traps/focus, w/ evidence | 2.1.2, 2.4.3, 2.4.7 | none (simulates Tab/Shift+Tab/Escape) | $0 |
| **Validator** | `Finding[]` from all scanners | deduped + severity-tagged `Finding[]` | n/a (transformer) | none | $0 |
| **ContentQuality** | per-page evidence (title, headings, links, images, form fields, errors, language-of-parts, instructions, text sample) | `Finding[]` flagged for human review | A: 1.1.1, 1.3.3, 2.4.2, 2.4.4, 2.5.3, 3.3.1, 3.3.2 — AA: 1.3.5, 2.4.6, 3.1.2, 3.3.3 | HAIP `reasoner` | shares `A11Y_MAX_COST_USD`; 95% ceiling per-page; cap 20 findings/page |
| **AAASemantic** | page text + structured findings | `Finding[]` flagged for human review | 2.4.9, 2.4.10, 3.1.3, 3.1.4, 3.1.5, 3.3.5 | HAIP `reasoner` | shares `A11Y_MAX_COST_USD` |
| **FixHtml** | findings with an HTML snippet + guidance | `finding.aiFixedHtml` (suggestion only) | n/a | HAIP `reasoner` | shares `A11Y_MAX_COST_USD` |
| **Reporter** | `ScanState` | files written to `./a11y-reports/` | n/a | none | $0 |

**Gating summary:**
- **ContentQuality** runs at every level (A, AA, AAA) when there's page evidence AND `!llm.isMock`. The planner adds `"content-quality"` for url/fixture modes regardless of level; the graph short-circuits on a mock provider so CI runs are deterministic.
- **AAASemantic** only runs when `--level AAA` is requested (planner-gated).
- **FixHtml** runs in `url` mode when `!llm.isMock` and `--no-ai-fix` was not passed.
- All LLM agents share a single `LlmProvider` instance per scan (unified cost accounting) and the same `agents/_llm-json.ts` helpers for lenient JSON recovery.

### Agent contract rules

1. **Inputs/outputs must validate against Zod schemas in `types.ts`.** No untyped agent IO.
2. **Every finding has `severity` (blocker/severe/major/minor/review) and `wcagSc` (e.g. `WCAG-1.4.3`).**
3. **AI findings MUST set `aiGenerated: true`, `confidence: "low"|"medium"|"high"`, and `requiresHumanReview: true`.**
4. **No agent calls another agent directly.** All orchestration happens in `agents/graph.ts` / `scan-page.ts`.
5. **Cost meter** (in `llm/cost-meter.ts`, shared by every provider via `BaseLlmProvider`) increments after every LLM call. Hard stop if `A11Y_MAX_COST_USD` exceeded (budget checked before each call).

---

## 4. LLM provider layer & HAIP Model Gateway contract

**Source of truth:** [HAIP Client Guide](https://hyland.atlassian.net/wiki/spaces/cin/pages/3012921198).

All LLM access goes through the provider abstraction in `src/llm/`. `LlmProvider` (`provider.ts`) is the interface; `BaseLlmProvider` (`base-provider.ts`) owns everything common to every backend (cost metering via `CostMeter`, budget enforcement, model resolution, and the single mock-response builder). Concrete providers implement only transport: `HaipProvider`, `BedrockProvider`, and `MockProvider`. Both the scan pipeline and the auto-fixer consume `LlmProvider`, so swapping backends is purely an environment-variable change.

### Provider selection (`llm/factory.ts`)

Auto-detected in priority order:

1. Explicit `A11Y_LLM_PROVIDER` (`bedrock` | `haip` | `mock`)
2. `CLAUDE_CODE_USE_BEDROCK=1` or `AWS_PROFILE` set → bedrock
3. `HAIP_API_KEY` set → haip
4. `A11Y_HAIP_MOCK=1` → mock
5. Default → haip (falls back to `MockProvider` when no key is present)

**Choosing a backend:** Bedrock authenticates via AWS SSO (e.g. Claude Code's profile); HAIP authenticates via an API key. Both route through Hyland-controlled infrastructure with no external data egress — switching between them is purely an environment-variable change. Run `a11y-scout doctor` to see the active provider.

### Required environment variables (HAIP backend)

| Variable | Required | Purpose |
|---|---|---|
| `HAIP_API_KEY` | for real LLM | Bearer token. Get from AI Platform Team. Rotates every 90 days. |
| `HAIP_ENVIRONMENT_ID` | for real LLM | UUID; sent in `metadata.environment_id` (only when set) |
| `HAIP_USER_ID` | for real LLM | Service-account or user UUID; sent in `metadata.user_id` (REQUIRED) |
| `HAIP_ENV` | optional | `dev` (default) / `staging` / `prod` -- selects the ALB endpoint |
| `HAIP_APP_KEY` | optional | Defaults to `a11y-scout` |
| `HAIP_MODEL_REASONER` | optional | Reasoner model override |
| `HAIP_MODEL_CHEAP` | optional | Cheap/bulk model override (default `openai.gpt-oss-20b-1:0`) |
| `A11Y_MAX_COST_USD` | optional | Hard cap per scan, default `1.00` |
| `A11Y_HAIP_MOCK` | optional | Set to `1` to force mock mode even if a key is present |

### Endpoints (per environment)

| Env | ALB endpoint |
|---|---|
| dev | `https://ai-platform-public.api.ai.dev.app.hyland.com` |
| dev-private | `https://ai-platform.api.ai.dev.app.hyland.com` |
| staging | `https://ai-platform.api.ai.staging.app.hyland.com` |
| prod | `https://ai-platform.api.ai.app.hyland.com` |
| prod-eu | `https://ai-platform.api.ai.app.hyland.eu` (must call from `eu-central-1`) |
| prod-au | `https://ai-platform.api.ai.app.au.hyland.com` (must call from `ap-southeast-2`) |

Currently **dev only.** Later releases will support the others.

### Required headers (HAIP enforces these)

- `Authorization: Bearer ${HAIP_API_KEY}`
- `User-Agent: a11y-scout/${VERSION} ...` -- HAIP WAF rejects requests without a meaningful UA.
- `x-correlation-id: ${uuid4()}` per request -- recommended for log correlation.

### Required body fields

```json
{
  "model": "...",
  "messages": [...],
  "metadata": {
    "environment_id": "<from HAIP_ENVIRONMENT_ID, only when set>",
    "user_id": "<from HAIP_USER_ID>",
    "app_key": "a11y-scout"
  }
}
```

### Mock mode

When the factory resolves to `MockProvider` (no `HAIP_API_KEY` / no Bedrock creds, `A11Y_HAIP_MOCK=1`, or `A11Y_LLM_PROVIDER=mock`), every call returns a deterministic stubbed response (`__MOCK__: <description>`). **Mock findings always get `confidence: "low"` and a `__mock__` tag in the JSON report.** The A/AA content-quality agent short-circuits entirely on a mock provider (`llm.isMock`), so only the AAA-semantic agent emits stubs. This is the single mock code path for the whole codebase.

### Guardrails

HAIP's default toxicity guardrail is disabled (no `guardrails` field). Rationale: scanning UI text can legitimately include strong language (error messages, security warnings) that trip toxicity rules and break the scan.

---

## 5. Coding conventions

- `strict: true`, `noUncheckedIndexedAccess: true` -- non-negotiable. ESM (`"type": "module"`).
- Use `Zod` for all agent IO and external data.
- Public functions exported from `index.ts` are stable API; anything else is implementation detail.
- No default exports (named exports only). File naming: `kebab-case.ts`; functions `camelCase`; types `PascalCase`.
- Node >= 20 (see `.nvmrc`).

### Commits

Conventional Commits:
```
feat(scanner-runtime): add storageState reuse for SSO
fix(haip): correct user-agent header format per HAIP guide
docs(agents): clarify confidence tier definitions
chore(deps): bump @axe-core/playwright to 4.11
```

### Branches

- `main` -- always shippable
- `feat/<short-name>` / `fix/<short-name>` / `chore/<short-name>`

---

## 6. Severity model

| Severity | Definition | Example WCAG SCs |
|---|---|---|
| **blocker** | Legal-risk Level A failures that materially exclude users | 1.1.1, 1.4.3, 2.1.1, 4.1.2 |
| **severe** | Other Level A failures | 1.3.1, 2.4.1, 2.4.4, 3.3.1 |
| **major** | Level AA failures | 1.4.4, 2.4.6, 2.4.7, 3.2.3 |
| **minor** | Level AAA failures and best-practice flags | 2.4.9, 3.1.5, 3.3.5 |
| **review** | AI-flagged candidates needing human verification | any AI finding |

Severity is set in `Validator`, not by the scanners.

---

## 7. Adding new capabilities

### To add a new WCAG SC to coverage

1. Add the SC to `wcag.ts` catalog with: `id`, `level` (A|AA|AAA), `title`, `slug`, `coverage` (`automated`|`ai_assisted`|`manual_only`), `defaultSeverity`.
2. If automated: confirm axe-core or eslint already covers it; map the rule ID in `scanners/runtime.ts` (or `wcag.ts` mapping) / `scanners/static.ts`.
3. If AI-assisted: extend `agents/content-quality.ts` (A/AA) or `agents/aaa-semantic.ts` (AAA). Update the SC→level table and the prompt's per-criterion bullet list. Both agents use a single combined prompt per page, so wider coverage costs little more than narrow.
4. Add a fixture page in `examples/` with one known-pass and one known-fail.
5. Update the README coverage table.

### To add a new framework to the static scanner

React/JSX and Angular already ship in `scanners/static.ts`; follow the same pattern for Vue/Svelte/HTML:

1. Add a stack detector to `detectStack()` (look for `package.json` deps, etc.).
2. Add a `scan<Framework>Static` path with an ESLint flat config that enables the right plugin, then dispatch from `scanRepoStatic()`.
3. Map findings to WCAG SCs.
4. If the rules should be auto-fixable, add the ruleId → category entries in `fixer/categories.ts`.
5. Add fixtures.

### To add a new automation driver

Implement `PageDriver`, `BrowserDriver`, and `BrowserContextDriver` from `driver/interfaces.ts` under `driver/<framework>/`. The driver injects axe-core itself and returns standard `AxeResults`. No engine code changes.

### To add a new report format

1. Create `packages/a11y-scout/src/reports/<format>.ts` exporting a `write(state, outDir)` function.
2. Wire it into `reports/emit.ts`.
3. Update README and CLI flag.

---

## 8. Testing rules

- **Smoke test (must pass before any commit):** `npm run smoke` runs against a built-in fixture page with known violations; the report must contain at least the expected blocker count.
- **Unit tests (vitest):** any new agent or scanner needs at least one happy-path test. See `packages/a11y-scout/src/__tests__/`.
- **No flaky network tests.** Mock HAIP via `A11Y_HAIP_MOCK=1` for unit tests.
- **Axe regression baseline** is byte-compared; update only on intentional changes.

**Pre-PR checklist:** `npm run typecheck && npm run smoke`.

---

## 9. Responsible-AI rules (non-negotiable)

1. **Never auto-claim conformance from AI findings (any level).** Content-quality (A/AA) and AAA-semantic agents emit `requiresHumanReview: true, severity: "review"`. Reports use three tiers: "automated pass", "AI-flagged candidate", "manual review required" -- matching W3C ACT methodology.
2. **Confidence labels are mandatory** on every AI finding (`low`/`medium`/`high`).
3. **No autonomous side effects.** a11y-scout never files Jira tickets or opens PRs. `fix-repo` applies patches only when explicitly invoked, **stages** changes by default, and commits only with an explicit `--commit` flag — never pushes. `fix-html` only produces suggestions; it never edits files.
4. **No data egress.** All LLM calls go through the configured gateway (HAIP) or AWS Bedrock; no third-party LLM endpoints. Any new dep that talks to OpenAI/Anthropic/Google's public APIs directly is rejected at code review.
5. **Cost transparency.** Every report's footer shows total LLM token cost for that scan.
6. **No PII leakage in logs.** Scanned page text is sent to the LLM provider for content-quality and AAA checks; do not also log it. `collectPageEvidence` deliberately does **not** read input `.value` properties so user-entered data never enters the prompt on authenticated pages.

---

## 10. Glossary

- **WCAG** -- Web Content Accessibility Guidelines, W3C standard. Levels: A, AA (industry baseline), AAA (gold).
- **ACT** -- Accessibility Conformance Testing rules. W3C's tool-validation suite.
- **HAIP** -- Hyland AI Platform Model Gateway (LiteLLM-based).
- **HITL** -- Human-in-the-loop. AI flags candidates; humans approve.
- **storageState** -- Playwright cookie/localStorage snapshot, used to skip login in repeated scans.
- **axe-core** -- Deque's open-source WCAG rule engine. Industry standard, zero-false-positive design.

---

## 11. References

- [HAIP Model Gateway Client Guide](https://hyland.atlassian.net/wiki/spaces/cin/pages/3012921198)
- [WCAG 2.2 Recommendation](https://www.w3.org/TR/WCAG22/)
- [W3C ACT Rules](https://www.w3.org/WAI/standards-guidelines/act/rules/about/)
- [@axe-core/playwright](https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright)
- [eslint-plugin-jsx-a11y](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y)
