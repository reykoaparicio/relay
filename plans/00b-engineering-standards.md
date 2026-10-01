# 00b — Engineering Standards (all agents, read-only)

Sources: the project's `coding-standards`, `backend-patterns`, `api-design`, and `security-review` skills (in `.claude/skills/`), adapted to a local Electron + SQLite app, plus spec §6.5, §11, §13.4, and §17.1. When a skill's advice assumes a hosted web backend (JWT, Redis, CORS, Supabase), this document replaces it with the local-desktop equivalent.

Reviewers check every rule marked **(gate)** mechanically in [14-review-harness.md](14-review-harness.md).

---

## 1. Principles

1. **Readability first.** Code is read far more than written. Name for the reader.
2. **KISS / YAGNI.** Build the fixed P0 template (spec §3.1), not a general workflow framework (§6.1: "do not build a general-purpose framework inside the prototype"). P1/P2 needs are recorded as TODO(ADR) notes and not built.
3. **Deterministic code for money, permissions, schedules, and state** (§6.5). No model output ever flows into a policy decision without first passing a typed check.
4. **Make illegal states unrepresentable.** Use discriminated unions for statuses and results, branded types for IDs and money.
5. **Fail closed.** If a check cannot be evaluated (missing credential, unknown capability, unknown price), treat it as blocked.

## 2. TypeScript

### 2.1 Compiler (gate)

`tsconfig.base.json` (Agent A) sets:

```jsonc
{
  "compilerOptions": {
    "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true, "noFallthroughCasesInSwitch": true, "noPropertyAccessFromIndexSignature": true,
    "useUnknownInCatchVariables": true, "verbatimModuleSyntax": true, "isolatedModules": true,
    "forceConsistentCasingInFileNames": true, "skipLibCheck": true,
    "resolveJsonModule": true,   // static `import x from './y.json' with { type: 'json' }` (catalog, workflow.json; no runtime fs reads)
    "composite": true, "declaration": true, "declarationMap": true, "sourceMap": true
  }
}
```

The renderer tsconfig overrides `module: "ESNext"`, `moduleResolution: "Bundler"`, `jsx: "react-jsx"`, `lib: ["ES2023","DOM","DOM.Iterable"]`, and **omits Node types**.

### 2.2 Types

- **No `any` (gate):** `@typescript-eslint/no-explicit-any: error`. Use `unknown` and narrow it with Zod or a type guard.
- **No non-null `!` assertions** outside tests (`no-non-null-assertion: error`).
- **Branded IDs and money** come from `@relay/contracts` (`RunId`, `Microusd`, …). Never pass a bare `string` where a `RunId` is expected.
- **Discriminated unions** for results: `type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E }`. Expected failures are returned as a `Result`. Invariant violations and bugs are thrown.
- **Exhaustive switches:** every `switch` over a union ends with `default: return assertNever(x)` (`@relay/contracts/assert`).
- **`readonly` by default** on domain objects (`Readonly<>`, `ReadonlyArray<>`). The DB mappers return frozen objects in dev builds.
- **Prefer `interface` for ports** (things with implementations) and **`type` for data**.

### 2.3 Naming

| Kind | Convention | Example |
|---|---|---|
| Non-component files | kebab-case | `run-machine.ts`, `artifact-store.ts` |
| React components | PascalCase file + export | `StepTimeline.tsx` → `export function StepTimeline` |
| Hooks | `useX` camelCase file | `useRunEvents.ts` |
| Types / interfaces | PascalCase, no `I` prefix | `ProviderAdapter` |
| Functions | verb-first camelCase | `admitReservation`, `assembleContext`, `isTerminalStatus` |
| Booleans | `is/has/can/should` | `hasCredential`, `canDispatch` |
| Constants | `SCREAMING_SNAKE` for true constants, co-located | `MAX_TRANSPORT_RETRIES = 1` |
| SQL | snake_case tables/columns, plural tables | `step_runs.revision_index` |
| IPC channels | `relay/v1/<resource>.<verb>` | `relay/v1/runs.start` |
| Error codes | SCREAMING_SNAKE from the §12.6 taxonomy | `BUDGET_BLOCKED` |
| Tests | `<unit>.test.ts`, `<name>.int.test.ts`, `<name>.spec.ts` (e2e) | `budget.test.ts` |

