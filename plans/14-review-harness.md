# Plan 14: Review Harness — Gates, Adversarial Audit, Security & Standards Checklists, Review Log (Orchestrator)

Skills applied: **big-plan** (execution loop), **security-review**, **coding-standards**, **bug-audit**, **playwright-cli**.

---

## 1. Execution loop (Ralph loop, per big-plan Phase 5)

```
for plan in topo_order(00-overview §3):          # parallel where the dependency graph allows
  read plan + 00-overview + 00b-standards        # fresh context each iteration
  spawn implementation agent(s) (one per independent task group; ownership per 00 §2)
  loop:
    run GATE(plan)                                # §2 below
    if fail: fix → retry (same agent, same ownership)
  commit "plan-NN: <summary>"
  ADVERSARIAL AUDIT (§3) on `git diff <prev>..HEAD`
  fix Referee-confirmed findings → re-run GATE → commit "plan-NN(fix): R<id>"
  mark plan done in 00-overview §9
final: Phase 6 verification (00 §6) + one whole-repo audit
```

A plan is **done** only when its gate passes **and** the Referee's list is empty or fixed.

## 2. Gates

Core gate (every plan):
```bash
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test:unit
```
Per-plan domain gates are listed in each plan's "Success Criteria". Summary:

| Plan | Extra gate |
|---|---|
| 01 | Boundary probe files fail lint |
| 02 | ≥ 55 operations; 9 internal ops; `gen:api-doc` runs |
| 03 | Schema table list equals C3; triggers tested |
| 04 | `maxRetries: 0` ×2; live smoke ≤ $0.10 (manual, before M2 sign-off) |
| 05 | "symlink escape" test exists and passes; scan perf < 300 ms |
| 06 | No `tx('immediate', async`; `@m2` engine test |
| 07 | Templates + context/memory tests; strict schemas |
| 08 | `pnpm build` outputs; dev smoke with fake provider |
| 09 | Contrast + axe component tests; ui-ux-pro-max checklist |
| 10 | Every fake scenario renders; no fake bridge in prod bundle |
| 11 | `pnpm test:integration`; crash matrix 3× green |
| 12 | `pnpm e2e`; `@a11y` 0 violations; secrets 0 |
| 13 | Package verify; demo reset ×2; evaluate dry-run |

## 3. Adversarial audit (three agents, scoring-based)

Run after each plan commit. Each agent gets: the plan file, 00b standards, the relevant spec sections (listed in the plan header), and `git diff`.

**Bug Hunter prompt** (10 points per confirmed bug):
> You are auditing commit `<sha>` implementing `plans/<NN>.md` for Relay. Find real defects: requirements in the plan not met, spec rules violated (cite §), incorrect state transitions, money arithmetic errors (floats, rounding, double counting), transactions containing awaits, missing validation at trust boundaries, secrets reaching logs/DB/renderer, path confinement bypasses, race conditions, missing tests for listed scenarios, a11y violations (status by color only, missing labels). For each finding, give: id, file:line, the violated rule (plan task id or spec §), a concrete failing input or sequence, and the expected vs actual behavior. Do not report style nits unless they violate 00b gates.

**Defender prompt** (10 points per disproven finding):
> For each Bug Hunter finding, try to prove it is not a bug. Examples: the code path is unreachable, the plan explicitly allows it, a test already covers it and passes, or the spec section doesn't apply. Give evidence (file:line, test name, command output). Concede findings you cannot disprove.

**Referee prompt:**
> Given both reports, output the final list of confirmed bugs. Include only findings where the Hunter's failing scenario stands after the Defender's evidence. For each, give a minimal fix direction and the test that must be added. Output JSON: `[{ id, severity: 'critical'|'major'|'minor', file, line, summary, fix, test }]`.

The orchestrator fixes only the Referee-confirmed items, always with a regression test.

## 4. Security review checklist (security-review skill → Relay), run at 04, 05, 06, 08, and 12 audits

