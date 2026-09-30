# Review Rounds 2–4 — Findings & Binding Decisions

Rounds:
- **R2**: cross-plan consistency (40 findings).
- **R3**: spec coverage (37 findings).
- **R4**: technical correctness (36 findings).

Every finding below has a **decided fix**. Fix agents apply the decisions to the plan file(s) named in each section, and only those files. When a decision names text for another plan, that other plan's agent applies its own side. The ids are cited in commit messages and in the 14 §7 log.

General rule for editors: edit in place so the plan reads as one coherent final spec. Do **not** append "amendment" sections that contradict earlier text. Remove any superseded text. Keep existing section ids (B1, C3, …). New tasks get the next free id.

---

## 00b-engineering-standards.md
- **R2-38 CSP.** Replace the §6 CSP with the production CSP from 08 §H8. State that the meta CSP is generated per mode by a Vite `transformIndexHtml` plugin (see 08).
- **R3-31.** Add `outcome` to the logger fields list (§3 "Structured logging").
- **R4-24.** The redaction rule is `redactString` applied to logs, events, error details, and raw responses only. **Never** apply it to validated output artifacts, because it would corrupt diffs.

## 01-foundation.md
- **R2-2.**
  - Add `@relay/storage`, `@relay/providers`, and `@relay/tools` as **devDependencies** of `packages/engine`, plus tsconfig project references. Engine runtime code still uses type-only imports.
  - Add an ESLint override that turns off `@typescript-eslint/no-restricted-imports` for `packages/engine/src/**/*.test.ts`, `packages/engine/src/testing/**`, and `packages/engine/src/runtime.ts`. `runtime.ts` is the Electron-free composition root (see 06 F16) and **may** value-import storage, providers, tools, and templates.
  - The barrel `index.ts` must not export `src/testing/**`.
- **R2-4.** `.gitignore` negations:
  ```
  !tests/fixtures/sample-api/.env
  !tests/fixtures/sample-api/node_modules/
  !tests/fixtures/sample-api/dist/
  !tests/fixtures/databases/*.sqlite
  !docs/demo/snapshot/**
  ```
  Note that the fixture `.env` holds only an obviously fake marker.
- **R2-30 / R4-17 Vitest.**
  - Replace `vitest.workspace.ts` with root `vitest.config.ts` using `test.projects` (the workspace file was removed in Vitest 4).
  - Each project gets top-level `resolve: { conditions: ['development'] }`, which is **not** placed inside `test`. This applies to all projects: unit, unit-web, integration, and live.
  - Update the ownership list and 00 references (A owns `vitest.config.ts`).
- **R2-31.**
  - Add `tests/fixtures/**` and `plans/**` to the ESLint `ignores`.
  - `tests/tsconfig.json` excludes `fixtures/**`.
  - Add `scripts/tsconfig.json` and `tsconfig.tools.json` (covering `playwright.config.ts`), both referenced from the root `tsconfig.json`.
- **R2-34.** A creates `tests/package.json` and `tests/tsconfig.json`, and they are in A's file list.
- **R2-36.** Add a `gen:api-doc` script to `packages/contracts/package.json`. A CI step (A8) runs it and writes `docs/architecture/ipc-api.md`.
- **R2-37.**
  - Fix `test:unit` inline to `vitest run --project unit --project unit-web`.
  - `e2e` = `pnpm build && PLAYWRIGHT_HTML_OPEN=never playwright test`.
  - Add a `test:e2e` alias (R3-35).
  - Add `eslint-plugin-playwright` with the `playwright/no-wait-for-timeout` rule for `tests/e2e/**`.
  - Add the desktop `dev:renderer` script: `vite --config vite.renderer.config.ts`, a renderer-only config owned by H and listed in 08 files.
  - Desktop scripts: `dev`, `dev:renderer`, `build`, `package`.
- **R4-18.** The `tests` package devDeps include `tsx`. Document that forked children and workers use `execArgv: ['--import','tsx','--conditions=development']`.
- **R4-13.** Root devDependencies: none change. Note in A3 that `electron` is a devDependency of `apps/desktop` and that the root keeps no electron.

## 02-contracts-api-layer.md
Some R3 items were already applied: pause reasons, retryPolicy/memoryScope/allowedTools, RecoveryDecision raise_limits/acknowledge_overrun, projects.export, ledger.export, memory DTOs, providerOptions, getInfo.providerMode, and settings retention/setup allowance. Verify them and keep them consistent with the items below.
- **R2-1 / R4-23 Internal ops.** **Replace** the "Internal operations" paragraph with a separate `src/ipc/internal.ts` exporting `INTERNAL_RUNNER_OPS` (never merged into `OPERATIONS`, so it is never in the preload allowlist or registered with `ipcMain`):
  - `providers.recordCredentialRef {providerId, storageMode, vaultFile|null, redactedLabel}`
  - `providers.deleteCredentialRef {providerId}`
  - `providers.listCredentialRefs {}`
  - `projects.createFromRoot {idempotencyKey, rootRealpath, rootDisplayPath, name, exclusions, allowedProviderIds, monthlyAllowanceMicrousd|null, isDemo}`
  - `projects.previewRoot {rootRealpath} | {projectId}` + `{extraExclusions}`
  - `artifacts.importDiffText {projectId, text, fileName}`
  - `artifacts.exportTo {runId, what, destinationRealpath}`
  - `projects.exportTo {projectId, runIds?, destinationRealpath}`
  - `ledger.exportTo {…, destinationRealpath}`

  Also define:
  - `type RunnerChannel = RunnerRoutedChannel | InternalChannel`, with `RunnerInputOf<C>` and `RunnerOutputOf<C>`.
  - `providers.connect` / `providers.disconnect` route → `main+runner`.
  - A catalog test asserting that no internal channel appears in `OPERATIONS`.
  - Remove the `exposure` field idea.