### 2.4 Functions and modules

- Functions ≤ 50 lines and nesting ≤ 3 levels. Use early returns (coding-standards "deep nesting" smell).
- **No magic numbers:** limits and defaults live in `@relay/contracts/defaults.ts` (`DEFAULT_LIMITS`), each with a comment citing its spec section.
- **Immutability:** never mutate inputs; return new objects (`{ ...run, status }`). Exception: local builders inside a single function.
- **Pure core, imperative shell:** state machines, budget arithmetic, policy checks, context selection, and path containment are **pure functions** with no I/O, which keeps them unit-testable. I/O lives in thin adapters (repos, fs, providers).
- **Dependency injection via factory params.** Do not use singletons or module-level mutable state. `createEngine({ db, providers, fs, artifacts, clock, ids, logger })`.
- **Clock and randomness are injected** (`Clock.now(): EpochMs`, `IdGen.next(prefix)`), so tests are deterministic.
- Barrel `index.ts` files export only the public API. Deep imports across packages are lint errors (gate).

### 2.5 Async

- Parallelize independent awaits with `Promise.all`. Keep the sequential steps of the checkpoint protocol sequential (§7.4).
- **Never `await` inside a DB transaction (gate).** `UnitOfWork.run(fn)` is typed so that `fn` cannot return a `Promise` (see 03 §C4). This enforces §7.4, "Do not hold a SQLite transaction open while waiting for a model response".
- Every provider call takes an `AbortSignal`. Every timer is cleared on teardown.
- Floating promises are lint errors (`@typescript-eslint/no-floating-promises: error`) (gate).

### 2.6 Error handling

- Use the stable taxonomy only (`ErrorCode` in contracts, spec §12.6 plus the 02 extensions). Each `AppError` carries `code`, `userMessage`, `retryable`, `nextAction`, `attemptId?`, and `details?`.
- **Never put secrets, raw provider payloads, stack traces, or absolute user paths in `userMessage` (gate).**
- Catch at boundaries only: the IPC router, the runner protocol server, and step handlers. Map unknown errors to `INTERNAL` and log the redacted cause.
- Provider SDK errors are mapped with a specific-first `instanceof` chain (04 §D3), never by string-matching messages.

## 3. Backend patterns (runner / engine / storage)

| Pattern (backend-patterns skill) | Relay equivalent |
|---|---|
| Repository pattern | `packages/storage/src/repos/*` behind interfaces in `packages/storage/src/types.ts`. The engine depends only on the interfaces. |
| Service layer | Engine services: `BudgetService`, `MemoryService`, `ContextAssembler`, `ApprovalService`, `RunService`. No SQL outside repos (gate: dependency-cruiser forbids `node:sqlite` imports outside `packages/storage`). |
| Middleware | IPC router pipeline: `senderCheck → rateLimit → validateInput → route (main or runner) → mapError → validateOutput(dev)`. |
| Transactions | `db.tx('immediate', repos => …)`: synchronous, one writer (the runner). |
| N+1 prevention | Projection queries (`RunRepo.getInspectorProjection(runId)`) fetch run, steps, attempts, and ledger totals with a fixed number of statements. |
| Caching | None server-side in P0 (local SQLite is fast). Renderer caching is TanStack Query only. |
| Retry with backoff | Engine `retry.ts` only (ADR-013), respecting `retry-after` with a 60 s cap (§7.6). |
| Queues / background jobs | The runner loop is the queue: `runs.status='queued'` ordered by `created_at`, concurrency 1 (§9.1). |
| Structured logging | JSONL via `logger.ts` with fields `ts, level, event, outcome?, runId?, stepKey?, attemptId?, durationMs?, code?, ledgerEntryId?` (§18.3; `outcome` per R3-31, e.g. `ok`/`error`/`paused`/`unknown`). Log content is redacted by default (see §6 below). |
| Rate limiting | Per-channel token buckets in the main IPC router (02 §B6), mainly to protect paid calls (`providers.test`). |