- [ ] **Secrets:** no key in DB business tables, logs, events, artifacts, exports, renderer state, the runner env, or crash reports. `check:secrets` = 0. Keys are read only in `main/credentials.ts`
- [ ] **safeStorage** availability checked. basic_text is treated as unavailable. Plaintext fallback is impossible (code path review + unit test)
- [ ] **Input validation:** Zod on every IPC input, runner protocol message, provider output, imported diff, and DB JSON column
- [ ] **SQL:** parameterized only (grep for template literals containing `SELECT|INSERT|UPDATE|DELETE` with `${` → 0)
- [ ] **Path confinement:** realpath containment, symlink escape test, secrets unreadable, no renderer-supplied paths
- [ ] **XSS:** no `dangerouslySetInnerHTML`. Markdown rendered with `skipHtml`. Links go through `app.openExternal` confirm. CSP: meta CSP in production; response header only in dev
- [ ] **Electron:** `contextIsolation`, `sandbox`, `nodeIntegration: false`, navigation/window-open denied, permission requests denied, IPC sender check, fuses in the packaged build
- [ ] **Prompt injection:** hostile fixture test passes. No model output flows into permissions, limits, approvals, or provider choice
- [ ] **Rate limiting:** paid `providers.test` limited
- [ ] **Dependencies:** `pnpm audit --prod` reviewed. Lockfile committed. Licenses recorded before distribution
- [ ] **Error leakage:** `INTERNAL` returns only a correlationId. No absolute paths in user messages

## 5. Coding-standards checklist (coding-standards skill → 00b), run at every audit
- [ ] No `any`, no `!` outside tests, exhaustive switches
- [ ] Functions ≤ 50 lines and nesting ≤ 3 (reported, not a hard gate; justify exceptions)
- [ ] No magic numbers (limits come from `defaults.ts` with a § comment)
- [ ] Immutability: no mutation of inputs or domain objects
- [ ] Tests follow AAA with descriptive names, and the §17.1 boundaries are covered
- [ ] Comments explain *why* and cite spec sections for policy code

## 6. Performance spot-checks (perf-audit skill, run at the M4 audit)
- [ ] `getInspectorProjection` uses ≤ 6 statements (no N+1)
- [ ] The run-events list and large diffs are virtualized
- [ ] No synchronous provider work in main or the renderer (§3.3). Main never awaits a runner op longer than the timeout
- [ ] Overview and run history load in < 1 s on the fixture (§3.3). Measured via the Playwright `performance.now()` marks in `smoke.spec.ts`

## 7. Plan review rounds log (big-plan Phase 3–4)

Round findings get ids `R<round>-<n>`. Each was fixed in the plan files before execution.

| Id | Round focus | Finding | Fix applied |
|---|---|---|---|
| R1-1 | Data flow | Anthropic `input_tokens` excludes cache tokens while OpenAI `input_tokens` includes them. A naive sum double-counts (§8.4) | 04 §D4/§D5 disjoint `NormalizedUsage` mapping plus `usage.test.ts` fixtures for both |
| R1-2 | Data flow | Provider SDK default `maxRetries: 2` would create hidden HTTP attempts outside the ledger | ADR-013. `maxRetries: 0` gate in 04 |
| R1-3 | Error taxonomy | Provider 5xx or a connection failure before dispatch had no correct §12.6 code. It is neither unknown nor runner-unavailable | Added `PROVIDER_UNAVAILABLE` (02 §B3, 04 §D3) |
| R1-4 | State machine | A live ambiguous result had no run state. `interrupted` is defined for a lost runner (§7.2) | Added pause reason `unknown_outcome` and the `UNKNOWN_OUTCOME` event (02 §B2, 06 §F2/F7) |
| R1-5 | Stack | Forge's Vite plugin is experimental. better-sqlite3 has native ABI friction in Vitest | ADR-011 (electron-vite + electron-builder), ADR-012 (`node:sqlite`) |
| R1-6 | Output | The §9.1 example 4,000 max output tokens is too low for models with always-on thinking, so structured output truncates | `DEFAULT_MAX_OUTPUT_TOKENS` (02 §B9). The reservation still bounds spend |
| R1-7 | Provider | Anthropic has no request-lookup endpoint, so reconciliation is impossible there. OpenAI can reconcile only if the response id is persisted early and `store: true` | 04 §D4/§D5 capabilities. 06 §F9b persists the id from the first stream event |
| R1-8 | §7.2 | Journeys need `paused → cancelled` and `interrupted → cancelled` ("stop with existing artifacts" §4.3) | Added as documented clarifications in 06 §F2 |
| R1-9 | Security | The spec shows raw paths in project creation (`project.create` "selected directory handle") | Selection token pattern (02 §B5, 08 §H3). The renderer never sends paths |
| R1-10 | Honesty | Refusal fallbacks (default guidance in the claude-api skill) would silently switch models, which conflicts with §6.3/§8.4 | ADR-016: off by default, opt-in per profile, recorded in the snapshot, priced per served model |

