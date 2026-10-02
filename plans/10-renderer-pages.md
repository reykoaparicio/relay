# Plan 10: Renderer — Routing, Data Layer, Pages (Agent J)

Spec: §4 (journeys), §5.1–5.7, FR-01…FR-12 (UI side), §3.3 (UI stays responsive) · Backlog: RLY-006 (UI), RLY-022, RLY-023 (UI) · Waves (00 §3): **Wave 1 / M1** J1–J4 (fake bridge first, then real bridge) · **Wave 2 / M2** J6–J8 core (onboarding, new run, inspector core) · **Wave 3 / M3** J9 (memory) · **Wave 4 / M4** J8 complete, J10. J5 (state matrix) and J11 (page tests) apply to each page in the wave that lands it

Files (exclusive): `apps/desktop/src/renderer/{index.html,main.tsx,App.tsx,router.tsx,test-setup.ts,index-html.test.ts}`, `apps/desktop/src/renderer/{api,pages,features,hooks,state}/**`

Visual and behavioral reference: [`plans/mocks/index.html`](mocks/index.html). **Each page must implement every state listed in its mock's switcher.** The table in J5 maps each mock state to the condition that triggers it.

J depends on contracts (types) and I (components). J does **not** wait for H: it develops against `api/fake-bridge.ts`.

---

## J1: Bootstrapping (`index.html`, `main.tsx`, `App.tsx`, `router.tsx`)
- `index.html`: `<html data-theme="dark">` and `<div id="root">`. **No hand-written CSP**: the per-mode CSP `<meta>` is injected by H's Vite `transformIndexHtml` plugin (`apps/desktop/build/vite-plugin-csp.ts`, 08 §H8). J11 `index-html.test.ts` asserts the source `index.html` contains no `Content-Security-Policy`.
- `main.tsx`: imports `styles/theme.css` + `styles/fonts.css`, creates `QueryClient` (defaults: `staleTime: 5_000`, `retry: (n, e) => isRetryableAppError(e) && n < 2`, `refetchOnWindowFocus: false`), and renders `<App/>`.
- `App.tsx` nests `QueryClientProvider` → `LiveRegionProvider` → `ToastProvider` → `ThemeController` (reads app settings) → `RouterProvider`.
- `router.tsx` uses `createHashRouter` (React Router 8; hash routing works under `file://`):

| Path | Page (lazy?) | Mock |
|---|---|---|
| `/` | `RootRedirect` → `/onboarding` if no project or onboarding is incomplete, else `/p/:activeProjectId` | – |
| `/onboarding/:step?` | `OnboardingPage` (lazy) | onboarding.html |
| `/p/:projectId` | `OverviewPage` | overview.html |
| `/p/:projectId/workflows/:workflowId` | `WorkflowEditorPage` (lazy) | workflow-editor.html |
| `/p/:projectId/runs` | `RunsPage` | runs.html |
| `/p/:projectId/runs/new` | `NewRunPage` (lazy) | new-run.html |
| `/p/:projectId/runs/:runId` | `RunInspectorPage` (lazy; prefetched from Overview and New run) (`?step=<stepId>&tab=output\|context\|attempts\|events\|ledger`) | run-inspector.html |
| `/p/:projectId/runs/:runId/report` | `ReportPage` (lazy) | report.html |
| `/p/:projectId/memory` | `MemoryPage` (lazy) (`?tab=approved\|suggested\|archived&record=<id>`) | memory.html |
| `/settings/:section?` | `SettingsPage` (lazy) — providers, profiles, projects, data, diagnostics, about | settings-providers.html |
| `*` | `NotFoundPage` | – |

PERF-04: the shell, Overview and Runs load eagerly; every other page is a `React.lazy` route declared in `features/shell/lazy-pages.ts` (shared loaders, so a page can prefetch the next one without importing the router). Every page sits under a pathless `pages` route whose `errorElement` (`PageErrorView`) renders inside the shell: a page whose chunk fails to load (or that crashes) shows "This page failed to load" with a Reload action (a full window reload: a rejected lazy import cannot be retried in place) while the navigation stays usable; navigating away clears it. The shell route's own `errorElement` (`RouteErrorPage`) only catches a crash of the shell itself.

**The active project lives in the URL** (§5.1, "prevents accidental cross-project context"). Switching projects navigates to `/p/<id>` and persists `activeProjectId` via `app.updateSettings`.

P0 navigation shows Overview, Workflows, Runs, Memory, and Settings. **Schedules and Usage are hidden** (§5.1 "hide unfinished navigation entries").