- **R2-7 Primitives.** Add `src/primitives.ts`:
  - `epochMsSchema`
  - `sha256Schema` (`/^[a-f0-9]{64}$/`)
  - `relPathSchema` (POSIX, no `..` segment, no leading `/`, no NUL, ≤ 512 chars; E's `RelPath` brand reuses it)
  - `stepKeySchema` (`/^[a-z][a-z0-9_-]{0,31}$/`)

  Add enum schemas for every B2 array: `providerIdSchema = z.enum(['anthropic','openai','fake'])`, `roleSchema`, `runStatusSchema`, `pauseReasonSchema`, `stepStateSchema`, `attemptStateSchema`, `memoryTypeSchema`, `memoryStatusSchema`, `costCertaintySchema`, `errorCodeSchema`, `nextActionSchema` (list the values), `runActionSchema`.

  Add `src/domain/views.ts`:
  - `StepView` (id, stepKey, revisionIndex, retryIndex, state, profileName, providerId, modelId, outcome, outputArtifactId, error)
  - `AttemptView` (id, seq, purpose, state, providerId, modelId, usage, cost + certainty, providerLatencyMs, appElapsedMs, providerRequestId, startedAt, finishedAt)
  - `ApprovalView` (id, planHash, contextHash, fileScope, providers, planArtifactId, decision, createdAt)
  - `StepDetail` (step + output: discriminated union over output schemas + manifest + attempts + events)
  - `FileEntry`, `ExclusionReason` (list the E2 reason codes), `CatalogModel`, `ValidationIssue {path, message, code}`, `CapabilityWarning`, `LedgerEntryView`, `WorkflowVersionView`, `WorkflowDraftPatch`, `ModelProfileInput`, `MemoryRef`, `ArtifactMeta`, `AppSettings`, and the `RecoveryDecision` schema.

  Also: `workflowLimitsSchema = runLimitsSchema.partial()`. Name the step id alias `StepRunId` (prefix `stp`). Add a one-alias-per-prefix table.
- **R2-8.** `balancesSchema {L,C,R,U}` and `budgetBreakdownSchema` live in `domain/ledger.ts`. The engine imports them.
- **R2-9.** Move the step **output schemas** into contracts: `src/outputs/{common,findings.v1,plan.v1,patch.v1,review.v1,report.v1}.ts`. Use the field lists currently in 07 §G6, and add `report.v1` (R3-14). Move `contextManifestSchema` into `src/domain/manifest.ts`, with the fields from 07 §G4. Templates re-export the output schemas and add the strict JSON-schema conversion.
- **R2-10 / R2-11.** Define in `domain/catalog.ts`:
  - `modelCapabilitiesSchema` (all fields from 04 D1)
  - `modelPricesSchema {input, output, cacheRead, cacheWrite}` (integer µUSD per MTok)
  - `catalogEntrySchema`

  `profileSnapshotSchema` adds `prices: modelPricesSchema`.
- **R2-14 RUN_ACTIONS.** `['pause','cancel','stop','resume','approve','request_revision','reject','increase_allowance','edit_project_allowance','choose_profile','retry_step','raise_limits','acknowledge_overrun','reconnect_provider','resnapshot_and_replan','use_preserved_snapshot','decide_unknown','review_recovery','export_report','export_patch']`. Document the mapping from action to IPC op (for example, `stop` → `runs.cancel`, `edit_project_allowance` → `projects.update`).
- **R2-25.** The runner protocol `credential.request` becomes `{id, providerId, purpose: 'dispatch'|'estimate'|'connection_test', attemptId: AttemptId|null}`.
- **R2-26.** `RunStartInput` adds `profileOverrides?: Record<StepKey, ProfileId>`. `memoryRecordIds` means "include these approved records (pinned rules are always included)".
- **R2-27.** `memory.resolveConflict` accepts `recordIds` where **one may be a suggestion**. "Combine" = `{rewrite}` over (suggestion, approved). Also add `pinned?` (already added to create/update).
- **R2-24.** `app.getInfo` also returns `fakeScenario: string|null`.
- **R4-6.** `ARTIFACT_KINDS` adds `'input_file'`.
- **R4-24.** Redaction: prefix every `sk-` pattern with `(?<![A-Za-z0-9])`. Add patterns for `sk-ant-(api|admin)\d\d-`, `sk-proj-`, and `sk-svcacct-`. Add a test that `risk-assessment-module-x` is **not** redacted. Document that validated output artifacts are never redacted.
- **R4-35.** Unify naming. Engine-internal `Result<T>` uses `{ok, value}`. IPC and runner results use `IpcResult<C> = {ok:true,data,meta?}|{ok:false,error}`. Runner handlers return `IpcResult`, and there is a helper `toIpc(result)`.
- **R3-7.** Add `SETUP_ALLOWANCE_MICROUSD` (already in B9). Add `providers.test` error `BUDGET_BLOCKED`.
- **R3-22.** None for 02.

## 03-storage-db-layer.md
Some R3 items were already applied: provider_options_json, capabilities_snapshot_json, execution_ms_used/running_since/pause_requested, input_artifact_ids_json, rate_limit_waits_used, purged_at, provider_changed, run_config_revisions, C8 retention. Verify them against the items below.
- **R2-12 / R4-22.** Keep the `pause_requested` column (0/1) plus `RunRepo.setPauseRequested`. Add `step_runs.not_before_at INTEGER` (backoff), which `nextEligible` filters (`not_before_at IS NULL OR not_before_at <= now`).
- **R4-4.**
  - `LedgerRepo.projectMonthBalances(projectId, monthStart, monthEnd)` returns `C` = settled entries with created_at in [start, end), and `R`, `U` = project-wide outstanding amounts with **no date filter**.
  - Add `CHECK (scope <> 'run' OR project_id IS NOT NULL)`.
  - Add `setupBalances(monthStart, monthEnd)` for `scope='setup'` (R3-7).
- **R4-5.** Change the unique index to `UNIQUE(attempt_id, kind, sha256) WHERE attempt_id IS NOT NULL`. `ArtifactRepo.insertIfAbsent` keys on those three.
- **R4-6.** The `artifacts.kind` CHECK adds `'input_file'`.
- **R4-10 Lease.** `acquire` succeeds when there is no row, **or** the owner pid is dead (`isPidAlive` false; EPERM counts as alive), **or** the heartbeat is stale (> staleAfterMs), regardless of pid. Tests: "fresh heartbeat + dead pid → acquired", "stale + alive pid → acquired (single-instance lock is primary guard)".
- **R4-20.** `step_runs` adds `retry_index INTEGER NOT NULL DEFAULT 0`. The unique key becomes `(run_id, step_key, revision_index, retry_index)`. A user retry of a failed step inserts a new row. `StepRepo.latestFor(runId, stepKey)` returns the max `(revision_index, retry_index)`.
- **R4-30.**
  - Replace the `LIKE` id CHECK with `substr(id,1,4)='prj_'`, or drop it; be consistent (drop it: ids are validated by Zod).
  - Drop `WITHOUT ROWID` from `idempotency_keys` and `run_memory_snapshot`.
  - `idempotency_keys.result_json` stores a **small** result (ids plus status), not a full DTO.
  - `pause_reason` CHECK: `(status='paused') = (pause_reason IS NOT NULL)`, and the value must be in the list.
  - Keyset pagination: both `created_desc` and `created_asc` variants.
- **R4-31.** The purge relies on `purged_at`, and readers return `{purged:true}` (already applied). Also mention that the chmod happens inside `ArtifactStore.purge` (05).
- **R4-32.**
  - The node:sqlite option is `readOnly`.
  - Guard ROLLBACK with `db.isTransaction`, and verify that it exists in Node 24.x.
  - Verify `trusted_schema=OFF` works with the `json_valid` CHECKs in the migrate test.
  - **Migrations are embedded** as plain TS modules: `packages/storage/migrations/0001_init.ts` exports `export const sql = \`…\``, and `migrations/index.ts` exports `MIGRATIONS = [{ version, name, sql }]`. This works identically in Node, tsx, and Vite bundles. Checksums are sha256 of the `sql` string. Drop the `migrationsDir` option.
  - Day-1 M1 spike: verify that `node:sqlite` loads inside an Electron 44 utilityProcess.
- **R4-33.** The UoW immediate-mode test asserts `SQLITE_BUSY` from a second connection with `busy_timeout=50` (single thread).
- **R3-12.** `ProfileRepo.upsert` writes capabilities_snapshot_json and catalog_version.
- **R3-13.** `ConfigRevisionRepo` (already applied).
- **R2-22.** `make-fixture-db.ts` is K-owned (`tests/helpers/`). Update any mention.

## 04-providers.md
- **R2-3.** `ModelRequest.metadata = { attemptId; runId; stepKey: string; purpose: AttemptPurpose }`. Real adapters send only the ids (OpenAI `metadata`). Export `FakeCall = { at, runId, attemptId, stepKey, purpose, providerId, modelId, systemSha256 }`.
- **R2-10 / R2-11.** Import `ProviderId`, `ModelCapabilities`, `ModelPrices`, and `CatalogEntry` from `@relay/contracts` (remove the local definitions).
- **R2-17 / R4-36 Fake provider.**
  - `FakeScriptStep` adds `reconcile?: ('completed'|'failed'|'in_progress'|'not_found')[]`.
  - The fake always calls `hooks.onResponseId({providerResponseId: 'fake_resp_<attemptId>'})`.
  - Add `createFakeProvider({…, capabilityOverrides?})`. Scenarios that exercise reconcile set `supportsRequestLookup: true`.
  - New scenarios: `crash-after-dispatch-plan`, `reconcile-completed`, `reconcile-slow`, `malformed-twice`, `server-error-twice`, `rate-limit-exhausted`, `refused`, `midstream-error`.
  - `crash_process_after_dispatch` appends the call-log line with `appendFileSync` **before** calling an injected `exit` (default `process.exit`). `fake.test.ts` injects a spy.
- **R2-18.**
  - `createProviderRegistry({ mode, fakeScenario?, clock, callLog?, fakeCapabilityOverrides? })`.
  - Export `createJsonlCallLog(filePath)`.
- **R2-20 / R2-21.**
  - The catalog JSON is loaded via static JSON import (`import catalog from '../catalog/2026-09-25.json' with { type: 'json' }`), exported as `loadCatalogEntries()`. There are **no runtime fs reads**.
  - Fake success fixtures live in D-owned `packages/providers/src/fake-fixtures/*.json`, also statically imported. Their patches apply to `tests/fixtures/sample-api` (K1). The `fixtures.int.test.ts` in K verifies this.
  - Recorded SSE streams move to D-owned `packages/providers/src/__fixtures__/{anthropic,openai}/*.sse`, including `*-midstream-error.sse`.
- **R2-19.** Remove "seedCatalog(db)" from D. D exports only `loadCatalogEntries()`, and F16 seeds.
- **R3-4.** Add D9b `tests/live/workflow.live.test.ts`. It runs the full template once per adapter via `createRuntime` (06 F16) on sample-api, auto-approving through the service API, capped by `RELAY_LIVE_WORKFLOW_CAP_MICROUSD` (default 1_500_000).
- **R3-37.** Every non-fake catalog entry needs an official `https://` pricing URL + retrieval date. The Anthropic entries must cite the official pricing page (retrieved at D2 time). `catalog.test.ts` asserts `source` starts with `https://`.
- **R4-7 phase detection.** `trackedFetch(baseFetch)` wraps an **injected** base fetch, not `globalThis` captured at load. `phase='not_sent'` until invoked. If fetch rejects, inspect `err.cause?.code`:
  - `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, `CERT_*`, `ERR_TLS_*`, `EHOSTUNREACH`, `ENETUNREACH` → `not_sent`.
  - Anything else → `sent_no_response`.

  Store the cause code on the error. Capture `request-id` / `x-request-id` from the Response headers inside `trackedFetch`, which is preferred over `_request_id`.
- **R3-6 / R4-8 mid-stream.**
  - Any failure after `firstByteAt`, including an SSE `error` event (`overloaded_error`, `api_error`) and a connection drop mid-stream, maps to `REQUEST_OUTCOME_UNKNOWN`, phase `responded_partial`. Add this phase to `DispatchPhase`. Include `providerResponseId` when it is known.
  - It is never mapped to `PROVIDER_UNAVAILABLE`.
  - Check `status === 529` → `RATE_LIMITED` **before** the `InternalServerError` branch.
  - A 5xx **before any byte of body** → `PROVIDER_UNAVAILABLE` (transport retry allowed).
- **R4-12 estimate.** The signature becomes `estimate(req, prices, ctx?: { apiKey?: string; signal?: AbortSignal })`. With an apiKey and `supportsTokenCounting`, use the provider count. Otherwise use the local estimate. F4 resolves the credential **before** estimating.
- **R4-27.** Wrap all hook invocations in try/catch (log, never throw into the SDK stream). `setProviderIds` semantics are defined in 03, using COALESCE per column.

## 05-tools-fs-artifacts.md
- **R2-7.** `RelPath` reuses contracts `relPathSchema`.
- **R3-8.** E7 adds `writeExportFile(destinationRealpath, name, bytes)`, which is used by `projects.exportTo` / `ledger.exportTo`. The same inside-project refusal applies.
- **R3-30 / R4-31.** Add `ArtifactStore.purge(relPath)`: chmod 0o644, unlink, and return `{purgedAt}`. `read` of a purged artifact returns a `NOT_FOUND` with `details.purged=true`.
- **R4-6.** Add `snapshotInputFiles(runId, files)`. Intake stores each input file's bytes as an `input_file` artifact (content-addressed, deduped by sha within the run), and `readSnapshot(artifactId)` reads it back. G1 and F8 read the snapshot content, **not** the live disk. The live disk is used only for stale-hash comparison.
- **R4-35.**
  - `pickDirectory` validation is main-side (08).
  - E7's inside-project check also refuses destinations **containing** a project root.
  - Temp dirs under `os.tmpdir()` are valid project roots (E2E uses them).

## 06-engine-core.md
- **R2-6 F16 runtime.** Add F16 `src/runtime.ts`: `createRuntime({ userDataDir, providerMode, fakeScenario?, credentials, hooks?, callLog?, clock?, fakeCapabilityOverrides? }) → { engine, db, dispose }`. It is Electron-free: `openDb` (embedded migrations) → `seedDatabase` → provider registry → artifact store → projectFs → context/memory → `createEngine`. H's runner entry, K's crash child, and M's scripts all import it from `@relay/engine`. It is the only engine file that value-imports storage, providers, and tools (lint exception in 01).
- **R2-19.** Add `src/seed.ts`: `seedDatabase(db, { catalog: loadCatalogEntries(), templates: templateRegistry })`, idempotent. It seeds the catalog, templates (workflow v1 validated with prompts), and default profiles (Economy/Balanced/Capable) with capability snapshots.
- **R2-8.** Import `Balances` and `BudgetBreakdown` from contracts.
- **R2-13.** F15 inserts synthetic `intake` (ordinal 0) and `finalize` (last ordinal) step rows around the spec steps. F13 derives the handler kind from `step_key` for these two, and from the spec otherwise.
- **R2-14 / R2-15 / R2-16 / R3-10 / R4-21.** Rewrite the `allowedRunActions` table and events:
  - `paused(budget_run)` → increase_allowance, choose_profile, stop. `runs.increaseAllowance` **auto-emits RESUME_RESOLVED** when admission for the next step would now pass.
  - `paused(budget_project)` → edit_project_allowance, choose_profile, stop. `projects.update` re-evaluates paused runs of that project.
  - `paused(budget_overrun)` → acknowledge_overrun, increase_allowance, stop.
  - `paused(limit_attempts | deadline)` → raise_limits, stop.
  - `paused(output_invalid | provider_unavailable | model_refused | setup_blocked)` → retry_step, choose_profile, stop.
  - `paused(unknown_outcome)` → decide_unknown, stop.
  - `paused(auth_required)` → reconnect_provider, resume, stop.
  - `paused(user | rate_limited)` → resume, stop.
  - `paused(approval_stale)` → resnapshot_and_replan, use_preserved_snapshot, stop.
  - `interrupted` → review_recovery, decide_unknown (if any), stop.

  Add events `LIMIT_REACHED {reason}`, `OUTPUT_INVALID_EXHAUSTED`, `TRANSPORT_EXHAUSTED`, `MODEL_REFUSED`, and `BUDGET_OVERRUN`, each `running → paused(<reason>)`. `runs.retryStep`, `raise_limits`, and `acknowledge_overrun` on a paused run → `RESUME_RESOLVED` (paused → queued). Rename the engine's state-machine event type to `RunMachineEvent` (R2-39).
- **R3-1.** Exhausted schema-repair or transport retries → the **step** goes to `failed`, and the **run** goes to `paused(output_invalid | provider_unavailable)`, not failed. Run status `failed` is only for `UNRECOVERABLE` (invariant violations or internal errors). `runs.retryStep` inserts a new step row (`retry_index + 1`) with fresh retry counters (R4-20).
- **R3-2.** Overrun (X > N) → after settlement, emit `BUDGET_OVERRUN` → `paused(budget_overrun)` **regardless of L**. It resumes only on `acknowledge_overrun` or `increase_allowance` (§9.5).
- **R3-5.** Deadline = `execution_ms_used` (accrued only while `running`, via `enterRunning`/`leaveRunning`) + the current segment ≥ `executionTimeoutSeconds×1000`. The timer arms per running segment. Waiting for approval does not count. `raise_limits` extends it.
- **R3-6 / R4-8.** A transport retry is allowed only when phase ∈ {`not_sent`} or (5xx before any body byte). `responded_partial` / `sent_no_response` → unknown.
- **R3-7.** Add `src/setup-calls.ts` (the `providers.test` handler):
  1. `admitSetup` (C+R+U+N ≤ setup allowance over `scope='setup'` entries for the month).
  2. Reserve.
  3. Call `testConnection`.
  4. Settle or move to unknown, with `attempt_id NULL` and `certainty` set.
  5. Return `BUDGET_BLOCKED` when over.
- **R3-9.** Retry limits are read from the step snapshot's `retryPolicy`, and memory filtering uses `memoryScope`.
- **R3-11.** Approval creation records `requested_permissions_json = { providers: [providerIds of implement/verify snapshot], tools: [] }`. F6 check 8 also requires the current step's effective provider ∈ approval providers, else `APPROVAL_STALE` (`invalidated_reason: provider_changed`).
- **R3-13.** `retryStep` with `profileId` / `switch_profile` validates that the profile is permitted, then appends `run_config_revisions` and emits `run.config_revised`. The effective profile = the latest revision.
- **R3-14.** Add F17 `src/report.ts`: generate a `report.v1` artifact (+ a Markdown renderer for export) on **every** terminal transition (completed, incomplete, cancelled, failed).
- **R3-16.** Retention sweep scheduling calls the storage `sweepRawResponses` at boot and daily.
- **R3-17.** Finalize writes one `run_summary` memory record (approved, author `run:<id>`, never mandatory) through G's `MemoryServicePort.recordRunSummary`.
- **R3-22.** List **every** added §7.2 edge as a clarification in the F2 table notes. Update the review checklist wording.
- **R3-27 / R2-28.** `engine.test.ts`: 4 model attempts.
- **R3-28.** Add `profiles.test.ts`: an invalid model id or unsupported effort → `MODEL_UNSUPPORTED`.
- **R3-29.** Re-check `attempt_count < maxAttempts` inside the step-2 tx.
- **R4-1 / R4-2 / R4-26 Checkpoint rewrite (F4).**
  - Resolve the credential **before** the estimate and before any attempt row. A missing key never creates a `dispatching` row.
  - The step-2 tx re-reads the run and requires `status==='running' && !pause_requested`. It computes `seq` and `request_fingerprint` in the tx and inserts the attempt with all NOT NULL columns.
  - Register the AbortController **before** the step-3 tx, and check `signal.aborted` immediately before `generate`.
  - Steps 4–7 go inside `try/finally` (clear the deadline, unregister). If `generate` throws unexpectedly → the attempt moves to unknown (never left `dispatching`).
  - The step-7 tx **always** commits the ledger moves and the attempt's final state. The step transition is conditional: if the step is no longer `executing` (for example, it was cancelled), record only on the attempt.
  - Step skipping on cancel happens in the WORK_STOPPED handler **after** settlement.
  - Use `admitted.attemptId` and `estimate.upperAllowanceMicrousd` (scoping).
  - `buildModelRequest` fills `metadata.stepKey` and `metadata.purpose`.
- **R4-3 Recovery.** Recovery **always** moves every `dispatching` attempt → `unknown` with `move_to_unknown N`. F9b operates only on `unknown` attempts that have a response id and whose adapter supports lookup:
  - `completed` → `resolve_unknown −N` + settle actual.
  - `failed` with usage → `resolve_unknown −N` + settle usage.
  - `failed` without usage → `resolve_unknown −N` + `settle` 0 with certainty `calculated`.
  - `not_found` / `in_progress` → remains unknown.
- **R4-5.** Step 5 `put`s **both** the raw response (text/plain if not valid JSON, else application/json; redacted) and the canonical validated output JSON (not redacted), plus the per-attempt `context_manifest`, before the step-7 tx. The rows are keyed `(attempt, kind, sha)`.
- **R4-6.** Intake snapshots input file bytes as `input_file` artifacts (05). F8 patch validation applies diffs to the **snapshot** content, and `validateOutput` receives pre-loaded contents.
- **R4-9.** An abort after dispatch → `move_to_unknown` of the full N (the observed partial usage is informational only, stored in `usage_json` with `partial: true`).
- **R4-11 / R2-23 crash hooks.** The grammar is `RELAY_CRASH_AT=<hook>@<stepKey>[#<n>]` (n = the nth matching attempt, default 1). Hooks receive `{ attemptId?, stepKey, purpose, attemptSeq }`. All 5 hooks are invoked at named call sites:
  - `beforeReservationTx`: F4 before step 2.
  - `afterDispatchIntent`: after step 3.
  - `afterProviderResponse`: after generate.
  - `afterStepCommit`: after step 7.
  - `afterApprovalCommit`: in `approvals.decide` after commit.

  The hooks are active only when `RELAY_E2E=1`. The parser lives in `src/testing/crash-hooks.ts` and is exported for H and K.
- **R4-20.** A failed step can be retried via a new step row (`retry_index`). `nextEligibleStep` and `dependsOn` resolve to the latest `(revision_index, retry_index)` per step_key.
- **R4-22.** Backoff sets `step_runs.not_before_at`, and the loop skips steps that are not yet eligible (sleeping until the earliest `not_before_at`). `rate_limit_waits_used` persists.
- **R4-25.** `validating` is in-memory only. F3 allows `executing → succeeded | ready | failed | unknown` directly inside the step-7 tx. Document this. F9 treats a `reserved` step like `ready` (after release).
- **R4-28.** On `retry_acknowledging_charge`, the old attempt → `abandoned` (liability kept) so it no longer prompts.
- **R4-29.** F15 resolves capabilities **before** the tx. The `approvals.decide` idempotency lookup happens before `hashFiles`, and the store happens in the decide tx. Document the concurrent-duplicate `CONFLICT` behavior.
- **R2-39.** Rename `RunEvent` → `RunMachineEvent`.
- **R2-35.** F1: `index.ts` re-exports `createContextAssembler`, `createMemoryService`, `createRuntime`, `seedDatabase`, and the crash-hook parser.
- **R4-36.** Fake timers apply only to the injected `deps.timers` and clock, never globally, in harness tests.

## 07-engine-context-memory-templates.md
- **R2-9.** The output schemas and `contextManifestSchema` now live in **contracts** (02). G6 keeps the prompts, `workflow.json`, `TemplateRegistry`, `toStrictJsonSchema`, and re-exports. G4 builds manifest instances using the contracts schema. Update the file tree and tests accordingly.
- **R2-20.** Prompts are `.ts` modules (`prompts/reviewer.v1.ts` exporting `export const prompt = \`…\``), and `workflow.json` is loaded via a JSON import with `with { type: 'json' }`. There are no runtime fs reads. (`?raw` is Vite-only and would break Node, tsx, and the Vitest runs.)
- **R2-19.** `TemplateRegistry.seedVersions()` returns the data that F16 `seedDatabase` inserts.
- **R2-26.** `snapshotForRun(runId, projectId, { includeIds?: MemoryId[] })`. Pinned rules are always included.
- **R2-27.** The G5 conflict table adds the row "suggested + approved → resolveConflict (rewrite/keep)".
- **R3-9.** G1 step 3 filters by the step's `memoryScope` (roles, types).
- **R3-14.** The `report.v1` schema is defined in contracts (02). G supplies the `limitations` text constants used by F17.
- **R3-17.** G5 adds `recordRunSummary(runId)`, which creates an approved `run_summary` record (author `run:<id>`). `source_reference` creation happens via `memory.create` (02).
- **R3-19.** None for 07.
- **R4-6.** G1 step 4 reads file content from the `input_file` snapshot artifacts. The live disk is used only for the stale check (`PROJECT_CHANGED`), and `use_preserved_snapshot` skips the stale check for that run.
- **Stub for Wave 1 (00 §3).** The initial `context.ts` implements steps 1, 2, 4, 6, and 8 only. It is completed in Wave 3.

## 08-desktop-host.md
- **R2-1.** The composite handlers call `INTERNAL_RUNNER_OPS` channels (`projects.createFromRoot`, `projects.previewRoot`, `artifacts.importDiffText`, `artifacts.exportTo`, `projects.exportTo`, `ledger.exportTo`, `providers.recordCredentialRef`/`deleteCredentialRef`). `supervisor.request` is typed on `RunnerChannel`.
- **R2-6.** H7 `compose.ts` becomes a thin wrapper around `createRuntime` from `@relay/engine`. Remove `seedCatalog`/`seedTemplates` calls (F16 does it).
- **R2-18.** In fake mode, compose passes `fakeScenario: env.RELAY_FAKE_SCENARIO` and `callLog: createJsonlCallLog(join(userData,'fake-call-log.jsonl'))`.
- **R2-23 / R4-11.** Parse `RELAY_CRASH_AT` with F's exported parser, only when `RELAY_E2E==='1'`.
- **R2-29.** The bundled sample and the `samples/` copy exclude `.env` (electron-builder `extraResources` filter `["**/*", "!.env"]`, and the copy skips `.env`).
- **R2-40.** Specify the dialog seam, installed only when `RELAY_E2E=1`: `globalThis.__relayDialogs = { setStub({directory?, diffFile?, exportDir?}), clear() }`.
- **R3-31.** Log lines include `outcome`.
- **R4-13 Build.**
  - Set electron-vite `build.externalizeDeps: false` for main, preload, and runner (bundle everything). Only `electron` is external, and `node:sqlite` stays a runtime import (a gate check greps the runner bundle for `node:sqlite`).
  - The preload is bundled as CJS so it has no runtime `require` of workspace packages.
  - electron-builder `files` stays `out/**`, because everything is bundled.
- **R4-14.** Call `port.start()` on both ends. Drain child `stdout`/`stderr` into the log. Add a supervisor test that fails without `start()`.
- **R4-15 Boot order.**
  1. userData override.
  2. `requestSingleInstanceLock()`.
  3. `whenReady`.
  4. Register IPC **before** creating the window.
  5. A failed `supervisor.start()` still shows the window, with a diagnostics banner.
  6. `before-quit`: `e.preventDefault()` → `await supervisor.shutdown()` → `app.quit()` (guarded against re-entry).

  DevTools never auto-open when `RELAY_E2E=1`.
- **R4-16 / R2-38 CSP.** Add `vite-plugin-csp.ts` (H-owned, in `apps/desktop/build/`) via `transformIndexHtml`. In dev it allows the React-Refresh preamble hash and `ws://localhost:*` / `http://localhost:*`. Prod is strict. `onHeadersReceived` applies only to the dev server, and prod relies on the meta tag. Note that `frame-ancestors` is ignored in meta.
- **R4-32.** Migrations are embedded (03), so remove the migrations copy step. The gate now asserts the runner bundle contains `CREATE TABLE runs`.
- **R4-34.**
  - `minimalEnv` always sets `RELAY_USER_DATA_DIR=app.getPath('userData')`, plus `HOME` and `TMPDIR`.
  - Use **one** runner build mechanism: the `?modulePath` import. The gate path becomes `out/main/*runner*.js`.
  - The heartbeat staleness applies only after `ready`. Startup uses a separate 60 s timeout.
  - Packaging on arm64: use ad-hoc signing (`identity: '-'`, or verify the electron-builder equivalent). Add a verify task.
  - Verify the `safeStorage` async API names in Electron 44 at H5 start, with a fallback to sync `encryptString` if the async variant is absent.
- **R4-35 Security.**
  - `assertTrustedSender` rejects a null `senderFrame`. In prod the frame URL must equal the exact `file://…/out/renderer/index.html`. The dev URL is allowed only when `!app.isPackaged`.
  - `projects.create` consumes (deletes) the selection token.
  - `pickDirectory` also rejects roots that **contain** userData, the home dir itself, and `/`, `/System`, `/Library`, `/usr`, `/bin`, `/etc`. It allows `os.tmpdir()` subdirs.
- **R3-8 / R3-15.** Add composite handlers for `projects.export` and `ledger.export`, each using a save dialog → the internal `*.exportTo`.
- **Files.** Add `apps/desktop/vite.renderer.config.ts` (the dev:renderer config) and `apps/desktop/build/**` to H's ownership (00 §2 is updated by the orchestrator).

## 09-design-system.md
- **R3-23.** Add `statusPresentation` rows for the new pause reasons (`output_invalid`, `provider_unavailable`, `budget_overrun`, `model_refused`, `limit_attempts`, `deadline`, `user`, `rate_limited`, `setup_blocked`) and for run `failed`/`cancelled`/`interrupted`.
- **R3-32.** `RunInspector` layout support: below 1280 px the bottom row (ledger + context) collapses into the step-panel tabs. Add a `ResponsivePanels` component.
- **R3-19.** Add a `CatalogTable` domain component (model, capabilities ✓/✗ with text, prices, catalog version, source link as text, effective date).
- **R2-9.** Components that render outputs (`PatchView`/`DiffViewer`, `ApprovalCard plan`, `ContextManifestView`) import their types from **contracts** (outputs/manifest).

## 10-renderer-pages.md
- **R3-10 / R2-14.** The J8 banners cover every `pauseReason` in the 06 `allowedRunActions` table, with actions mapped via the 02 action→op table (for example, `edit_project_allowance` → `projects.update` dialog, `raise_limits` → a dialog with the maxAttempts/timeout inputs bounded by `RUN_LIMIT_MAXIMUMS`, `acknowledge_overrun`).
- **R3-15.**
  - The Overview "Budget values link to the ledger" link → `/p/:id/runs/:runId?tab=ledger`. Add a Ledger tab in the inspector showing entries plus an "Export ledger (CSV)" button.
  - The Overview tracked-usage tile links to the latest run's ledger, and there is a project-month export in Settings → Data.
- **R3-19.**
  - The memory detail shows type, supersededById link, reviewAt, and pinned.
  - Settings → Providers adds a Models table (`CatalogTable`) with per-profile capability check results.
  - Settings → Projects adds the OpenAI `storeResponses` toggle (R3-25).
- **R3-8.** Settings → Data adds "Export project (JSON)" (`projects.export`), a retention days input (`rawResponseRetentionDays`), and the setup allowance input.
- **R3-23.** The J5 matrix adds rows for the inspector states `interrupted`, `paused-user`, `paused-limit` (attempts/deadline), `rate-limited`, `refused`, `output-invalid`, `provider-unavailable`, `budget-overrun`, `failed`, `cancelled`, plus a report state `incomplete-report`. The mock agent adds matching mock states with these exact names.
- **R3-32.** Narrow widths collapse the secondary panels into tabs (J8).
- **R2-26.** The New-run per-step profile override → `profileOverrides`. The memory checkboxes → `memoryRecordIds`.
- **R2-27.** Combine = `memory.resolveConflict({ recordIds:[suggestionId, approvedId], resolution:{rewrite} })`.
- **R2-33.** `test-setup.ts` is J-owned (already in the file list).
- **R2-9.** Output viewers import their schema types from contracts.
- **R4-16.** J1: the CSP meta is injected by H's Vite plugin. Do not hand-write the CSP in `index.html`.

## 11-integration-tests.md
- **R2-6 / R4-18.** The crash harness child imports `createRuntime` from `@relay/engine`, forked with `execArgv: ['--import','tsx','--conditions=development']` and env `RELAY_E2E=1`, `RELAY_CRASH_AT=<hook>@<step>[#n]`. The child also loads `no-network`. The same `execArgv` applies to the contention test's workers.
- **R2-4.** State that the fixture files (`.env`, `node_modules`, `dist`) are committed via the gitignore negations. The `link-outside` symlink is created at test time.
- **R2-20 / R2-21.**
  - K1 (sample-api) runs in Wave 0.
  - Remove the SSE files and the fake success fixtures from K2 (now D-owned).
  - K2 keeps only integration variants: `plan.scope-expanded.json`, `patch.outside-scope.json`, `patch.does-not-apply.json`, `findings.bad-ref.json`, and `truncated.json`, which are supplied to the fake via a scenario file override (`createFakeProvider({ extraFixtures })`).
- **R2-22.** `make-fixture-db.ts` moves into `tests/helpers/` (K-owned). `migration.int.test.ts` is tagged `@m4` and runs once the fixture DB exists.
- **R3-1.** `malformed-twice` → `paused(output_invalid)`, both attempts are recorded, and `retryStep` succeeds (new step row).
- **R3-2.** `budget-overrun` sets L well above X, and asserts `paused(budget_overrun)` plus resume after `acknowledge_overrun`.
- **R3-5.** `limits.int.test.ts`: a 20-min approval wait (fake clock) doesn't trigger the deadline. `raise_limits` resumes.
- **R3-8.** Add `project-export.int.test.ts`: bundle contents, no realpath, and the key grep = 0.
- **R3-11.** `approval-binding` adds (e): switching the implement profile to another provider after approval → `APPROVAL_STALE provider_changed`.
- **R3-13.** `run-snapshot` adds: `retryStep` with a new profile creates a `run_config_revisions` row, and historical ledger entries are unchanged.
- **R3-21.** `failure-modes` adds `#transport` (`server-error-twice` → 1 retry then `paused(provider_unavailable)`), `#rate-limit` (waits capped at 60 s, pause after N), `#refused` (→ `paused(model_refused)`, then `retryStep` with another profile), and `#midstream` (→ unknown, no auto retry).
- **R3-7.** `setup-budget.int.test.ts`: `providers.test` blocked when the setup allowance is exhausted.
- **R4-3.** Crash row 4: the adapter `reconcile` path uses a fake scenario with `supportsRequestLookup: true` (capability override). Expected: after the restart the attempt is `unknown` (with `move_to_unknown`), then F9b reconcile → `reconciled_succeeded`, `resolve_unknown`, and settle. U returns to 0.
- **R4-1.** `cancellation`: after cancel during `hang`, R = 0 (the reservation was moved to U), and the attempt is not `dispatching`.
- **R4-5.** `run-happy-path` asserts the output artifacts exist on disk and differ from the raw rows.
- **R4-10.** Crash tests restart immediately (a fresh heartbeat plus a dead pid → acquired).
- **R4-36.**
  - The redaction test's DB dump iterates `sqlite_master` (a custom dump) **and** scans the `-wal` file bytes.
  - Harness fake timers apply only to the injected timers.
- **R2-3.** Call log assertions use the `FakeCall.stepKey`/`purpose` fields. `run-snapshot` reads `modelId` + `systemSha256`.

## 12-e2e-playwright.md
- **R4-19.** `electron.launch({ executablePath: createRequire(path.resolve('apps/desktop/package.json'))('electron'), args: [path.resolve('apps/desktop')], env… })`. The `apps/desktop/package.json` `main` points to `out/main/index.js`.
- **R2-40.** `stubDialogs` uses `__relayDialogs.setStub`. The fixture skips `rm` when `RELAY_E2E_KEEP=1` and writes the path to `test-results/last-userdata.txt`, which 13 reads.
- **R2-23 / R4-11.** `crashAt` values use the grammar `afterStepCommit@plan`.
- **R3-20.**
  - Add `responsiveness.spec.ts @m1`: with fake `delayMs` 5000 on review, navigate Runs/Memory/Settings during the call, and each loads in < 1 s (performance marks).
  - `smoke.spec` records the navigation and history load marks.
  - `run-happy-path` asserts the Attempts tab shows "Provider latency" and "App time" as separate values.
- **R3-28.** `run-happy-path` asserts Reserved > $0 while the review is running. `unknown-outcome.spec` asserts the "est." label after `accept_estimated_charge`.
- **R3-23.** Add `pause-states.spec.ts @m4`, covering output-invalid → retry step, budget-overrun → acknowledge, and limit → raise limits, using the new fake scenarios.
- **R3-32.** `a11y.spec` adds a 1100 px viewport check that the inspector secondary panels become tabs.
- **R3-8.** `run-happy-path` or `memory.spec` adds a project export via Settings → Data (stubbed export dir), and the file exists with no key.

## 13-release-demo-eval.md
- **R2-6.** The evaluation and demo scripts import `createRuntime` from `@relay/engine` (not "K's composeRunner").
- **R2-22.** `make-fixture-db.ts` moves to K (remove it from M, which references `tests/helpers/make-fixture-db.ts`).
- **R2-29.** The secret scan allowlists the literal marker `sk-fixture-DO-NOT-READ` in any path, because the sample `.env` is excluded from bundles anyway. The default scan dir is read from `test-results/last-userdata.txt`.
- **R3-33.** `evidence-table.ts` counts every attempted task run (including incomplete, failed, and cancelled) in the denominator, with a dry-run fixture test.
- **R3-34.** Add `docs/product/m0-status.md`: the M0 checklist items with status, interview count, the funder-confirmed cap (not assumed), and the confirmed OS. It is reviewed at the M1 gate.
- **R4-34.** `verify-package` asserts the ad-hoc signature (`codesign -dv`), and that the catalog and prompts load (via `app.getDiagnostics` in a smoke launch).