### Rounds 2–4 (2026-09-30)

Three parallel read-only reviewers found 113 issues:
- **R2**, cross-plan consistency: 40 findings.
- **R3**, spec coverage: 37 findings.
- **R4**, technical correctness: 36 findings.

The full finding list and the **binding decision for each** are in [`reviews/rounds-2-4-decisions.md`](reviews/rounds-2-4-decisions.md). Fix agents applied them in place, each owning distinct plan files. The decisions with the largest effect:

| Id | Severity | Finding | Decision |
|---|---|---|---|
| R2-1 / R4-23 | critical | The runner needs internal ops (credential refs, realpath-based project creation, dialog-chosen export paths) that must never reach the renderer | Separate `INTERNAL_RUNNER_OPS` catalog, excluded from the preload allowlist and `ipcMain` |
| R2-2 | critical | Engine tests value-import storage and providers, which breaks the lint boundary. Engine deps are missing under the isolated linker | Engine devDependencies + lint exception for tests and `runtime.ts` |
| R2-3 | critical | The fake provider couldn't see which step it served, so the call-log assertions were impossible | `metadata.stepKey/purpose` + `FakeCall` |
| R2-4 | critical | Fixture `.env`, `node_modules`, `dist`, and the fixture DB were gitignored | `.gitignore` negations |
| R2-5 / R3-3 | critical | The M1 vertical slice was unreachable under layer-ordered phases | Milestone **waves** (00 §3) |
| R2-6 | critical | `composeRunner` had no owner and was scheduled too late | `createRuntime()` in `@relay/engine` (F16) |
| R4-1 / R4-2 | critical | A cancel during a call could roll back settlement. The cancel window came before the controller existed | F4 rewrite: the settlement tx always commits, the step transition is conditional, the controller is registered before dispatch, and the credential is resolved before any attempt row |
| R4-3 | major | Recovery left R stuck and drove U negative on reconcile | Recovery always moves to unknown, and reconcile works only on unknown attempts |
| R4-4 | major | Month-bucketed R/U broke across month boundaries | C is month-scoped, R/U are outstanding totals |
| R4-5 | major | Output artifact files were never written, and the raw/output hash collided | `put` both. Unique key `(attempt, kind, sha)` |
| R4-6 | major | `use_preserved_snapshot` impossible (only hashes stored) | `input_file` snapshot artifacts |
| R4-7 / R4-8 / R3-6 | major | Dispatch-phase detection unsound. Mid-stream failures were retried blindly | Cause-code classification. `responded_partial` → unknown, never retried |
| R3-1 | high | Exhausted retries made the run `failed`, not recoverable (FR-12) | New pause reasons + `runs.retryStep` new step row (`retry_index`) |
| R3-2 | high | An overrun didn't always block further work (§9.5) | `paused(budget_overrun)` until acknowledged |
| R3-5 | high | The deadline counted approval wait time | Execution time accrues only while `running` |
| R3-7 | high | `providers.test` bypassed budget admission (§3.3) | Setup allowance with admission |
| R3-11 | high | A provider switch after approval wasn't invalidated (§11.3) | The approval binds its providers → `provider_changed` |
| R4-13 / R4-14 / R4-15 / R4-16 | major | Preload/packaging externals, unstarted MessagePorts, lock-before-setPath, CSP broke dev | `externalizeDeps:false`, `port.start()`, boot order, per-mode CSP plugin |
| R4-17 | major | `vitest.workspace.ts` was removed in Vitest 4+ | `vitest.config.ts` `test.projects` |
| R4-32 | minor | Migration files inside asar / path issues | Migrations embedded as TS modules |

Added §7.2 edges (spec clarifications, R3-22): see the note under 06 §F2.