## 4. SQL rules

- `STRICT` tables, explicit `NOT NULL`, `CHECK` constraints for enums and non-negative amounts, and `FOREIGN KEY … ON DELETE RESTRICT` unless the plan says otherwise.
- **Parameterized statements only (gate).** Never build SQL from user or model text. Dynamic `ORDER BY`/filters choose from whitelisted fragments.
- Migrations are forward-only and **embedded as TS modules** (R4-32): `packages/storage/migrations/NNNN_name.ts` exports `export const sql = \`…\``, and `migrations/index.ts` exports the ordered `MIGRATIONS` list. Each is checksummed (sha256 of `sql`) and runs in its own transaction. No migration is read from disk at runtime, so Node, tsx, and Vite bundles behave identically.
- Money columns are `INTEGER` micro-USD with `CHECK (amount BETWEEN -9007199254740991 AND 9007199254740991)`.
- Timestamps are `INTEGER` epoch milliseconds UTC. The UI formats them with the user's locale and timezone.
- JSON columns are `TEXT` with `CHECK (json_valid(col))`. They are parsed through Zod in the mapper, never trusted blindly.
- Immutable tables (`ledger_entries`, `memory_revisions`, `run_events`, `approvals` after decision, `artifacts`) get `BEFORE UPDATE/DELETE` triggers that `RAISE(ABORT, …)`.

## 5. React / renderer

- Function components only. Props are typed with an explicit `interface XProps`. Use no `React.FC`.
- **Server state lives in TanStack Query**, and UI state lives in `useState`/`useReducer`. There is no global store in P0. Active project comes from the URL.
- Every async button shows a pending state and is disabled while its mutation runs (ui-ux-pro-max `loading-buttons`). Mutations send idempotency keys (02 §B5).
- Forms are controlled, submitted via `<form onSubmit>` with `preventDefault`, and every control has a `<label htmlFor>`. Errors appear next to the field, and a summary with anchors appears at the top (ui-ux-pro-max `error-feedback`, `form-labels`).
- **Status is never shown by color alone (gate):** use `<StatusBadge>` everywhere (icon + text), per spec §3.3 and §5.7.
- Use lazy-loaded route components (`React.lazy`) for Workflow editor, Report/Diff viewer, and Settings.
- Model output is rendered as structured views and plain text, never as HTML or Markdown (no Markdown renderer is bundled). If one is added later it must use `skipHtml` and a link renderer that shows the URL as text and opens it only through `relay/v1/app.openExternal` after a confirmation (spec §11.4). `dangerouslySetInnerHTML` is forbidden (gate: eslint `react/no-danger: error`).
- **Accessibility (ui-ux-pro-max CRITICAL tier):** visible `:focus-visible` ring, logical tab order, a skip link, `aria-live="polite"` for run status (announce completion and pauses, never tokens), 4.5:1 contrast (already true of the tokens), `prefers-reduced-motion` respected, and no information that exists only in tooltips.
- Use no emoji as icons. Use `lucide-react` only, at a consistent 16/18/20 px size.
- Long lists (run events, diff lines > 500) are virtualized with `@tanstack/react-virtual`.

## 6. Security rules (security-review skill → Electron)