**Route coverage.** Every route in the table above is registered and renders its real page, and each page emits the J2 `relay:nav:<route>` measure when its content renders (12's `@m1` `responsiveness.spec.ts` and `smoke.spec.ts` time these). There is no placeholder page.

**Runner stubs.** Every operation is implemented by the real runner. A channel that answers `INTERNAL` with `details.reason = 'not_implemented'` (a future stub) gets no special UI: it renders through the normal `ErrorView` / `MutationError` / `ActionErrorNotice` path like any other error. The fake bridge keeps `world.notImplemented` as a test hook so that generic path stays covered; no fake scenario stubs a channel.

## J2: Data layer (`api/*.ts`, `hooks/*.ts`)

```ts
// api/bridge.ts — the only place that touches window.relay
export interface RelayBridge { invoke<C extends Channel>(c: C, i: InputOf<C>): Promise<IpcResult<C>>; subscribe(l: (e: PushEvent) => void): () => void }
export function getBridge(): RelayBridge { return (window as unknown as { relay?: RelayBridge }).relay ?? createFakeBridge(fakeScenarioFromUrl()) }

// api/client.ts — typed call; throws AppErrorException for TanStack Query error channel
export async function call<C extends Channel>(c: C, input: InputOf<C>): Promise<OutputOf<C>>;

// api/keys.ts — query key factory (primitive keys; no object identity issues)
export const qk = {
  project: (id) => ['project', id] as const, projects: () => ['projects'] as const,
  runs: (projectId, status?: string) => ['runs', projectId, status ?? 'all'] as const,
  run: (id) => ['run', id] as const, step: (runId, stepId) => ['step', runId, stepId] as const,
  events: (runId) => ['events', runId] as const, ledger: (runId) => ['ledger', runId] as const,
  memory: (projectId, tab) => ['memory', projectId, tab] as const, memoryRecord: (id) => ['memory-record', id] as const,
  providers: () => ['providers'] as const, profiles: () => ['profiles'] as const, catalog: () => ['catalog'] as const,
  workflow: (id, v) => ['workflow', id, v] as const, diagnostics: () => ['diagnostics'] as const, info: () => ['app-info'] as const,
};
```

**Performance marks (12 L2 contract).** `hooks/useNavPerf.ts` owns them:
- On every navigation (router `navigation.state` change / location change), it calls `performance.mark('relay:nav:<route>:start')`, where `<route>` is the matched route id (`overview`, `runs`, `new-run`, `run-inspector`, `report`, `memory`, `settings`, `workflow-editor`, `onboarding`).
- When the route's content is ready (its primary query has rendered data, or the placeholder has mounted), the page calls `markRouteReady(route)`, which runs `performance.measure('relay:nav:<route>', 'relay:nav:<route>:start')` once per navigation.
- `RunsPage` additionally calls `performance.mark('relay:history-loaded')` the first time the runs list renders its first page of rows (or the empty state), and a matching `performance.measure('relay:history-loaded')` from navigation start.
- Marks are always on (cheap, no PII); tests read them with `performance.getEntriesByType('measure')`.

Hooks (`hooks/`), one file each: `useProject`, `useRuns` (infinite query with `nextCursor`), `useRun`, `useStep`, `useRunEvents`, `useLedger`, `useMemoryList`, `useMemoryRecord`, `useProviders`, `useProfiles`, `useCatalog`, `useWorkflow`, `useDiagnostics`, `useAppInfo`, `useIdempotentMutation`, `useNavPerf`.

- **`useRunEvents(runId)`** implements the gapless contract (02 §B5):
  1. On mount it calls `runs.events({afterSeq: 0})`, then subscribes to push.
  2. For each `run.event` with `seq === last+1` it appends. On a gap it backfills.
  3. Relevant event types invalidate `qk.run(runId)` and `qk.ledger(runId)`, **debounced 250 ms**.
  4. It announces via `LiveRegion` **only** `run.status_changed` to `awaiting_approval`, `paused`, `completed`, `incomplete`, `cancelled`, `failed`, or `interrupted` (§5.7). It is the **single** run-status announcer (A11Y-01): banners and the page header status are not live regions.
  5. PERF-02: `attempt.stream_progress` goes to a per-run `StreamProgressStore` (outside React state). A drain that applied only progress publishes nothing, so the page does not re-render per token push; `useStreamProgress(runId, attemptId)` (used only by `StreamingAttemptCard`, which also owns the 1 s clock) subscribes to it.
- **`useIdempotentMutation(channel)`** generates one `idempotencyKey` (ULID via contracts `createIdGen` with a crypto random) **per user intent**. The key is reused across retries of the same intent and reset after success or when the form changes, so a double-click or a retry never double-starts (02 §B0).
- Global push handler (`state/push-sync.ts`): `run.status` updates cached run summaries and the run detail in place and marks the detail stale, then refreshes `['runs', projectId]` and `qk.project(projectId)` with a 250 ms trailing debounce; at the same flush it refetches the run detail (exact `qk.run` key) only if a page shows it and it is still stale and idle (Overview's focus run; the inspector has already refetched it through `useRunEvents`, so a status change costs one `runs.get`); the project comes from the cached run detail or the cached list that holds the run (all run lists when nothing cached knows it). `memory.changed` invalidates that project's memory lists and only its cached records (PERF-03/05). `providers.changed` invalidates providers. `runner.state` drives a shell banner ("Background runner restarting…" / "unavailable → Open diagnostics").
- Error mapping (`api/errors.ts`): `AppError.code` → `ErrorView` props. `nextAction` → the route or handler (for example `reconnect_provider` → `/settings/providers`, `increase_allowance` → opens the dialog, `narrow_scope` → focuses the file picker).
- Run-action dispatch (`features/run-inspector/run-actions.ts`): the single place that turns a `RunAction` from `RunDetail.availableActions` into a UI control and an IPC call. It follows the 02 action→op table (02 §B, `RUN_ACTIONS`) and is exhaustive over `runActionSchema` (a `satisfies Record<RunAction, …>` map, so a new action is a compile error):

| `RunAction` | UI control | IPC op |
|---|---|---|
| `pause` | header button | `runs.pause` |
| `cancel`, `stop` | `ConfirmDialog` (best-effort in-flight cancellation, FR-11) | `runs.cancel` |
| `resume` | button | `runs.resume({ decision: { kind: 'continue' } })` |
| `approve`, `request_revision`, `reject` | `ApprovalCard` | `approvals.decide` (with the displayed hashes) |
| `increase_allowance` | dialog with `MoneyInput` | `runs.increaseAllowance` |
| `edit_project_allowance` | dialog with the project monthly `MoneyInput` | `projects.update({ patch: { monthlyAllowanceMicrousd } })` |
| `choose_profile` | profile `Select` dialog (permitted profiles only; note: "creates a recorded configuration revision", §4.3) | `runs.retryStep({ stepId, profileId })` when the paused step is `failed`; otherwise (e.g. budget or setup pauses) `runs.resume({ decision: { kind: 'switch_profile', stepKey, profileId } })` (02 `RUN_ACTION_OPS.choose_profile` lists both channels) |
| `retry_step` | button | `runs.retryStep({ stepId })` (a new step row with fresh retry counters) |
| `raise_limits` | dialog with `NumberInput`s for max attempts and execution timeout (seconds), each bounded `current < value ≤ RUN_LIMIT_MAXIMUMS.*` with inline errors | `runs.resume({ decision: { kind: 'raise_limits', maxAttempts?, executionTimeoutSeconds? } })` |
| `acknowledge_overrun` | button in the overrun banner | `runs.resume({ decision: { kind: 'acknowledge_overrun' } })` |
| `reconnect_provider` | link | navigates to `/settings/providers` (`providers.connect` / `providers.test` there) |
| `resnapshot_and_replan`, `use_preserved_snapshot` | buttons | `runs.resume({ decision: { kind } })` |
| `decide_unknown` | `RecoveryPanel` decision buttons | `runs.decideUnknown` |
| `review_recovery` | opens `RecoveryPanel` | `runs.resume({ decision: { kind: 'continue' } })` from the panel |
| `export_report`, `export_patch` | header buttons | `artifacts.export({ what: 'report' \| 'patch' })` |

  Every mutating op on an `Idem` channel goes through `useIdempotentMutation`.

## J3: Fake bridge (`api/fake-bridge.ts`, `api/fake-scenarios/*.ts`) — dev & tests
- `createFakeBridge(scenario)` implements **every** channel in `OPERATIONS` with in-memory state. It validates inputs with the same Zod schemas and returns outputs that parse with the output schemas (a dev assertion).
- Scenarios mirror the mock states: `empty`, `awaiting-approval`, `active-run`, `interrupted`, `provider-disconnected`, `budget-blocked`, `budget-paused`, `budget-paused-project`, `budget-overrun`, `unknown-outcome`, `schema-invalid`, `output-invalid`, `provider-unavailable`, `setup-blocked`, `refused`, `rate-limited`, `paused-user`, `paused-limit`, `approval-stale`, `failed`, `cancelled`, `completed`, `incomplete`, `incomplete-report`, `memory-conflict`, `no-secure-storage`. Each paused scenario returns the `availableActions` from the 06 `allowedRunActions` table for its `pauseReason`. A scenario is selected by URL query `?fake=<name>` in `pnpm dev:renderer`.
- It is used by page tests (J11) and lets J build every screen before H lands. It is **excluded from production bundles**: the import is guarded by `import.meta.env.DEV || import.meta.env.MODE === 'test'`, and `getBridge()` throws in production if `window.relay` is missing.

## J4: Shell & Overview (`pages/OverviewPage.tsx`, `features/shell/*`)
- `features/shell/Shell.tsx` composes `AppShell` + `SideNav` (the Runs badge shows the count of `awaiting_approval` runs) + `ProjectSwitcher` + provider status line ("2 providers connected" / warning) + `FakeProviderBadge` + runner banner.
- Overview content (§5.2):
  - Stat tiles: Active runs (sub: "Waiting for your approval"), Tracked usage (sub: "$0.36 reserved in flight", caption "tracked by Relay", links to the latest run's ledger `/p/:projectId/runs/:latestRunId?tab=ledger`; no link when there are no runs), Project memory (sub: "2 suggestions to review", links to `/memory?tab=suggested`).
  - Every budget value shown on Overview (tile amounts, run-controls budget) links to `/p/:projectId/runs/:runId?tab=ledger` for the run it belongs to. The project-month ledger export lives in Settings → Data.
  - "Needs your attention" card: the **exact pending step**. Clicking goes to `/runs/:id?step=<approval step>` (§5.2 "Clicking the active-run card opens the exact pending step"). It also shows "No project files have been modified."
  - Run controls card: run budget, revision cycles, actions "Draft patch only", execution "One step at a time".
  - Recent runs: the 3 latest via `useRuns(limit 3)`.
- Empty state: "Try the sample project" (`projects.createSample`) + "Start: Review & propose a fix" (§5.2).

## J5: Page ↔ mock state matrix (acceptance for every page)

| Page | Mock state | Trigger condition in real data |
|---|---|---|
| Overview | awaiting-approval | any run with status `awaiting_approval` |
| | active-run | a `running` run and no approval pending |
| | empty | `projects.get().stats.runs === 0` |
| | interrupted | any run `interrupted` **or** `paused(unknown_outcome)` → `RecoveryPanel` |
| | provider-disconnected | a provider with `lastTest.ok === false && code === 'AUTH_REQUIRED'`, or a run paused `auth_required` |
| Runs | list / filtered / empty | data-driven; status filter via URL `?status=` |
| New run | ready / validation-errors / budget-blocked | `runs.preflight` result: `issues.length`, `budget.allowed` |
| Workflow editor | editing / validation-errors / validated | draft exists / `workflows.validate` issues / publish success |
| Run inspector | awaiting-approval | status `awaiting_approval` |
| | running-streaming | status `running` + selected step `executing` with `attempt.stream_progress` events |
| | budget-paused | `paused(budget_run)` or `paused(budget_project)` (project variant shows Edit project allowance) |
| | budget-overrun | `paused(budget_overrun)` |
| | unknown-outcome | `paused(unknown_outcome)` |
| | schema-invalid | selected step is repairing or `failed` with validation issues while the run is not yet paused (issues list + repair attempts used) |
| | output-invalid | `paused(output_invalid)` |
| | provider-unavailable | `paused(provider_unavailable)` or `paused(setup_blocked)` (setup copy variant) |
| | refused | `paused(model_refused)` |
| | rate-limited | `paused(rate_limited)` |
| | paused-user | `paused(user)` |
| | paused-limit | `paused(limit_attempts)` or `paused(deadline)` |
| | auth-failed | `paused(auth_required)` |
| | approval-stale | `paused(approval_stale)` (or `PROJECT_CHANGED` on approve) |
| | interrupted | status `interrupted` |
| | cancelling | status `cancelling` |
| | cancelled | status `cancelled` |
| | failed | status `failed` (unrecoverable only) |
| | completed | status `completed` |
| | incomplete | status `incomplete` |
| Memory | approved / suggestions / conflict / edit / delete-confirm / stale-source | tab + selected record + `conflictsWith.length` + `stale` |
| Report | report / patch / export-dialog / export-failed | tab + export mutation state |
| | incomplete-report | report of a run whose status is `incomplete`, `cancelled`, or `failed` (the `report.v1` artifact from 06 F17 exists for every terminal status) |
| Settings | connected / no-secure-storage / auth-failed / diagnostics | `providers.list` + `app.getDiagnostics().secureStorage` |
| Onboarding | welcome, start-point, connect-provider, select-project, add-rule, choose-template, profiles-and-allowance, review-and-start | the route param `:step` |

The run-inspector and report state names above are the exact mock state names; the mock agent adds any that are missing from `run-inspector.html` / `report.html` under these names.

## J6: Onboarding (`pages/OnboardingPage.tsx`, `features/onboarding/*`) — §4.1, FR-01, FR-02
There are 8 steps (route `:step` = the mock state names), and Back and Continue keep the state in a reducer. Nothing is persisted until the explicit actions below:
1. **`welcome`:** local storage vs remote processing explanation (§6.2 boundary text), with the sample project offered up front (§4.1 step 2).
2. **`start-point`:** "Use the sample project" (`projects.createSample`) or "Choose my own folder".
3. **`connect-provider`:** a provider select, a masked key input (`type=password`, `autocomplete=off`), a "Store with macOS Keychain protection" vs "Session only" choice, then `providers.connect` → `providers.test`. The result is shown redacted, and a note says a second provider is optional now but required for the multi-provider demo.
4. **`select-project`:** `projects.pickDirectory` → `projects.previewFiles` → `FileTree` with excluded reasons and totals vs caps → `projects.create` with name + allowed providers (checkboxes, §11.1). This step is skipped when the sample was chosen, but its preview is still shown.
5. **`add-rule`:** `memory.create` (type `user_rule`). The example placeholder is "Preserve the existing public response format".
6. **`choose-template`:** `workflows.list` offers only `review-propose-fix` in P0.
7. **`profiles-and-allowance`:** a role → profile table (Economy/Balanced/Capable, editable) and the run allowance `MoneyInput` (default $3.00).
8. **`review-and-start`:** `runs.preflight` summary → "Start run" (`runs.start`) → sets `app.updateSettings({ onboardingCompletedAt })` → navigates to the inspector.

The first-run flow must not require any knowledge of graph theory, tokenizers, cron, or orchestration (§4.1). The copy avoids those terms.

## J7: Runs list & New run (`pages/RunsPage.tsx`, `pages/NewRunPage.tsx`)
- Runs: `DataTable` with columns Run, Goal, Workflow version, Status, Steps (`done/total`), Tracked cost (`Money` + certainty), Started, Duration. The first cell is a link. "Load older runs" uses `fetchNextPage`. The status filter uses tabs and the URL.
- New run form (controlled, `<form onSubmit>`):
  - Goal (required, 1–2000).
  - Input source: a radio for "Selected files" (tree picker from `projects.previewFiles`, multi-select, included files only) or "Import a .diff/.patch file" (`artifacts.importDiff`).
  - Workflow version, read-only: "Review & propose a fix · v3".
  - Role → profile snapshot table (provider, model, max output) with a per-step override select. Changed selects are sent as `RunStartInput.profileOverrides: Record<StepKey, ProfileId>` (only the steps the user changed).
  - Limits (allowance, revision cycles, attempts, timeout; concurrency locked). Inputs are bounded by `RUN_LIMIT_MAXIMUMS`.
  - Memory records to include (approved only, checkboxes; pinned rules shown checked and locked on). The checked non-pinned records are sent as `RunStartInput.memoryRecordIds` ("include these approved records"; pinned rules are always included by the engine, so they are not sent). An explicit selection is capped at the contract maximum (50): at the cap unticked records are disabled with an explanation, more than 50 ticked is a memory-field problem (no preflight is sent), and "Include all approved records" returns to the untouched default. `usePreflight` reports a key the schema rejects as `VALIDATION_FAILED` with field paths, never as `INTERNAL`.
  - A preflight summary panel that recomputes on change, **debounced 400 ms**. It shows files/bytes/estimated tokens, "Providers that will receive this context" (§6.2), and the first reservation N.
  - `budget-blocked` → `BudgetBreakdownTable` + options (increase allowance inline / choose cheaper profile / cancel).
  - Preflight `issues` (06 F14 readiness, wave 4) are form problems and block Start: per model step at `profileOverrides.<step>` (`unknown_profile`, `provider_not_allowed` — an issue now, never a PERMISSION_DENIED preflight error — `missing_credential`, `model_unknown` and the other capability codes), linked to that step's profile select. `missing_credential` names the step's role and provider and adds a "Connect provider" link to Settings → Providers (onboarding: a "Connect provider" button back to `connect-provider`). `budget_run` / `budget_project` restate `budget.allowed = false`, so they are dropped while the budget card is shown (`features/run-setup/preflight-issues.ts`). `runs.start` still accepts a missing credential (the run pauses `auth_required` at queued), but the form never sends an input whose preflight has issues.
  - Submit uses `useIdempotentMutation('relay/v1/runs.start')`.

## J8: Run inspector (`pages/RunInspectorPage.tsx`, `features/run-inspector/*`) — §5.4 (the most important page)
- Layout (via I's `ResponsivePanels`): `StepTimeline` (left) | selected step panel (main) | bottom row `BudgetLedger` + Context summary card. **Below 1280 px** the bottom row collapses into the step-panel tab list as two extra tabs ("Budget", "Context summary"); the timeline stays visible. No content is hidden at narrow widths, only regrouped.
- Header actions come **only from `RunDetail.availableActions`**, rendered through `run-actions.ts` (J2): Pause, Cancel run (`ConfirmDialog` explaining that in-flight cancellation is best-effort and charges may be unknown, FR-11), Export report / Export patch (terminal only).
- Tabs (`?tab=`): Output (renders the structured artifact via per-schema viewers `FindingsView`, `PlanView`, `PatchView` → `DiffViewer`, `ReviewView`; each viewer imports its output type from `@relay/contracts` `outputs/*`, never a local copy), Context (`ContextManifestView`, typed by the contracts `ContextManifest`), Attempts (`AttemptsTable`), Events (virtualized list of the run's events filtered to the step), **Ledger** (run-scoped, independent of the selected step: `useLedger(runId)` → `LedgerEntryView[]` table with created, step, attempt, type, bucket, delta, certainty, price catalog version, plus an "Export ledger (CSV)" button → `ledger.export({ runId })`; main shows the save dialog). `?tab=ledger` is the target of every Overview budget link.
- The approval step uses `ApprovalCard`. `approvals.decide` sends the **hashes displayed** (`planHash`, `contextHash`). `APPROVAL_STALE` → an inline alert and a refetch.
- Status banners (`features/run-inspector/StatusBanner.tsx`) map from status/`pauseReason` to `InlineAlert` (label/tone/icon from `statusPresentation`) + the action buttons. The mapping is exhaustive over `pauseReasonSchema` (compile error when a reason is added). Buttons appear only if the action is in `availableActions`; the list below is the expected set from the 06 `allowedRunActions` table:

| Status / `pauseReason` | Banner content | Actions (→ op via J2 table) | J5 state |
|---|---|---|---|
| `paused(budget_run)` | `BudgetBreakdownTable` ("$3.10 > $3.00 → blocked") | increase allowance / choose profile / stop. After `runs.increaseAllowance` the run resumes automatically when admission now passes, so the UI only refetches | budget-paused |
| `paused(budget_project)` | `BudgetBreakdownTable` with the project-month figures | edit project allowance (`projects.update`; the engine re-evaluates paused runs of the project) / choose profile / stop | budget-paused |
| `paused(budget_overrun)` | "The last call cost $X, more than the $N reserved." + `BudgetBreakdownTable` | acknowledge overrun / increase allowance / stop | budget-overrun |
| `paused(limit_attempts)` / `paused(deadline)` | "Attempt limit reached (n of n)" / "Execution time limit reached (m of m)"; time waiting for approval is not counted | raise limits (dialog bounded by `RUN_LIMIT_MAXIMUMS`) / stop | paused-limit |
| `paused(output_invalid)` | the failed step's validation issues list, "Repair attempts used: n of n", View raw response (redacted artifact) | retry step / choose profile / stop | output-invalid |
| `paused(provider_unavailable)` | "The provider did not respond after a retry"; attempt error code | retry step / choose profile / stop | provider-unavailable |
| `paused(model_refused)` | "The model declined this step"; suggests another profile | retry step / choose profile / stop | refused |
| `paused(setup_blocked)` | the blocking setup issue (from `RunDetail`), e.g. model no longer supported | resume (re-run checks) / choose profile (`switch_profile`) / stop | provider-unavailable (setup copy variant) |
| `paused(unknown_outcome)` | `RecoveryPanel`: "Request may have been sent… charge unknown… $X liability retained". The retry decision label contains "may incur another charge" (§4.4). With every unknown decided and no failed step: "Every request with an unknown outcome has been decided" | decide unknown (3 decisions, `runs.decideUnknown`) / stop; or resume (`runs.resume { kind: 'continue' }`) / stop | unknown-outcome |
| `paused(auth_required)` | "Reconnect provider"; from `queued` (`startedAt` null, no attempt): "No API key is connected for X", the step that needs it, "nothing was sent or reserved" | reconnect provider (link) / resume / stop | auth-failed |
| `paused(user)` | "Paused by you. The in-flight request (if any) completed." | resume / stop | paused-user |
| `paused(rate_limited)` | "Provider rate limit: waits exhausted" | resume / stop | rate-limited |
| `paused(approval_stale)` / `PROJECT_CHANGED` | the changed file and hash (before → after) | resnapshot and replan / use preserved snapshot / stop | approval-stale |
| `interrupted` | `RecoveryPanel` (last completed step, unresolved attempts with liability) | review recovery / decide unknown (per unknown attempt) / stop | interrupted |
| `cancelling` | disabled state: "Cancellation requested; waiting for the in-flight request to stop (best effort)" | none | cancelling |
| `cancelled` | "Run cancelled"; unresolved charges listed with liability | export report | cancelled |
| `failed` | "Run failed because of an internal error"; error code + "Open diagnostics"; useful artifacts still listed | export report | failed |
| `completed` | verdict + "Completed means the configured workflow accepted its output. It does not guarantee the code is correct" (§7.2) | export report / export patch | completed |
| `incomplete` | "Revision limit reached (2 of 2)"; useful artifacts still listed | export report / export patch (if any) | incomplete |

- Queued pauses (06 F2 clarification 9): `queued → paused(auth_required | setup_blocked | budget_run | budget_project)` happens before any attempt. The banner says the run has not started (budget: "Paused before the first request"), and the selected step / `choose_profile` target is the step named by `statusDetail.details.stepKey` when present; the Attempts tab shows its empty state.
- Step-level states (independent of the run banner): a `schema-invalid` step (repair in progress or failed validation) shows the issues list, "1 of 1 repair attempts used", and View raw response (redacted artifact). `running` + streaming → the attempt card shows elapsed time, provider latency vs app time, and a skeleton; `attempt.stream_progress` updates the token count **without** content.
- `ReportPage`: renders the run's `report.v1` artifact (type imported from contracts `outputs/report.v1`): report summary (goal, verdict, versions, profiles, providers, cost with the certainty breakdown, **limitations** section), findings, patch tab (`DiffViewer`), and "Original project files were not modified". **Approvals** (`report.v1.approvals[]`, oldest first): step, decision ("approved" / "revision requested" / "rejected" / "not decided"), decided (or opened) time, plan hash, the note as plain text, and an "invalidated: <reason>" badge. **Revisions** (`report.v1.revisions`): "Quality revision cycles: X of max", "Plan revisions: N", and the incomplete cause for an incomplete run. Both are optional (reports before wave 4): "Not recorded in this report." The `incomplete-report` state (run `incomplete`, `cancelled`, or `failed`) leads with the terminal status and reason, lists the steps that did not finish, and shows whichever artifacts exist; the patch tab is hidden when no patch artifact exists. Export uses `artifacts.export`; main handles the dialog. On failure, "Run is intact; retry export only" is shown.

## J9: Memory (`pages/MemoryPage.tsx`, `features/memory/*`) — §5.5, §4.5
- Tabs Approved / Suggested / Archived (URL `?tab=`). A list (`MemoryRecordCard`) and a detail panel: type (`user_rule` / `project_decision` / `source_reference` / `run_summary`, as text), content, source link to the run, scope, status/revision/expiry, **pinned** (a toggle for approved records → `memory.update({ pinned })`; pinned rules are always included in runs), **review date** (`reviewAt`, with the "Confirm still accurate" action when due), **superseded** (when `supersededById` is set: "Superseded by <title>" linking to `?tab=…&record=<supersededById>`), created/updated, revision history, and the "No secrets or provider credentials belong in memory." note.
- Actions: Add project rule (dialog → `memory.create`), Edit (form with `expectedRevision`; the note says "Saving creates revision N+1; runs that already used revision N keep it"), Archive, Delete (`ConfirmDialog` destructive with consequences: removed from future retrieval, while existing run snapshots keep copies; a link to "Purge project history" in Settings → Data).
- Suggestions queue: each suggestion shows the proposed text, why it is reusable, source refs, scope, and the actions Approve / Edit then approve / Reject / Combine with existing. **Combine** opens `ConflictCompare` with the suggestion and the chosen approved record and resolves via `memory.resolveConflict({ idempotencyKey, recordIds: [suggestionId, approvedId], resolution: { rewrite: { title, content, scope } } })` (one of the two ids may be a suggestion, 02).
- The conflict state is `ConflictCompare`. The stale-source state shows a "Source changed since approval" badge and "Confirm still accurate", which writes a `memory.update` with unchanged content and `reviewAt = now`, producing a new revision with an audit trail.

## J10: Workflow editor & Settings (`pages/WorkflowEditorPage.tsx`, `pages/SettingsPage.tsx`)
- Workflow editor (§5.3):
  - An ordered step list, with **structural controls rendered disabled** and the visible explanation "Structural editing arrives in a later release".
  - A step detail form: name, role (read-only), instruction version with a view/edit prompt textarea, profile select, output schema (read-only), allowed tools (read-only chips), output token max, retry policy, and memory scope.
  - A workflow-level limits card.
  - Save draft (`workflows.saveDraft` with `expectedDraftRevision`) and Validate (`workflows.validate`) → an error summary with anchors to fields (`steps[3].maxOutputTokens` → element id) → Publish.
  - The banner says "New edits affect future runs only."
- Settings sections:
  - Providers: list, connect/test/disconnect (`providers.test` can return `BUDGET_BLOCKED` when the setup allowance is used up → message links to Data), and the OpenAI `store` data-handling note (04 §D5). A **Models** table (`CatalogTable` from `providers.catalog`: model, capabilities ✓/✗ with text, prices, catalog version, source as text, effective date) plus a per-profile capability check column fed from `profiles.list`, whose rows are `{ profile, warnings: CapabilityWarning[] }` computed by the engine (06 F14 `profilesWithWarnings`). For each profile using that model the column shows "OK" (empty `warnings`) or the `CapabilityWarning` text; `CatalogTable.profileChecks` is built by grouping these rows by `profile.modelId`. The renderer never checks capabilities itself; the engine re-validates at preflight.
  - Model profiles: the CRUD editor listing `profiles.list` rows with their engine-computed `warnings`, and capability warnings from `profiles.upsert` after a save.
  - Projects: rename, exclusions editor (with a live preview), allowed providers, monthly allowance, an **OpenAI "Store responses at OpenAI"** toggle (`projects.update({ patch: { providerOptions: { openai: { storeResponses } } } })`, default on, with the 04 §D5 explanation; disabling it limits unknown-outcome reconciliation), archive.
  - Data: backup; **Export project (JSON)** (`projects.export({ projectId })`; main shows the save dialog; the bundle has no credentials and no absolute root path); **Export ledger for a month (CSV)** (month select → `ledger.export({ projectId, month })`); **raw-response retention** (`NumberInput` 1–365 days → `app.updateSettings({ rawResponseRetentionDays })`); **setup allowance** (`MoneyInput`, default `SETUP_ALLOWANCE_MICROUSD` = $0.05/month for connection tests → `app.updateSettings({ setupAllowanceMicrousd })`); export diagnostics (redacted; the user reviews the list of included items before saving, §18.3); purge project history (03 C8: run-snapshot memory copies plus the runs' raw responses and context manifests; the toast reports `purgedArtifacts`, and when `failed > 0` it is a warning "N files could not be removed; they will be retried"); retention note (§12.3 "do not claim the full database is encrypted").
  - Diagnostics: runner heartbeat, schema version, unresolved calls, provider mode.
  - About: version and build id (§18.5) and a "Third-party licenses" note. Relay has no license page of its own yet, and the third-party notice list is not bundled in the prototype build, so the copy says that. The Electron license link opens through `app.openExternal` (main confirms; https only). Bundling `docs/release/licenses.txt` into About needs a build change (a `?raw` import or an `extraResources` file plus an IPC read), which is tracked separately.

## J11: Page tests (owned by J; `*.test.tsx`; jsdom + fake bridge + I's `renderWithProviders`)

| File | Must cover |
|---|---|
| `OverviewPage.test.tsx` | Each mock state renders via the fake scenario. The attention card link targets the approval step. The usage card says "tracked by Relay" and links to `/p/:id/runs/:latestRunId?tab=ledger`; budget values link to `?tab=ledger` |
| `NewRunPage.test.tsx` | Validation errors are shown near fields plus in the summary. Budget-blocked shows the L/C/R/U/N numbers. Double submit → a single `runs.start` call with the same idempotency key. A changed per-step profile select → `profileOverrides` contains only that step key. Checked memory records → `memoryRecordIds` (pinned rules not sent). Limit inputs above `RUN_LIMIT_MAXIMUMS` show a field error |
| `RunInspectorPage.test.tsx` | Parameterized over **every** J5 run-inspector state (awaiting-approval, running-streaming, budget-paused incl. project variant, budget-overrun, unknown-outcome, schema-invalid, output-invalid, provider-unavailable incl. setup_blocked, refused, rate-limited, paused-user, paused-limit (attempts and deadline), auth-failed, approval-stale, interrupted, cancelling, cancelled, failed, completed, incomplete): the right banner and **only** the `availableActions` buttons. Each action calls the op from the J2 action→op table (`edit_project_allowance` → `projects.update`; `raise_limits` → `runs.resume` `raise_limits` and the dialog rejects values above `RUN_LIMIT_MAXIMUMS`; `acknowledge_overrun` → `runs.resume`; `retry_step` → `runs.retryStep`; `stop` → `runs.cancel`). Approve sends the displayed hashes. Revision requires a note. Stale approval refetches. `?tab=ledger` shows the ledger entries and "Export ledger (CSV)" calls `ledger.export({ runId })`. At a 1100 px width the Budget and Context summary panels render as tabs (`ResponsivePanels`) |
| `run-actions.test.ts` | The action→op map is exhaustive over `runActionSchema.options`, and each entry targets a channel present in `OPERATIONS` |
| `ReportPage.test.tsx` | report and incomplete-report states render from `report.v1` fixtures (incomplete, cancelled, failed); the patch tab is hidden without a patch; export failure shows "Run is intact; retry export only" |
| `useRunEvents.test.ts` | A gap triggers backfill. Duplicates are ignored. Only status transitions are announced (the live region spy is not called for `attempt.stream_progress`) |
| `MemoryPage.test.tsx` | Suggestion approve with edit → `expectedRevision` sent. Delete shows consequences. Conflict resolution choices. Combine on a suggestion → `memory.resolveConflict` with `recordIds: [suggestionId, approvedId]` and `resolution.rewrite`. The detail panel shows type, pinned, review date, and a working superseded-by link |
| `OnboardingPage.test.tsx` | Full 8-step flow on the fake bridge. The key input is masked. The redacted label is shown and the key is never displayed after submit |
| `SettingsPage.test.tsx` | no-secure-storage → offers a session-only key and never plaintext. Diagnostics fields render. Providers shows the Models `CatalogTable` with per-profile check results. Projects `storeResponses` toggle → `projects.update` with `providerOptions.openai.storeResponses`. Data: Export project → `projects.export`; month ledger export → `ledger.export({ projectId, month })`; retention days (1–365 enforced) and setup allowance → `app.updateSettings` |
| `index-html.test.ts` | The source `index.html` contains no hand-written `Content-Security-Policy` meta (H's Vite plugin injects it) |
| `a11y.pages.test.tsx` | `axe` finds no violations on each page in its default state and on each new run-inspector banner state. The skip link is present. Exactly one `h1` per page |

## Success Criteria (gate)
- [ ] `pnpm test:unit apps/desktop/src/renderer` → green
- [ ] `pnpm typecheck` → exit 0
- [ ] `pnpm lint` → exit 0 (no node/electron/provider imports in renderer; jsx-a11y strict)
- [ ] `pnpm dev:renderer` → every `?fake=<scenario>` route renders without console errors (manual check against the mocks side by side; screenshot pairs attached to the commit)
- [ ] Bundle check: `pnpm build` → `out/renderer` contains no `fake-bridge` code (`grep -r "createFakeBridge" apps/desktop/out/renderer` → no match)
- [ ] `pnpm build` → `out/renderer/index.html` contains exactly one CSP `<meta>` (injected by H's plugin), while `apps/desktop/src/renderer/index.html` contains none
- [ ] Every J5 run-inspector and report state (including the new pause states and `incomplete-report`) has a `?fake=` scenario and renders in `pnpm dev:renderer` at 1440 px and 1100 px

## Review Checklist
- [ ] No page re-derives run policy (buttons come only from `availableActions`)
- [ ] Every `pauseReason` in the 06 `allowedRunActions` table has a banner, and every action maps to the op in the 02 action→op table (J2 `run-actions.ts` is the only mapping)
- [ ] The raise-limits dialog cannot submit values above `RUN_LIMIT_MAXIMUMS`
- [ ] Every mock state from J5 is reachable from real data, with the exact state names
- [ ] Output viewers and `ContextManifestView` consumers import their types from `@relay/contracts` (no local output/manifest types)
- [ ] `profileOverrides` / `memoryRecordIds` / `memory.resolveConflict` inputs match 02 exactly
- [ ] Below 1280 px the inspector's secondary panels become tabs; nothing is dropped
- [ ] No hand-written CSP in `index.html`
- [ ] No absolute path is displayed except `displayPath`
- [ ] Announcements are limited to completion, pause, and approval (no token spam)
- [ ] Every destructive action has a confirmation, and read-only navigation has none (§5.7)