### Round 5 reconciliation (2026-09-30)

- R5-1: Catalog price key is `prices` everywhere (02 `catalogEntrySchema.prices`); entries require `source` (https), `sourceRetrievedAt`, `effectiveDate`; 04 D2 example, 03 `model_catalog.source_retrieved_at` + `display_name`, and `CatalogRepo` mapping updated.
- R5-2: 02 `budgetBreakdownSchema.scope` includes `setup`; `PERMISSION_DENIED` `details.reason` codes listed; `FindingsV1`/`PlanV1`/`PatchV1`/`ReviewV1`/`ReportV1`/`ContextManifest` types exported; `profiles.list` returns `{ profile, warnings }[]` (06 F14 `profilesWithWarnings`, 10 J10 renders it); `runs.resume` idempotency covers every `RecoveryDecision` kind.
- R5-3: `RunDetail.deadlineAt` removed; remaining execution time = limit − `executionMsUsed` − current segment (06 F12); 03 has no `deadline_at` column.
- R5-4: `parseCrashAt(spec, { exit })` is the only barrel export from `src/testing/**` (01 lint group `['./testing/*', '!./testing/crash-hooks.js']`); the approval crash spec is `afterApprovalCommit@approve` (11 K4 row 6).
- R5-5: 06 F16 `RuntimeOptions` adds `timers?`, `fakeScenario?: string | FakeScenario`, `fakeExtraFixtures?`, `logger?`; 04 D8 registry options accept `timers`, inline scenarios, `extraFixtures`, `logger`.
- R5-6: 06 `ports.ts` declares `ContextAssemblerPort.assemble({ …, stepSpec, preservedSnapshot })`, `MemoryServicePort.snapshotForRun(runId, projectId, { includeIds? })` / `recordRunSummary(runId)`, and `TemplateRegistry.seedVersions()` / `reportLimitations()`, matching 07.
- R5-7: `readSnapshot({ artifactId, storeRelPath, sha256 })` in 06 F8/intake and 07 G1 step 4; 06 intake inserts `run_input_files.artifact_id`.
- R5-8: 04 D7 adds fake scenario `slow-review` (review `delayMs` 5000, then happy path) for 12.
- R5-9: 10 J2 emits `relay:nav:<route>` measures and `relay:history-loaded`; 10 J1 registers every route in Wave 1 with `PlaceholderPage` for unbuilt pages.
- R5-10: 01 vitest `unit` project includes `apps/desktop/build/**/*.test.ts`; `scripts/_placeholder.ts` (A) is deleted by M with the first real script (00 §2, 13).
- R5-11: No `migrationsDir` remains in 08 (migrations are embedded).
- R5-12: 00 §2 F row lists `profiles`; 00 §6 adds FR-12 recoverable-pause rows (int `failure-modes`, e2e `pause-states`).

### Founder answers (2026-09-30), R7

| Id | Change |
|---|---|
| R7-1 | OS confirmed: macOS 26, arm64 |
| R7-2 | Gemini added as a third BYOK adapter (04 §D10, Wave 2 tail, first scope cut). `PROVIDER_IDS` includes `gemini` |
| R7-3 | Self-funded, BYOK product for other companies. It stays single-user in P0, and team features stay P2 |
| R7-4 | M0 interviews not started. Implementation proceeds, and interviews are tracked in m0-status at each gate |

### Round 6 verification (2026-09-30)