| Skill item | Relay rule |
|---|---|
| Secrets management | Provider keys: `safeStorage` async encrypt → `userData/secrets/<refId>.bin` (0600). They never go to DB business tables, logs, exports, the renderer, or `process.env` of the runner. `.env.example` lists names only. **(gate)** |
| Input validation | Zod at every trust boundary: renderer→main, main→runner, provider response→engine, imported workflow/diff files, and DB JSON columns. |
| SQL injection | Parameterized statements only; see §4. |
| AuthN/AuthZ | Single local user. "AuthZ" means **capability checks**: project provider policy, file-root confinement, approval binding, and budget admission. Models cannot grant permissions (§11.1). |
| XSS | React escaping, no `dangerouslySetInnerHTML`, sanitized markdown, and a strict CSP. The production CSP is the one in 08 §H8 (R2-38): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`. The `<meta http-equiv="Content-Security-Policy">` is **generated per mode** by H's Vite `transformIndexHtml` plugin (`apps/desktop/build/vite-plugin-csp.ts`, 08); it is never hand-written in `index.html`. Only the dev build relaxes it (React-Refresh preamble hash, `ws://localhost:*`, `http://localhost:*`). `frame-ancestors` is ignored in a meta CSP, so it is not relied on. |
| CSRF | N/A. There is no HTTP server. The IPC sender frame URL is checked instead. |
| Rate limiting | IPC token buckets (02 §B6). |
| Sensitive data exposure | `redactString()` / `redactDeep()` from contracts (02 §B8) are applied to **logs, events, error details (and diagnostics exports built from them), and stored raw provider responses only** (R4-24). They are **never** applied to validated output artifacts (canonical output JSON, patches, reports), because redaction would corrupt diffs. Every `sk-` pattern is anchored with `(?<![A-Za-z0-9])` (so `risk-assessment-module-x` is not redacted) and the set covers `sk-ant-(api\|admin)NN-…`, `sk-proj-…`, `sk-svcacct-…`, generic `sk-…`, and `Bearer …`; 02 §B8 holds the canonical regex list. |
| Dependency security | `pnpm audit --prod` in CI (warn), lockfile committed, and `pnpm licenses list` recorded before distribution (§18.5). |
| Electron-specific | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webviewTag: false`, deny `window.open`/navigation, no `remote`, validate IPC senders, use packaged Fuses (08 §H9), and never expose `ipcRenderer` itself. |
| Prompt injection | Repo text and model output are **data**. They are wrapped in delimited untrusted blocks (07 §G3), and no model output is parsed into a permission. |

## 7. Testing standards

- **AAA structure** (Arrange / Act / Assert) with blank lines between the sections.
- **Descriptive names**, for example: `it('blocks dispatch when settled + reserved + unknown + proposed exceeds allowance')`. Avoid names like `it('works')`.
- **Test the difficult boundaries** (spec §17.1): money, persistence, permissions, and transitions. Do not snapshot-test UI labels.
- **Fake provider by default.** No network in `test:unit` / `test:integration` / `e2e`. A test that opens a socket fails, enforced by `tests/helpers/no-network.ts` in the Vitest setup.
- Each test gets a fresh temp DB (`openTestDb()`) and a temp dir, cleaned in `afterEach`.
- Property-based tests (`fast-check`) for budget arithmetic, path containment, and state-machine invariants.
- Coverage thresholds are listed in 00 §6. Coverage is a floor, not a goal.
- **Tags** in test titles (`@m1`, `@m2`, `@a11y`, `@crash`) drive the milestone greps.

## 8. Comments and docs

- Comment **why**, not what. Cite the spec section on any rule that encodes policy: `// §9.3: C + R + U + N <= L`.
- Public package exports get TSDoc (`/** … */`) with `@throws` for thrown invariants.
- Each package has a short `README.md` (owned by that package's agent) covering purpose, public API, and a dependency note.

## 9. Git and commits

- One commit per plan file after its gate passes, with message `plan-NN: <summary>`, followed by fix commits `plan-NN(fix): <referee finding id>`.
- Never commit `userData`, `.env`, `out/`, `dist/`, or `*.sqlite*`; `.gitignore` covers these. The only exceptions are the committed test/demo fixtures re-included by explicit negations in 01 §A1 (R2-4); the fixture `.env` holds only the obviously fake marker `sk-fixture-DO-NOT-READ…`.
- End commit messages with the attribution line from the session instructions.