- R6-1 (fixed): `choose_profile` → `runs.retryStep { stepId, profileId }` only when the paused step is `failed`, else `runs.resume({ kind: 'switch_profile', stepKey, profileId })`; 02 `RUN_ACTION_OPS: Record<RunAction, Channel | readonly Channel[] | 'navigate'>` + catalog test; 06 F2/F7 (retryStep only for failed steps; budget/setup pauses use `switch_profile`; `setup_blocked` offers `resume`); 10 J2/J8 consistent.
- R6-2 (fixed): context port input is `{ run, step, snapshot, stepSpec, preservedSnapshot, purpose, priorAttempts }` in 06 F1, 06 F4 call site, and 07 G1 `AssembleInput`; G3 schema-repair block reads `purpose` + `priorAttempts`.
- R6-3 (fixed): per-package `test`/`typecheck` gates replaced by `pnpm typecheck` and `pnpm test:unit -- <path filter>` (02, 03, 04, 05, 06, 07, 08, 10).
- R6-4 (fixed): `node -e` smokes run as `pnpm --filter @relay/tests exec node --conditions=development --import tsx --input-type=module -e "…"` (02, 03, 06, 07).
- R6-5 (fixed): 00 §6 runs `RELAY_E2E_KEEP=1 pnpm e2e` before `pnpm check:secrets`.
- R6-6 (fixed): 00 §4 M3 uses `pnpm test:integration -- -t "@m3"` (vitest has no `--grep`).
- R6-7 (fixed): 01 vitest `unit` include adds `tests/evaluations/**/*.test.ts`.
- R6-8 (fixed): runner serves `providers.list` from its DB; main overlays `storage: 'session'` presence; stays forwarded; `providers.listCredentialRefs` only for main-boot vault reconciliation (02, 08 H4).
- R6-9 (fixed): 08 H4 `app.exportDiagnostics` gets runner data via the forwarded `app.getDiagnostics`.
- R6-10 (fixed): 08 H7 compose passes `emit: (e) => protocol.sendEvent(e)` to `createRuntime`; `compose.test.ts` asserts it.
- R6-11 (fixed): 06 F16 `RuntimeOptions.templates?: TemplateRegistry` (default bundled) used by `seedDatabase` and the engine; 13 M4 single-step baseline passes it.
- R6-12 (fixed): 02 `RUN_EVENT_TYPES` adds `ledger.overrun`, `artifact.write_failed`, `run.limits_raised`, `report.created`, `run.snapshot_preserved`; 06 appends `run.snapshot_preserved` on the `use_preserved_snapshot` resume.
- R6-13 (fixed): credential purpose `'estimate'` removed; the pre-estimate resolve uses `purpose: 'dispatch'`, `attemptId: null`, key reused for the dispatch; `'connection_test'` for `providers.test` (02 B7, 06 F1, 08 H6).
- R6-14 (fixed): 06 F18 returns the 02 `providers.test` shape `{ ok, latencyMs, modelProbed, error?, costMicrousd, certainty }`.
- R6-15 (fixed): plan headers restate their task→wave mapping from 00 §3 (01–13); 00 §3 Wave 2 lists F18; 00 §4 M3 row lists F9, F11.
- R6-16 (fixed): 07 Files = `packages/templates/{src,review-propose-fix}/**`; 11 Files drops `tests/package.json` (script entries requested from A).
- R6-17 (fixed): 07 G6 relative imports use `.js` extensions (NodeNext).
- R6-18 (fixed): 06 F7 uses `StepRepo.listEligible`.
- R6-19 (fixed): 06 F16 `createArtifactStore({ userDataDir, clock })`.
- R6-20 (fixed): `isPidAlive` is an `openDb` option (03); 06 F16 passes it to `openDb`; removed from `EngineDeps`.
- R6-21 (fixed): 06 F16 `Runtime = { engine, db, projectFs, artifacts, providers, dispose }`; 11 K3 harness uses those fields.
- R6-22 (fixed): 06 F7 the first attempt on a `runs.retryStep` row has purpose `user_retry`.
- R6-23 (fixed): 12 `unknown-outcome.spec.ts` part (2) relaunches with a fresh `userDataDir` (new fixture instance).
- R6-24 (fixed): 14 §2 gate reads "≥ 55 operations; 9 internal ops".
- R6-25 (fixed): 14 §4 reads "meta CSP in production; response header only in dev".
- R6-26 (fixed): 00 §5 runner entry `src/runner/runner.ts` (+ `protocol-server.ts`, `compose.ts`) and full scripts list; 00 §6 `test:live` caps "$0.10 connection smokes + $1.50 workflow smoke (D9b)"; 00 §2 J row includes `index-html.test.ts`.
- R6-27 (fixed): 07 G5 `memory.create` allows any type except `run_summary`; 10 J5 Onboarding row moved into the table; 01 `.env.example` adds `RELAY_LIVE_WORKFLOW_CAP_MICROUSD`, `RELAY_E2E`, `RELAY_CRASH_AT`, `RELAY_E2E_KEEP` (dev/e2e only).
