# Plan 06: Engine Core — State Machines, Checkpoints, Budget, Policy, Retry, Recovery (Agent F)

Spec: §4.2–4.4, §6.4, §6.5, §7.2–7.7, §9.1–9.5, §11.1–11.3, FR-02/03/04/05/07/08/09/11/12 · Backlog: RLY-011, 012, 013, 017, 018, 019, 020, 021 · Waves (00 §3): **Wave 1 / M1** F1–F5, F13 (minimal loop: intake, one model step, finalize; includes the crash-hook parser needed by H7 and K4), F15, F16 (runtime + seed) · **Wave 2 / M2** F6–F8, F10 (approval), F14, F18 (`providers.test`, needed by J6 onboarding) · **Wave 3 / M3** F9, F11 · **Wave 4 / M4** F5 overrun + setup allowance, F12, F17 (report)

Files (exclusive): `packages/engine/src/{index,runtime,seed,report,setup-calls,profiles,runner,run-machine,step-machine,checkpoints,budget,policy,retry,recovery,cancellation,deadline,revision,approvals,services,ports,clock}.ts`, `packages/engine/src/steps/**`, `packages/engine/src/testing/**` (including `testing/crash-hooks.ts`, `testing/harness.ts`, `testing/manual-timers.ts`)

G owns `context.ts`, `prompt-render.ts`, `memory.ts`, `memory-retrieval.ts`, `token-budget.ts`, and `manifest.ts` in the same directory. F reaches them only through `ports.ts`.

**No Electron and no `node:sqlite` imports (lint gate).** Storage, providers, and tools are imported as **types only**, and their implementations are injected. The single exception is `src/runtime.ts`, the Electron-free composition root (F16), which value-imports `@relay/storage`, `@relay/providers`, `@relay/tools`, and `@relay/templates` (ESLint override in 01, which also covers `*.test.ts` and `src/testing/**`). `seed.ts` receives the catalog and templates as arguments, so it stays type-only.

**Result naming (02 R4-35).** Engine-internal functions return `Result<T> = { ok: true; value: T } | { ok: false; error: AppError }`. Runner handlers return `IpcResult<C>` via `toIpc(result)` from contracts.

---

## F1: Ports & engine factory (`src/ports.ts`, `src/index.ts`)

```ts
import type { Balances, BudgetBreakdown, ProviderId, AttemptId, RunnerChannel, RunnerInputOf, IpcResult } from '@relay/contracts';

export interface CredentialRequest { providerId: ProviderId; purpose: 'dispatch' | 'connection_test'; attemptId: AttemptId | null }  // one 'dispatch' resolve per attempt, before the estimate (attemptId null); key reused for the dispatch
export interface CredentialResolver { resolve(req: CredentialRequest): Promise<Result<string>> }   // → main via runner protocol (02 R2-25)

export interface CrashHookCtx { attemptId?: AttemptId; stepKey: StepKey; purpose: AttemptPurpose | null; attemptSeq: number }
export interface EngineTestHooks {           // F13; every hook is optional and a no-op in production
  beforeReservationTx?(c: CrashHookCtx): void; afterDispatchIntent?(c: CrashHookCtx): void;
  afterProviderResponse?(c: CrashHookCtx): void; afterStepCommit?(c: CrashHookCtx): void;
  afterApprovalCommit?(c: CrashHookCtx): void;
}

// Ports implemented by G (07). Wording matches 07 G1/G5; G never edits this file.
export interface ContextAssemblerPort {
  assemble(input: {
    run: RunRow; step: StepRow; snapshot: ProfileSnapshot;
    stepSpec: ModelStepSpec;           // from the run's workflow version snapshot (role, outputSchema, instructionVersion, memoryScope)
    preservedSnapshot: boolean;        // true after the user chose `use_preserved_snapshot` for this run: skip the stale check
    purpose: AttemptPurpose;           // initial | transport_retry | schema_repair | user_retry
    priorAttempts: AttemptRow[];       // this step's earlier attempts; their validation issues feed the G3 schema-repair block
  }): Promise<Result<AssembledContext>>; // { system, user, manifest: ContextManifest, estimatedInputTokens }
}
export interface MemoryServicePort {
  snapshotForRun(runId: RunId, projectId: ProjectId, o: { includeIds?: MemoryId[] }): Result<void>;  // intake; pinned user_rules always included
  proposeFromRun(runId: RunId): Result<void>;                  // finalize: ≤ 3 suggestions, never auto-approved
  recordRunSummary(runId: RunId): Result<void>;                // finalize: one approved run_summary, idempotent (R3-17)
  // + the memory.* IPC handlers (create, update, approve, reject, archive, delete, resolveConflict, list, get)
}
// TemplateRegistry is the @relay/templates type (07 G6): list(), get(slug), prompt(version), schema(id), jsonSchema(id),
// seedVersions(): WorkflowSeed[] (consumed by seedDatabase, F16) and reportLimitations() (consumed by F17).

export interface EngineDeps {
  db: Db;                                    // @relay/storage (type)
  providers: ProviderRegistry;               // @relay/providers (type)
  projectFs: ProjectFsPort;                  // wraps @relay/tools: openRoot, readSelected, hashFiles, scan
  artifacts: ArtifactStore;                  // @relay/tools (type): put, read, readSnapshot, snapshotInputFiles, purge
  context: ContextAssemblerPort;             // implemented by G (context.ts)
  memory: MemoryServicePort;                 // implemented by G (memory.ts); includes recordRunSummary (G5)
  templates: TemplateRegistry;               // @relay/templates
  credentials: CredentialResolver;
  maintenance: { sweepRawResponses(now: EpochMs, retentionDays: number): Promise<void> };  // storage C8, injected by runtime.ts
  clock: Clock; ids: IdGen; logger: Logger;
  emit: (e: PushEvent) => void;              // → main → renderer
  timers: Timers;                            // { setTimeout, clearTimeout, setInterval, clearInterval } — the ONLY timer source (tests inject manual timers)
  hooks?: EngineTestHooks;                   // crash injection points (F13); undefined in production
}
export interface EngineApi {                 // one handler per runner-routed IPC op (02 §B5) + INTERNAL_RUNNER_OPS (02 R2-1)
  handle<C extends RunnerChannel>(channel: C, input: RunnerInputOf<C>): Promise<IpcResult<C>>;
  start(): Promise<void>;                    // lease → recovery (F9) → reconcile task (F9b) → retention sweep → loop
  stop(opts: { graceMs: number }): Promise<void>;
}
export function createEngine(deps: EngineDeps): EngineApi;
```

`handle` dispatches through a `Record<RunnerChannel, Handler>` table in `services.ts`. The type system makes the table exhaustive, so a missing channel (public or internal) is a compile error. Each handler follows these rules:
1. It performs idempotency lookup and storage for `idempotent` ops (`IdempotencyRepo`; stored results are small: ids plus status, 03 R4-30).
2. It calls domain services.
3. It maps to the DTO and returns `toIpc(result)`.
4. It never leaks `root_realpath` and applies `redactDeep` on event payloads.

`engine.start()`:
1. `LeaseRepo.acquire(ownerId, process.pid, now, RUNNER_STALE_AFTER_MS)` (the PID liveness check is the `isPidAlive` option given to `openDb`, 03 C4). `held_by_other` → rejects with `RUNNER_UNAVAILABLE`. A heartbeat interval (2 s, `deps.timers`) keeps the lease fresh; `stop()` releases it.
2. Recovery (F9) in one transaction per run.
3. Terminal runs that lack a `report` artifact get one (F17 crash-safety).
4. Schedules the F9b reconcile task and the retention sweep: `maintenance.sweepRawResponses(now, settings.rawResponseRetentionDays)` at boot and then every 24 h via `deps.timers` (R3-16).
5. Starts the loop (F13).

**Barrel (`src/index.ts`, R2-35).** Re-exports `createEngine`, `createRuntime`, `seedDatabase`, `createContextAssembler`, `createMemoryService`, `parseCrashAt` (signature `parseCrashAt(spec, { exit })`, from `./testing/crash-hooks.js`), `parseCrashSpec`, `crashHooksFromEnv`, and the types `EngineApi`, `EngineDeps`, `EngineTestHooks`, `CrashHookCtx`, `RuntimeOptions`, `Runtime`. The crash-hook parser is the **only** symbol re-exported from `src/testing/**` (H7 and K4 need it; it is inert unless `RELAY_E2E=1`). The harness, fakes, and manual timers are never exported from the barrel.

## F2: Run state machine (`src/run-machine.ts`) — pure core + one repo-bound applier

Implements spec §7.2 plus the edges and triggers the user journeys need. Every addition is listed under "Clarifications of §7.2" below and logged in the 14 review log.

```ts
export type RunMachineEvent =
  | { type: 'CHECKS_PASSED' }
  | { type: 'SETUP_BLOCKED'; reason: 'setup_blocked' | 'auth_required' | 'budget_run' | 'budget_project'; error: AppError }
  | { type: 'PLAN_READY'; approvalId: ApprovalId }
  | { type: 'APPROVED_MATCHING' } | { type: 'REJECTED' }
  | { type: 'REVISION_REQUESTED' }                                     // approval → queued (planner re-runs once the run holds the slot; ruling B2)
  | { type: 'BUDGET_BLOCKED'; scope: 'run' | 'project'; error: AppError }
  | { type: 'BUDGET_OVERRUN'; attemptId: AttemptId; error: AppError }  // X > N after settlement, regardless of L (§9.5)
  | { type: 'USER_PAUSE' }
  | { type: 'AUTH_FAILED'; error: AppError }
  | { type: 'RATE_LIMIT_EXHAUSTED'; error: AppError }
  | { type: 'APPROVAL_STALE'; error: AppError }                        // APPROVAL_STALE or PROJECT_CHANGED
  | { type: 'LIMIT_REACHED'; reason: 'limit_attempts' | 'deadline'; error: AppError }
  | { type: 'OUTPUT_INVALID_EXHAUSTED'; error: AppError }              // schema-repair budget spent
  | { type: 'TRANSPORT_EXHAUSTED'; error: AppError }                   // transport retries spent / non-retryable provider error
  | { type: 'MODEL_REFUSED'; error: AppError }
  | { type: 'UNKNOWN_OUTCOME'; attemptId: AttemptId; error: AppError } // live ambiguous result (F7)
  | { type: 'RUNNER_LOST'; lastAliveAt?: EpochMs }                    // recovery passes the last sign of life (B1)
  | { type: 'UNRECOVERABLE'; error: AppError }                         // invariant violation / internal error only
  | { type: 'ACCEPTED' }
  | { type: 'REVISION_LIMIT'; cause: 'revision_limit' | 'verifier_incomplete' }
  | { type: 'CANCEL_REQUESTED' } | { type: 'STOP_REQUESTED' } | { type: 'WORK_STOPPED' }
  | { type: 'RESUME_RESOLVED' }                                        // see "Who emits RESUME_RESOLVED"
  | { type: 'RECOVERY_DECIDED' };

export function transitionRun(status: RunStatus, ev: RunMachineEvent): { to: RunStatus; pauseReason: PauseReason | null } | { error: 'ILLEGAL' };
export function allowedRunActions(run: RunRow, ctx: { unknownAttempts: number; hasFailedStep: boolean; hasPatchArtifact: boolean }): RunAction[];
export const isTerminal: (s: RunStatus) => boolean;

// Repo-bound applier — the ONLY code that writes runs.status. Called inside a db.tx.
export function applyRunEvent(r: Repos, run: RunRow, ev: RunMachineEvent, now: EpochMs, fx: PostCommitEffect[]): boolean;
```

`applyRunEvent` computes `transitionRun`, then does a CAS `runs.updateStatus(id, [run.status], to, { pauseReason, statusDetail: ev.error ?? null, endedAt })`. In the same transaction it:
- calls `runs.enterRunning(id, now)` when `to === 'running'` and `runs.leaveRunning(id, now)` when leaving `running` (F12 accrual); for `RUNNER_LOST` the segment closes at `min(ev.lastAliveAt, now)`, never at `now` (ruling B1);
- asserts (invariant) that no other run is `running` or `cancelling` when `to === 'running'` (§9.1 concurrency 1, ruling B2);
- clears `pause_requested` on `USER_PAUSE`, `RESUME_RESOLVED`, and every terminal transition;
- appends `run.status_changed`.

It pushes post-commit effects into `fx` (arm/disarm the deadline timer, wake the loop, emit the push event, generate the report on a terminal transition). The caller runs them with `await runEffects(ctx, fx)` after the transaction commits, so no effect runs for a rolled-back transition. It returns `false` if the CAS lost (the caller re-reads).

Transition table (every row is one `it()` in `run-machine.test.ts`; all other pairs → ILLEGAL):

| From | Event | To | pauseReason |
|---|---|---|---|
| queued | CHECKS_PASSED | running | – |
| queued | SETUP_BLOCKED | paused | setup_blocked / auth_required / budget_run / budget_project |
| queued | CANCEL_REQUESTED | cancelled | – (nothing in flight) |
| running | PLAN_READY | awaiting_approval | – |
| running | SETUP_BLOCKED | paused | setup_blocked / auth_required (**pre-dispatch only**: context too large, model unsupported, provider not permitted found by the context assembler or F6 before any attempt; the step is still `ready`) |
| running | BUDGET_BLOCKED | paused | budget_run / budget_project |
| running | BUDGET_OVERRUN | paused | budget_overrun |
| running | USER_PAUSE | paused | user (takes effect **before the next dispatch**; the in-flight call completes) |
| running | AUTH_FAILED | paused | auth_required |
| running | RATE_LIMIT_EXHAUSTED | paused | rate_limited |
| running | APPROVAL_STALE | paused | approval_stale |
| running | LIMIT_REACHED | paused | limit_attempts / deadline |
| running | OUTPUT_INVALID_EXHAUSTED | paused | output_invalid |
| running | TRANSPORT_EXHAUSTED | paused | provider_unavailable (transport retries spent, or a responded non-retryable provider error such as MODEL_UNSUPPORTED from 400/404/422 or CONTEXT_TOO_LARGE from 413: the step is `failed`) |
| running | MODEL_REFUSED | paused | model_refused |
| running | UNKNOWN_OUTCOME | paused | unknown_outcome |
| running | RUNNER_LOST | interrupted | – |
| running | UNRECOVERABLE | failed | – |
| running | ACCEPTED | completed | – |
| running | REVISION_LIMIT | incomplete | – |
| running | CANCEL_REQUESTED | cancelling | – |
| awaiting_approval | APPROVED_MATCHING | queued | – (ruling B2: the loop's CHECKS_PASSED moves it to running when it is the next eligible run) |
| awaiting_approval | REVISION_REQUESTED | queued | – (ruling B2, same as above) |
| awaiting_approval | REJECTED | cancelled | – |
| awaiting_approval | APPROVAL_STALE | paused | approval_stale |
| awaiting_approval | CANCEL_REQUESTED | cancelled | – |
| paused | RESUME_RESOLVED | queued | – |
| paused | CANCEL_REQUESTED / STOP_REQUESTED | cancelled | – |
| paused | BUDGET_OVERRUN | paused | budget_overrun (clarification 14: applied by `resumeIfUnknownsResolved` for a deferred reconciled overrun) |
| paused | APPROVAL_STALE | paused | approval_stale (clarification 14: deferred reconciled scope change) |
| interrupted | RECOVERY_DECIDED | queued | – |
| interrupted | CANCEL_REQUESTED / STOP_REQUESTED | cancelled | – |
| cancelling | WORK_STOPPED | cancelled | – |
| cancelling | RUNNER_LOST | cancelled | – (the in-flight attempt becomes unknown; liability kept) |

Run status `failed` is reachable **only** through `UNRECOVERABLE` (invariant violations or internal errors). Exhausted retries, refusals, and provider errors pause the run instead (R3-1).

**Who emits `RESUME_RESOLVED`** (paused → queued; the loop then runs `CHECKS_PASSED` or `SETUP_BLOCKED`):
- `runs.resume({kind:'continue'})` on `paused(user | rate_limited | auth_required | setup_blocked)` (for `setup_blocked` the loop simply re-runs the checks, e.g. after the user narrowed scope or edited project policy). `auth_required` requires a credential ref to exist, else `AUTH_REQUIRED`. Resuming from `rate_limited` resets the ready step's `rate_limit_waits_used` to 0.
- `runs.increaseAllowance` writes `allowance_change` and **auto-emits** `RESUME_RESOLVED` on `paused(budget_run | budget_overrun)` when a read-only admission for the next eligible model step would now pass (`nextAdmissionWouldPass`: re-estimate outside the tx, then `admit` in a read tx). Otherwise the run stays paused and the response carries the new breakdown.
- `projects.update` (the `edit_project_allowance` action) re-evaluates every `paused(budget_project)` run of that project with `nextAdmissionWouldPass` and emits `RESUME_RESOLVED` for each that passes.
- `runs.resume({kind:'acknowledge_overrun'})` on `paused(budget_overrun)`. Admission still applies at the next dispatch, so if C + R + U + N > L the run pauses again as `budget_run`.
- `runs.resume({kind:'raise_limits'})` on `paused(limit_attempts | deadline)`. The new limits are written in the same CAS (F12).
- `runs.retryStep` on a paused run whose blocked step is `failed` (F7): the step gets a new row. `runs.retryStep` is **only** for failed steps (`CONFLICT` otherwise).
- The `choose_profile` action maps by the paused step's state (02 B5 `RUN_ACTION_OPS`): if the step is `failed` → `runs.retryStep { stepId, profileId }`; otherwise → `runs.resume({ kind: 'switch_profile', stepKey, profileId })`. So `paused(budget_run | budget_project | setup_blocked)` (step still `ready`) always use `switch_profile`, which appends a `run_config_revisions` row + `run.config_revised` and emits `RESUME_RESOLVED`.
- `runs.decideUnknown` on `paused(unknown_outcome)` when the last unknown attempt of the run is decided **and** its step went back to `ready` (`retry_acknowledging_charge`) **and** no reconciled outcome deferred a pause (clarification 14; F9b auto-resume follows the same rule).
- `runs.resume({kind:'resnapshot_and_replan' | 'use_preserved_snapshot'})` on `paused(approval_stale)`. `use_preserved_snapshot` appends a `run.snapshot_preserved` event in the same transaction (F6 reads it to skip the input-hash comparison).

`RECOVERY_DECIDED` is emitted by `runs.resume` (the `review_recovery` action) on `interrupted`, and only when the run has no attempt in state `unknown` (else `CONFLICT` with `details.unknownAttempts`).

`allowedRunActions` truth table (drives `RunDetail.availableActions`; the UI renders only these; the 02 action→op table maps each action to its IPC op):

| Status | Actions |
|---|---|
| queued | cancel |
| running | pause, cancel |
| awaiting_approval | approve, request_revision, reject, cancel |
| paused (budget_run) | increase_allowance, choose_profile, stop |
| paused (budget_project) | edit_project_allowance, choose_profile, stop |
| paused (budget_overrun) | acknowledge_overrun, increase_allowance, stop |
| paused (limit_attempts / deadline) | raise_limits, stop |
| paused (output_invalid / provider_unavailable / model_refused) | retry_step, choose_profile, stop |
| paused (setup_blocked) | resume, choose_profile, stop |
| paused (unknown_outcome) | decide_unknown (retry_acknowledging_charge / mark_failed_keep_liability / accept_estimated_charge), stop. Once `unknownAttempts = 0` and `hasFailedStep`: retry_step, choose_profile, stop |
| paused (auth_required) | reconnect_provider, resume, stop |
| paused (user / rate_limited) | resume, stop |
| paused (approval_stale) | resnapshot_and_replan, use_preserved_snapshot, stop |
| interrupted | review_recovery, decide_unknown (only if `unknownAttempts > 0`), stop |
| cancelling | – |
| terminal (completed / incomplete / cancelled / failed) | export_report, export_patch (only if `hasPatchArtifact`) |

**Clarifications of §7.2** (each is logged in 14 as a spec clarification; `run-machine.test.ts` has one `it()` per item):

*Edges not drawn in §7.2:*
1. `queued → cancelled` (CANCEL_REQUESTED): nothing is in flight, so there is no `cancelling` phase.
2. `awaiting_approval → queued` (APPROVED_MATCHING, REVISION_REQUESTED; **ruling B2**): an approval decision re-queues the run instead of moving it straight to `running`, so a decision made while another run is running can never create a second running run (§9.1 concurrency 1). The loop's `CHECKS_PASSED` moves it to `running` once it is the next eligible run (running/cancelling first, else the oldest queued). After `REVISION_REQUESTED` the planner then re-runs (§11.3). `allowedRunActions` is unaffected (`queued` → cancel).
3. `awaiting_approval → paused(approval_stale)` (APPROVAL_STALE): a stale plan, context, or input file is detected while waiting (§11.2).
4. `awaiting_approval → cancelled` (CANCEL_REQUESTED): §7.2 labels this edge "reject"; cancel reuses it.
5. `paused → cancelled` (CANCEL_REQUESTED / STOP_REQUESTED): §4.3 "stop with existing artifacts".
6. `interrupted → cancelled` (CANCEL_REQUESTED / STOP_REQUESTED): §4.4 recovery can end in stop.
7. `cancelling → cancelled` on RUNNER_LOST: covered by "work stopped or detached", listed for completeness.

*Triggers added to existing §7.2 edges:*

8. `running → paused` is labeled "budget or user pause". The added reasons are `budget_overrun` (§9.5), `auth_required` (§7.6 "authentication failures pause immediately"), `rate_limited`, `approval_stale`, `limit_attempts`, `deadline` (§9.1), `unknown_outcome` (§7.5), `output_invalid`, `provider_unavailable`, `model_refused`, and `setup_blocked`.
9. `queued → paused` ("setup or funding blocked") uses the reasons `setup_blocked`, `auth_required`, `budget_run`, and `budget_project`.
10. `running → failed` is narrowed to `UNRECOVERABLE` only (R3-1).
11. `running → incomplete` also fires when the verifier returns `incomplete`, not only on the revision limit (`REVISION_LIMIT.cause`).
12. `paused → queued` ("resume after resolution") is emitted by the operations listed in "Who emits RESUME_RESOLVED".
13. `interrupted → queued` ("recovery decision") requires every unknown attempt to be decided first.
14. `paused → paused(budget_overrun | approval_stale)` (BUDGET_OVERRUN / APPROVAL_STALE, Referee BH-2/BH-6): a reconciled result of an unknown attempt (F9b) that overran its liability (X > N, §9.5) or, for a quality revision, left the approved scope (F10) requires that pause. While the run is `paused(unknown_outcome)` it is recorded as `error.recorded { kind: 'deferred_pause' }`; once the run's last unknown attempt is resolved (reconciled or decided), `resumeIfUnknownsResolved` applies the deferred event **instead of** RESUME_RESOLVED (overrun first). It is never auto-resumed. An `interrupted` run keeps waiting for `review_recovery` (the overrun is shown in its cost and `ledger.overrun` event).

**Invariant (tested).** For **every** `PAUSE_REASON`, `referee-wave2.test.ts` builds a representative paused state, checks that the chosen non-stop action is in `allowedRunActions`, performs it through IPC, and asserts the run reaches `queued` via RESUME_RESOLVED (`Record<PauseReason, …>`, so a new reason fails to compile until it has a case).

## F3: Step state machine (`src/step-machine.ts`) — pure

§7.3: `pending → ready → reserved → executing → validating → succeeded | failed`. Other outcomes: `unknown` for ambiguous results, `awaiting_approval` for approval steps, and `skipped`.

**`validating` is in-memory only (R4-25).** It is the phase between the provider response and the step-7 commit (F4). It is emitted as a push progress event but never persisted, because persisting it would need an extra transaction between two points that §7.4 already covers. The step-7 transaction therefore moves `executing → succeeded | ready | failed | unknown` directly. The enum keeps `validating` for the UI. No DB row is ever in `validating`.

**Step rows are keyed `(run_id, step_key, revision_index, retry_index)` (R4-20).** A quality revision creates rows with `revision_index + 1, retry_index 0` (F10). A user retry of a **failed** step (`runs.retryStep`) inserts a new row with `retry_index + 1`, state `ready`, and fresh counters (`schema_repairs_used = transport_retries_used = rate_limit_waits_used = 0`). The failed row is kept as history. `selectNextStep` and `dependsOn` always resolve to the latest `(revision_index, retry_index)` row per `step_key` (`StepRepo.latestFor`).

The synthetic `intake` and `finalize` rows (F15) have no attempts. They move `ready → succeeded` directly when their handler finishes.

| From | Event | To |
|---|---|---|
| pending | DEPS_MET | ready |
| ready | RESERVED | reserved |
| ready | APPROVAL_OPENED | awaiting_approval |
| ready | LOCAL_STEP_DONE (intake / finalize) | succeeded |
| reserved | DISPATCHING | executing |
| reserved | RESERVATION_RELEASED (not sent; recovery) | ready |
| executing | SETTLED_VALID | succeeded |
| executing | NOT_SENT (aborted before `generate`, or phase `not_sent` without retry class) | ready |
| executing | SETTLED_RETRY (known failure or invalid output, retry budget left) | ready (counter +1, `not_before_at` set for backoff) |
| executing | SETTLED_FAILED (retry budget exhausted, refusal, non-retryable known error) | failed |
| executing | OUTCOME_UNKNOWN | unknown |
| unknown | USER_RETRY (`retry_acknowledging_charge`) | ready (next attempt purpose `user_retry`, `retry_of_attempt_id` set) |
| unknown | USER_ABANDON (`mark_failed_keep_liability` / `accept_estimated_charge`) | failed |
| unknown | RECONCILED_VALID | succeeded |
| unknown | RECONCILED_RETRY / RECONCILED_FAILED | ready (if retry budget) / failed |
| awaiting_approval | DECIDED_APPROVED | succeeded |
| awaiting_approval | DECIDED_REVISION / DECIDED_REJECTED | failed (a revision gets a new plan row, F10) |
| any non-terminal | RUN_CANCELLED | skipped |

Terminal step states (`succeeded`, `failed`, `skipped`) are immutable. A retry is always a new row.

## F4: Checkpoint protocol (`src/checkpoints.ts`) — §7.4, as code

The single function that executes one model step attempt. Numbered comments map 1:1 to §7.4. **No `await` occurs inside a `db.tx` callback. The storage types enforce this at compile time.** `ctx` is `EngineDeps` plus the engine-internal services (`cancellation`, `deadlines`, `wake`).

```ts
export async function executeModelAttempt(ctx: EngineCtx, runId: RunId, stepRunId: StepRunId): Promise<AttemptOutcome> {
  const { db, ids, clock } = ctx;
  // 1. Validate inputs and construct an immutable execution snapshot.
  const run = db.repos.runs.get(runId);
  const step = db.repos.steps.get(stepRunId);
  const prior = db.repos.attempts.listForStep(stepRunId);
  const purpose = nextPurpose(step, prior);                                  // F7 pure: initial | transport_retry | schema_repair | user_retry
  const stepSnap = effectiveStepSnapshot(db.repos, run, step.stepKey);      // run.snapshot_json ⊕ latest run_config_revisions row (R3-13)
  const hook: CrashHookCtx = { stepKey: step.stepKey, purpose, attemptSeq: prior.length + 1 };
  const assembled = await ctx.context.assemble({ run, step, snapshot: stepSnap.profile, stepSpec: stepSnap,   // G1: input_file snapshots, memoryScope
    preservedSnapshot: hasSnapshotPreserved(db.repos, runId), purpose, priorAttempts: prior });   // purpose + prior validation issues → G3 repair block
  if (!assembled.ok) return pauseRun(ctx, runId, eventForError(assembled.error));      // CONTEXT_TOO_LARGE → SETUP_BLOCKED (§10.2)
  const attemptId = ids.next('attempt');                                    // id allocated now; the row is inserted in step 2
  const request = buildModelRequest(stepSnap, assembled.value,              // pure; metadata never carries secrets (04 R2-3)
    { attemptId, runId, stepKey: step.stepKey, purpose });
  const providerId = stepSnap.profile.providerId;
  const adapter = ctx.providers.get(providerId);
  const credential = await ctx.credentials.resolve({ providerId, purpose: 'dispatch', attemptId: null });  // BEFORE estimate and before any attempt row
  const estimate = await adapter.estimate(request, stepSnap.profile.prices,
    { ...(credential.ok ? { apiKey: credential.value } : {}),                 // provider count only with a key (04 R4-12)
      priceCatalogVersion: stepSnap.profile.priceCatalogVersion });           // version of the SAME entry as the prices (§9.2)
  const binding = requiresApproval(stepSnap) ? await loadApprovalBinding(ctx, run, providerId) : null; // hashes + providers (F6 #8)
  const policy = checkDispatch({ run, step, stepSnap, request, estimate, credentialOk: credential.ok, binding,
                                 project: db.repos.projects.get(run.projectId), now: clock.now() });  // F6 pure
  if (!policy.ok) return pauseRun(ctx, runId, eventForError(policy.error));  // missing key → AUTH_FAILED; no attempt row exists
  const apiKey = (credential as { ok: true; value: string }).value;          // narrowed: check #3 passed
  const N = estimate.upperAllowanceMicrousd;

  // 2. In one transaction, create the attempt and budget reservation (run state and admission re-checked INSIDE the tx).
  ctx.hooks?.beforeReservationTx?.(hook);                                    // crash point (F13)
  const fx: PostCommitEffect[] = [];
  const admitted = db.tx('immediate', (r) => {
    const now = clock.now();
    const cur = r.runs.get(runId);
    if (cur.status !== 'running') return { ok: false, why: 'not_running' } as const;          // cancel/pause won the race
    if (cur.pauseRequested) { applyRunEvent(r, cur, { type: 'USER_PAUSE' }, now, fx); return { ok: false, why: 'paused' } as const; }
    if (cur.attemptCount >= cur.limits.maxAttempts) {                                         // R3-29
      applyRunEvent(r, cur, { type: 'LIMIT_REACHED', reason: 'limit_attempts', error: errors.limitReached('attempts') }, now, fx);
      return { ok: false, why: 'paused' } as const; }
    if (deadlineReached(cur, now)) {                                                           // F12
      applyRunEvent(r, cur, { type: 'LIMIT_REACHED', reason: 'deadline', error: errors.limitReached('deadline') }, now, fx);
      return { ok: false, why: 'paused' } as const; }
    if (r.steps.get(stepRunId).state !== 'ready') return { ok: false, why: 'conflict' } as const;
    const project = r.projects.get(cur.projectId);
    const { start, end } = monthWindow(now);                                                  // clock.ts, local calendar month
    const decision = admit({ run: r.ledger.runBalances(runId), N,
      project: project.monthlyAllowanceMicrousd === null ? null
        : { L: project.monthlyAllowanceMicrousd, ...r.ledger.projectMonthBalances(cur.projectId, start, end) } });  // F5
    if (!decision.ok) {
      r.events.append(runId, 'ledger.blocked', decision.breakdown);
      applyRunEvent(r, cur, { type: 'BUDGET_BLOCKED', scope: decision.breakdown.scope, error: errors.budgetBlocked(decision.breakdown) }, now, fx);
      return { ok: false, why: 'paused' } as const; }
    const seq = r.attempts.nextSeq(stepRunId);                                                // computed in the tx
    const requestFingerprint = fingerprintRequest(request);                                  // sha256 of normalized request, no secrets
    r.attempts.insert({ id: attemptId, runId, stepRunId, seq, purpose, retryOfAttemptId: retryOfFor(step, prior, purpose),
      providerId, modelId: stepSnap.profile.modelId, profileSnapshot: stepSnap.profile, requestFingerprint,
      state: 'reserved', reservationMicrousd: N, estimate, priceCatalogVersion: estimate.priceCatalogVersion, createdAt: now });
    r.ledger.append([{ scope: 'run', type: 'reserve', bucket: 'reserved', deltaMicrousd: +N, attemptId, runId,
      projectId: cur.projectId, priceCatalogVersion: estimate.priceCatalogVersion, createdAt: now }]);
    r.runs.incrementAttemptCount(runId);
    r.steps.transition(stepRunId, ['ready'], 'reserved', {});
    r.events.append(runId, 'attempt.created', { attemptId, purpose, seq });
    r.events.append(runId, 'ledger.reserved', { attemptId, N });
    return { ok: true, attemptId, seq } as const;
  });
  await runEffects(ctx, fx);
  if (!admitted.ok) return { kind: 'blocked', why: admitted.why };
  hook.attemptId = admitted.attemptId; hook.attemptSeq = admitted.seq;

  // 3. Mark the request as dispatching and save the durable intent.
  const controller = ctx.cancellation.register(runId, admitted.attemptId);  // registered BEFORE the step-3 tx: any later cancel aborts it
  const watch = ctx.deadlines.watch(runId, controller);                     // F12: the run's segment timer aborts registered controllers
  let dispatched = false, committed = false;
  try {
    dispatched = db.tx('immediate', (r) => {
      const now = clock.now();
      if (r.runs.get(runId).status !== 'running' || controller.signal.aborted) {             // cancelled between step 2 and here
        releaseNotSent(r, { runId, attemptId, stepRunId, N, from: 'reserved', now });         // release −N; attempt → failed_before_dispatch; step → ready
        return false;
      }
      r.attempts.transition(attemptId, ['reserved'], 'dispatching', { dispatchedAt: now });
      r.steps.transition(stepRunId, ['reserved'], 'executing', {});
      r.events.append(runId, 'attempt.dispatching', { attemptId });
      return true;
    });
    if (!dispatched) return { kind: 'blocked', why: 'not_running' };
    ctx.hooks?.afterDispatchIntent?.(hook);                                  // crash point A

    // 4. Call the provider outside the transaction.
    let result: ModelResult;
    if (controller.signal.aborted) {
      result = abortedBeforeSend(controller.signal.reason);                  // phase 'not_sent': generate was never invoked
    } else {
      try {
        result = await adapter.generate(request, { apiKey, signal: controller.signal, hooks: {
          onResponseId: (idsSeen) => db.tx('immediate', (r) => r.attempts.setProviderIds(attemptId, idsSeen)),   // persist ASAP
          onProgress: throttle((p) => ctx.emit(progressEvent(runId, attemptId, p)), 500),
        }});
      } catch (err) {                                                        // adapters never throw for provider conditions (04);
        ctx.logger.error('adapter.threw', { runId, attemptId, err });        // a throw is a bug, but the request may have left:
        result = outcomeUnknown(err);                                        // REQUEST_OUTCOME_UNKNOWN, phase 'sent_no_response'
      }
    }
    ctx.hooks?.afterProviderResponse?.(hook);                                // crash point B

    // 5. Persist the raw response and the per-attempt manifest as artifacts; protect sensitive content.
    const puts: ArtifactPut[] = [];
    const raw = rawTextOf(result);                                           // success / truncated / refused text, else null
    if (raw !== null) puts.push(await putArtifact(ctx, runId, { kind: 'raw_response',
      bytes: utf8(redactString(raw)), mediaType: isJsonText(raw) ? 'application/json' : 'text/plain' }));   // redacted (R4-24)
    puts.push(await putArtifact(ctx, runId, { kind: 'context_manifest',
      bytes: utf8(canonicalJson(assembled.value.manifest)), mediaType: 'application/json' }));

    // 6. Validate and normalize the result (pure; file contents pre-loaded from the input_file snapshot, R4-6).
    const inputs = result.kind === 'success' ? await loadSnapshotContents(ctx, run, stepSnap) : null;
    const validated = result.kind === 'success' ? validateOutput(stepSnap, result.json, inputs!, ctx.templates) : null;  // F8
    if (validated?.ok) puts.push(await putArtifact(ctx, runId, { kind: stepSnap.outputKind, schemaId: stepSnap.outputSchema,
      bytes: utf8(canonicalJson(validated.value)), mediaType: 'application/json' }));        // canonical output, NEVER redacted
    const outcome = classify(result, validated, puts,                         // F7: unknown if aborted after dispatch
      { aborted: controller.signal.aborted, abortReason: controller.signal.reason as AbortReason | undefined });
    const cost = settleAmount(outcome, stepSnap.profile.prices);                             // F5

    // 7. In one transaction, settle known usage, link artifacts, update step state, record the completion event.
    const outcomeFx: PostCommitEffect[] = [];
    const final = db.tx('immediate', (r) => {
      const now = clock.now();
      // B3: the attempt CAS (dispatching → final) goes FIRST. If it loses (recovery or another owner already moved the
      // attempt to unknown / settled it), NOTHING is written (no ledger entries), the skip is logged, and the call returns.
      // Otherwise ALWAYS: ledger moves (one group_id) + the attempt's final state + artifact rows.
      r.ledger.append(settlementEntries({ reservation: N, cost, attemptId, runId, projectId: run.projectId,
        priceCatalogVersion: estimate.priceCatalogVersion, createdAt: now }));
      for (const p of puts) if (p.ok) r.artifacts.insertIfAbsent({ ...p.meta, runId, projectId: run.projectId, stepRunId, attemptId });  // (attempt, kind, sha)
      r.attempts.transition(attemptId, ['dispatching'], finalAttemptState(outcome), { usage: usageJson(outcome),
        rawUsage: redactDeep(outcome.rawUsage), stopReason: outcome.stopReason, error: outcome.error ?? null,
        providerRequestId: outcome.providerRequestId, firstByteAt: outcome.firstByteAt, finishedAt: now });
      r.events.append(runId, 'attempt.settled', { attemptId, cost });
      // CONDITIONAL: the step moves only if it is still executing (a concurrent path may have moved it).
      const s = r.steps.get(stepRunId);
      const plan = nextAttemptPlan(s, outcome, stepSnap.retryPolicy, now);                   // F7 pure
      if (s.state === 'executing') applyStepOutcome(r, s, outcome, plan, validated, puts);  // → succeeded | ready | failed | unknown
      // Run transition only while running (a cancelling run is settled by WORK_STOPPED, F11).
      const cur = r.runs.get(runId);
      const ev = runEventFor(outcome, plan, cost, N);                                        // BUDGET_OVERRUN takes precedence (F5)
      if (ev && cur.status === 'running') applyRunEvent(r, cur, ev, now, outcomeFx);
      return { outcome, plan, runStatus: cur.status };
    });
    committed = true;
    await runEffects(ctx, outcomeFx);
    ctx.hooks?.afterStepCommit?.(hook);                                      // crash point C

    // 8. Only then make dependent work eligible.
    ctx.wake.signal();
    return toAttemptOutcome(final);
  } finally {
    watch.clear();
    ctx.cancellation.unregister(controller);
    if (dispatched && !committed) forceUnknown(ctx, { runId, attemptId, stepRunId, N });  // never leave 'dispatching' in-process
  }
}
```

Helpers:
- **Lease ownership (ruling B3).** `ctx.lease.owned` turns false when `stop()` releases the lease (before the release) or a heartbeat finds the lease taken. From then on `executeModelAttempt` neither writes the step-3 dispatch intent, nor settles (step 7), nor runs `forceUnknown`: the next owner's recovery (F9) handles the attempt. The loop exits when it no longer owns the lease.
- `forceUnknown` runs one best-effort transaction (try/catch, logged): `move_to_unknown N`, attempt `dispatching → unknown`, step `executing → unknown`, and `UNKNOWN_OUTCOME` if the run is still `running`. If that transaction also fails, recovery (F9) performs the same move at the next start.
- `releaseNotSent` writes `release −N` and moves the attempt to `failed_before_dispatch` and the step to `ready`, in the caller's transaction.
- `putArtifact` calls `ArtifactStore.put` and returns `{ ok, meta }`. A failed `raw_response` or manifest put is logged and emits `artifact.write_failed`, and the step outcome is unaffected. A failed canonical-output put classifies the attempt as a known failure with `ARTIFACT_WRITE_FAILED` (usage still settled): the step goes → `failed` and the run → `paused(output_invalid)`, so `retry_step` is available.
- `buildModelRequest` fills `metadata = { attemptId, runId, stepKey, purpose }` (04 R2-3). Real adapters send only the ids.
- `pauseRun(ctx, runId, ev)` applies the event in its own transaction (CAS from `running`) and returns `{ kind: 'blocked' }`.

Invariants (asserted in `checkpoints.test.ts`):
- A missing credential never creates an attempt row. The provider call is made only after the `dispatching` row is committed.
- The `reserve` ledger entry, the attempt row (with `seq` and `request_fingerprint` computed in the same tx), and the attempt count increment are in one transaction.
- The step-2 tx re-reads the run and requires `status === 'running' && !pause_requested && attemptCount < maxAttempts`.
- The step-7 tx settles an attempt at most once: a lost `dispatching → final` CAS writes no ledger entries (R never goes negative).
- `settle` and the `release` of the reservation share one `group_id`, and the step-7 transaction always commits the ledger moves and the attempt's final state, even when the step transition is skipped.
- After `executeModelAttempt` returns or throws, no attempt it created is in `reserved` or `dispatching`.
- Artifact rows are idempotent by `(attempt_id, kind, sha256)` (§7.5 last bullet; 03 R4-5).
- An abort after dispatch moves the **full** N to unknown. Any observed partial usage is informational only (`usage_json` with `partial: true`) (R4-9).

## F5: Budget — admission & settlement (`src/budget.ts`) — pure + one repo-bound applier

```ts
import type { Balances, BudgetBreakdown } from '@relay/contracts';   // domain/ledger.ts (R2-8)

export function admit(i: { run: Balances; project: { L: Microusd; C: Microusd; R: Microusd; U: Microusd } | null; N: Microusd })
  : { ok: true } | { ok: false; breakdown: BudgetBreakdown };
// §9.3: dispatch only when C + R + U + N <= L — checked for the run, then for the project month when an allowance is set.
// Inclusive inequality: exactly equal is allowed. The run check is reported first when both fail.

export function admitSetup(i: { setup: { C: Microusd; R: Microusd; U: Microusd }; L: Microusd; N: Microusd })
  : { ok: true } | { ok: false; breakdown: BudgetBreakdown };      // F18; L = settings setup allowance (SETUP_ALLOWANCE_MICROUSD default)

export function settleAmount(outcome: ClassifiedOutcome, prices: ModelPrices):
  | { kind: 'known'; microusd: Microusd; certainty: 'reported' | 'calculated' }
  | { kind: 'not_charged' }        // phase not_sent, aborted before generate, or provider error with no usage
  | { kind: 'unknown' };           // sent_no_response / responded_partial / abort after dispatch / adapter threw

export function isOverrun(cost: ReturnType<typeof settleAmount>, N: Microusd): boolean;   // known && microusd > N

export function settlementEntries(i: { reservation: Microusd; cost: ReturnType<typeof settleAmount>; attemptId: AttemptId | null;
  runId: RunId | null; projectId: ProjectId | null; priceCatalogVersion: string; createdAt: EpochMs; scope?: 'run' | 'setup' }): LedgerEntryInput[];
```

**Project month (R4-4).** The window is the local calendar month (`monthWindow(now)` in `clock.ts`, `[start, end)`). `LedgerRepo.projectMonthBalances(projectId, start, end)` returns `C` = settled entries created in the window, and `R` and `U` = the project's outstanding reserved and unknown amounts with **no date filter** (a reservation or unknown liability from last month still counts). `L` is `projects.monthly_allowance_microusd`. Project admission is skipped when that allowance is null.

Ledger movements (each row is one transaction and one `group_id`; `LedgerRepo.append` assigns the group; the unit tests pin them exactly):

| Situation | Entries |
|---|---|
| Admit | `reserve: reserved +N` |
| Success, cost X ≤ N | `release: reserved −N`, `settle: settled +X (certainty)` |
| Success, cost X > N (**overrun** §9.5) | `release: reserved −N`, `settle: settled +X`. The recorded number is never capped. In the same step-7 tx the run gets `BUDGET_OVERRUN` → `paused(budget_overrun)` **regardless of L** (R3-2), and `ledger.overrun {N, X}` is appended. The overrun pause takes precedence over any retry or pause the attempt outcome would otherwise cause: the step outcome (succeeded / ready with counter / failed) is still recorded, and the loop acts on it after the user acknowledges |
| Not sent / known failure without usage | `release: reserved −N` |
| Known failure **with** usage (truncated, refused, invalid output) | `release −N`, `settle +X (calculated)` |
| Outcome unknown (incl. abort after dispatch) | `move_to_unknown: reserved −N, unknown +N` (the full N; §9.3 "do not count in both R and U") |
| Unknown → reconciled completed / failed with usage | `resolve_unknown: unknown −N`, `settle: settled +X (calculated)` |
| Unknown → reconciled failed without usage | `resolve_unknown: unknown −N`, `settle: settled +0 (calculated)` |
| Unknown → user "accept estimated charge" | `resolve_unknown: unknown −N`, `settle: settled +N (estimated)` |
| Unknown → user "retry acknowledging charge" | the unknown **stays**, and the old attempt → `abandoned` (liability kept) so it no longer prompts (R4-28). The new attempt reserves its own N′ (§4.4) |
| Unknown → user "mark failed, keep liability" | the unknown stays. The attempt → `abandoned`. The UI shows "Unknown charge retained" |
| Allowance set at run start | `allowance_set: allowance +L` |
| User increases allowance | `allowance_change: allowance +(L′ − L)` (a model can never call this; it is only reachable through the IPC op `runs.increaseAllowance`) |
| Setup call (F18) | the same reserve / release / settle / move_to_unknown moves with `scope='setup'`, `run_id` and `attempt_id` NULL, `certainty` set on settle |

**Pricing is shared (dedup).** `computeCost`, `upperBound` (max(input, cacheWrite, cacheRead) + 2 µUSD slack), `maxPrices`, and `computeIterationsCost` live in `@relay/contracts` (`pricing.ts`, pure). `@relay/providers` re-exports them (binding the unknown-model maximum to its bundled catalog); the engine imports them from contracts and has no mirrored copy.

**Fallback iterations (ruling B5).** When a result carries `fallback.iterations` (ADR-016 refusal fallback), `settleAmount` prices every served iteration with its own model via contracts `computeIterationsCost`: the profile model at the snapshot prices, other models at their `model_catalog` prices; an iteration whose model has no known price is priced at the component-wise maximum of every catalog price of the provider (and the known iteration prices), and the settle entry is then `certainty: 'estimated'`.

Certainty rules (FR-09):
- `reported`: the provider returned a cost figure directly. Neither provider does this for Messages/Responses today, so this is reserved for future use.
- `calculated`: provider-reported token usage × the snapshot's catalog price. This is the normal case.
- `estimated`: no usage was reported, and the upper bound or estimate was used; or a fallback iteration's model had no known price (B5).
- `unknown`: the bucket `unknown`.

## F6: Policy (`src/policy.ts`) — pure; "no provider call is dispatched without passing policy, credential, budget, and capability checks" (§3.3)

`checkDispatch(ctx) → Result<void>` evaluates **all** checks in a fixed order and returns the first failure. The full list is also available for preflight via `checkDispatchAll`. The caller maps each error to a run event with `eventForError`.

| # | Check | Error | Run event |
|---|---|---|---|
| 1 | Run status is `running` and the step is `ready` | `CONFLICT` | none (the loop re-reads) |
| 2 | Provider ∈ project `allowedProviderIds` (§11.1, §8.5 "switching providers requires existing permission") | `PERMISSION_DENIED` (edit_policy) | `SETUP_BLOCKED(setup_blocked)` |
| 3 | The credential was resolved (F4 resolves it before the estimate) | `AUTH_REQUIRED` | `AUTH_FAILED` |
| 4 | Capabilities from the snapshot: `structuredOutput` true, `maxOutputTokens ≥ request.maxOutputTokens`, effort ∈ `effortLevels` if set, `maxInputTokens ≥ estimate.inputTokens + maxOutput` | `MODEL_UNSUPPORTED` / `CONTEXT_TOO_LARGE` | `SETUP_BLOCKED(setup_blocked)` |
| 5 | `run.attemptCount < limits.maxAttempts` (advisory; the authoritative re-check is inside the F4 step-2 tx) | `LIMIT_REACHED` (attempts) | `LIMIT_REACHED(limit_attempts)` |
| 6 | Deadline not reached: `execution_ms_used + (now − running_since) < executionTimeoutSeconds × 1000` (F12) | `LIMIT_REACHED` (deadline) | `LIMIT_REACHED(deadline)` |
| 7 | The retry counter for this purpose (F7) is within the step snapshot's `retryPolicy` | `LIMIT_REACHED` | the matching exhausted event (normally unreachable: F4 step 7 already failed the step) |
| 8 | For approval-bound steps (implement/verify): a **valid approval** exists whose `plan_hash` equals the current plan artifact hash, **and** `context_hash` equals `run.context_hash`, **and** the current input file hashes equal `run_input_files` (§11.2; skipped when the run chose `use_preserved_snapshot`), **and** the step's effective provider ∈ the approval's `requested_permissions_json.providers` (R3-11) | `APPROVAL_STALE` (`invalidated_reason`: `plan_changed` / `provider_changed`) / `PROJECT_CHANGED` (`project_changed`) | `APPROVAL_STALE`; the approval is invalidated with that reason |
| 9 | Tool call count ≤ `maxToolCalls` (0 in P0; the check is kept for the future) | `LIMIT_REACHED` | `SETUP_BLOCKED(setup_blocked)` |

- **PROJECT_CHANGED before implement (ruling B4).** When the context assembler's stale check (or check 8) fails with `PROJECT_CHANGED` for an approval-bound step, the pause transaction also invalidates the approval with reason `project_changed` and records it on the run (`error.recorded` with `{ kind: 'approval_invalidated', approvalId }`). A new approval is then required, **unless** the user chooses `use_preserved_snapshot`: its `run.snapshot_preserved` event (recorded after the invalidation) keeps that approval valid for the preserved inputs (`ApprovalBinding.preservedAfterProjectChange`; plan hash, context hash, and provider are still checked). `APPROVAL_STALE` failures invalidate with `plan_changed` / `provider_changed` as before.
- Check 8's inputs are computed by the caller before the pure check (`loadApprovalBinding`: plan artifact hash, `projectFs.hashFiles` over `run_input_files`, and the approval row).
- Whether the run chose `use_preserved_snapshot` is read from its `run.snapshot_preserved` event (`hasSnapshotPreserved(repos, runId)`, also used by F4 for the context port's `preservedSnapshot`).
- Budget admission is **not** in `checkDispatch`. It happens inside the reservation transaction (F4 step 2), so there is no race between the check and the use. Preflight calls `admit()` read-only for display.

## F7: Retry policy (`src/retry.ts`) — §7.6

```ts
export type RetryClass = 'transport' | 'schema_repair' | 'quality_revision' | 'rate_limit' | 'none';
export function classify(result: ModelResult, validated: ValidationResult | null, puts: ArtifactPut[],
  o: { aborted: boolean; abortReason?: AbortReason }): ClassifiedOutcome;   // { cls, attemptState, error?, usage?, partial?, abortReason? }
// AbortReason = { kind: 'cancel' } | { kind: 'deadline' }. runEventFor maps a deadline abort to LIMIT_REACHED(deadline).
export function nextAttemptPlan(step: StepRow, outcome: ClassifiedOutcome, policy: RetryPolicy, now: EpochMs)
  : { kind: 'succeed' } | { kind: 'retry'; purpose: AttemptPurpose; counter: RetryCounter; notBeforeAt: EpochMs | null }
  | { kind: 'fail'; error: AppError } | { kind: 'hold'; error: AppError } | { kind: 'unknown'; error: AppError };
export function nextPurpose(step: StepRow, attempts: AttemptRow[]): AttemptPurpose;   // derived from the step's latest attempt
```

Retry limits are read from the **step snapshot's `retryPolicy`** (`transport`, `schemaRepair`, `rateLimitWaits`; defaults `RETRY_DEFAULTS_PER_STEP` = 1 / 1 / 3), never from constants (R3-9). The counters live on the step row (`transport_retries_used`, `schema_repairs_used`, `rate_limit_waits_used`) and persist across restarts.

**Backoff (R4-22).** A retry sets `step_runs.not_before_at`. `StepRepo.listEligible` filters `not_before_at IS NULL OR not_before_at <= now`, and the loop sleeps (injected timers) until the earliest `not_before_at` or a wake signal. No retry ever sleeps inside `executeModelAttempt`.

| Result | Class | Limit (snapshot `retryPolicy`) | Step | Run event (when exhausted / immediate) |
|---|---|---|---|---|
| `PROVIDER_UNAVAILABLE` with phase `not_sent`, or a 5xx **before any body byte** (04 R4-8) | transport | `transport` (default 1) | `ready`, purpose `transport_retry`, `not_before_at = now + 2 s`; exhausted → `failed` | `TRANSPORT_EXHAUSTED` → `paused(provider_unavailable)` |
| Other known provider errors with phase `responded` (non-retryable 4xx, **including** MODEL_UNSUPPORTED from 400/404/422 and CONTEXT_TOO_LARGE from 413) | none | – | `failed` | `TRANSPORT_EXHAUSTED` → `paused(provider_unavailable)`: retry_step / choose_profile (→ `runs.retryStep { profileId }` on the failed step) / stop (ruling BH-1) |
| `RATE_LIMITED` (incl. 529) | rate_limit | `rateLimitWaits` (default 3) | `ready`, same purpose as the rate-limited attempt, `not_before_at = now + min(retryAfterMs ?? 2 s, 60 s)`; exhausted → stays `ready` | `RATE_LIMIT_EXHAUSTED` → `paused(rate_limited)` |
| `AUTH_REQUIRED` (401/403, or no credential) | none | – | `ready` | `AUTH_FAILED` → `paused(auth_required)` immediately |
| `REQUEST_OUTCOME_UNKNOWN`: phase `sent_no_response` or `responded_partial` (incl. a mid-stream SSE error or a connection drop, 04 R3-6), abort after dispatch, or an adapter throw | none | **never auto-retried** | `unknown`; attempt `unknown`; `move_to_unknown` N | `UNKNOWN_OUTCOME` → `paused(unknown_outcome)`. Waits for `runs.decideUnknown` (§7.5, §7.6). `interrupted` is reserved for a lost runner (F9) |
| `truncated`, Zod-invalid, or semantically invalid output (`OUTPUT_INVALID`) | schema_repair | `schemaRepair` (default 1) | `ready`, purpose `schema_repair` (the prompt appends the validation issues, 07 §G3 repair block); exhausted → `failed` | `OUTPUT_INVALID_EXHAUSTED` → `paused(output_invalid)` |
| `refused` | none | – | `failed` with `MODEL_REFUSED` | `MODEL_REFUSED` → `paused(model_refused)` |
| `MODEL_UNSUPPORTED`, `CONTEXT_TOO_LARGE`, `PERMISSION_DENIED` (policy / context assembly, **before any attempt**) | none | – | `ready` (never dispatched) | `SETUP_BLOCKED` → `paused(setup_blocked)`. `setup_blocked` is only for these pre-dispatch configuration problems (BH-1); a failed step is never paused `setup_blocked` (`runs.retryStep` still accepts one left so by an earlier build) |
| verify outcome `revise` | quality_revision | `maxRevisionCycles` (2) | F10 revision loop | – |
| Invariant violation / internal error outside an attempt | – | – | – | `UNRECOVERABLE` → `failed` |

A transport retry is allowed **only** when the phase is `not_sent`, or when the adapter reported a 5xx before any body byte (phase `responded`, no `firstByteAt`). `responded_partial` and `sent_no_response` are always unknown (R3-6 / R4-8).

**Exhausted retries pause the run, never fail it (R3-1).** The step goes → `failed`, and the run → `paused(output_invalid | provider_unavailable)`. The user then chooses `retry_step`, `choose_profile`, or `stop`.

**`runs.retryStep({ runId, stepId, profileId? })`** is allowed **only when the step's latest row is `failed`**: on `paused(output_invalid | provider_unavailable | model_refused)`, and on `paused(unknown_outcome)` once no unknown attempt remains and the step is `failed`. Any other step state → `CONFLICT`. Budget and setup pauses (step still `ready`) change profile through `runs.resume({ kind: 'switch_profile' })` instead. In one transaction it:
1. validates `profileId` when given. The profile must be permitted: its provider ∈ project policy and `checkProfile` passes against the snapshot capabilities resolved **before** the tx. On success it appends `run_config_revisions` (reason `model_refused` or `user_switch`) and emits `run.config_revised` (R3-13). The effective profile is the latest revision, and historical attempts and ledger entries are never rewritten.
2. inserts a new step row with `retry_index + 1`, state `ready`, and fresh counters (R4-20). The first attempt on that new row uses purpose `user_retry` (`nextPurpose` returns `user_retry` for a row with `retry_index > 0` and no attempts yet).
3. applies `RESUME_RESOLVED`.

It returns `LIMIT_REACHED` when `attemptCount ≥ maxAttempts` (the user must `raise_limits` first).

**Unknown decisions (`runs.decideUnknown`)**, allowed on `paused(unknown_outcome)` and `interrupted`:
- `retry_acknowledging_charge`: the old attempt → `abandoned` (liability kept, R4-28), and the step `unknown → ready` (next purpose `user_retry`, `retry_of_attempt_id` = the old attempt).
- `mark_failed_keep_liability`: the attempt → `abandoned`, and the step → `failed`.
- `accept_estimated_charge`: `resolve_unknown −N` plus `settle +N (estimated)`, the attempt → `failed` (`details.chargeAccepted = true`), and the step → `failed`.

On `paused(unknown_outcome)`, deciding the last unknown attempt emits `RESUME_RESOLVED` if its step is `ready`. Otherwise the run stays paused and offers `retry_step` / `choose_profile` / `stop`.

All retries create a **new attempt row** (§7.5, "never overwrite the previous attempt"), and all of them consume the run allowance.

## F8: Output validation (`src/steps/validate-output.ts`)

Validation uses observable checks only (§7.7). Model-reported confidence is never used. `validateOutput(stepSnap, json, inputs, templates)` is **pure and synchronous**. `inputs` holds the pre-loaded file contents from the run's `input_file` snapshot artifacts, never the live disk: before the call, the caller loads `RunRepo.inputFiles(runId)` joined with each file's `artifacts` row and calls `ArtifactStore.readSnapshot({ artifactId, storeRelPath, sha256 })` (05 `InputFileRef`, R4-6) per unique artifact. Output schemas come from `@relay/contracts` `outputs/*` via the templates re-export (R2-9).

| Schema | Zod | Semantic checks (after Zod) |
|---|---|---|
| `findings.v1` | yes | every `sourceRefs[].relPath` ∈ the run's input files; line ranges within the file's line count |
| `plan.v1` | yes | every `fileScope[]` ∈ input files (P0 patches only touch provided files); steps count 1..12 |
| `patch.v1` | yes | every file ∈ approved plan `fileScope`. Each `unifiedDiff` parses (`diff.parsePatch`) **and applies cleanly** (`diff.applyPatch`) to the **snapshot** content of that file ("patch parses", §7.7). No file outside scope |
| `review.v1` | yes | `outcome ∈ {accept, revise, incomplete}`. If `revise`, `requestedChanges.length ≥ 1` |

A failed semantic check becomes `OUTPUT_INVALID` with `details.issues: ValidationIssue[]`, and it counts against `schema_repair`.

**Never accepted unverified (BH-7).** An input file whose snapshot cannot be read or verified (missing artifact row, unreadable file, sha mismatch) is listed in `ValidationInputs.unavailable`; a findings line-range check or a patch apply check on it fails with issue `snapshot_unavailable` (OUTPUT_INVALID). Only a diff-input run's path-only names skip the content checks. Two `patch.v1` `files[]` entries for the same `relPath` are OUTPUT_INVALID (`duplicate_file`: each diff would apply to the snapshot alone). `isRevision` (APPROVAL_STALE `scope_changed` instead of OUTPUT_INVALID `outside_approved_scope`) is `run.revisionCycle > 0` — the quality-revision cycle under the current approval — never the step row's `revision_index` (a replan also bumps that, BH-4).

## F9: Recovery (`src/recovery.ts`) — §4.4, §7.5; runs once at `engine.start()` before the loop

Inside a single transaction per run:

| Found | Action |
|---|---|
| attempt `created` / `reserved` | `release` the reservation. attempt → `failed_before_dispatch`. step `reserved` → `ready` (§7.5 "if no dispatch occurred, release the reservation and return the step to ready"). A `reserved` step is treated like `ready` after the release |
| attempt `dispatching` (**every** one, with or without a response id) | `move_to_unknown` N. attempt → `unknown`. step `executing` → `unknown` (R4-3) |
| run `running` | `RUNNER_LOST { lastAliveAt }` → `interrupted`; `applyRunEvent` closes the segment with `leaveRunning(id, lastAliveAt)`, never `now` (downtime never counts toward the deadline; ruling B1). `lastAliveAt` = the lease `heartbeat_at` when readable, else the latest of the run's `running_since` / `updated_at`, its attempts' timestamps, and its last event `at` (computed before recovery writes), capped at `now`. The current `LeaseRepo` has no read of the previous owner's heartbeat (acquire overwrites it), so the engine uses the latter |
| run `cancelling` | `RUNNER_LOST` → `cancelled`. Non-terminal steps → `skipped`. The report is generated after commit (F17) |
| run `awaiting_approval`, `paused`, `queued` | unchanged. Waiting for approval is durable state (§7.3) |
| step `succeeded` | **never touched**. Completed steps are not re-executed (FR-07) |

After recovery, every non-active attempt has `attemptBalances(attempt).reserved = 0`, and every recovered run has R = 0 ("recovery ledger consistency", asserted in `recovery.test.ts`).

**F9b, the reconcile task.** After `start()` resolves, the task considers **only** attempts in state `unknown` that have a `provider_response_id` and whose snapshot capabilities have `supportsRequestLookup: true` (the adapter implements `reconcile`). For each, it requests a credential (`purpose: 'dispatch'`, the attempt's id) and calls `adapter.reconcile` outside any transaction.

| Reconcile result | Ledger (one tx, one group) | Attempt | Step |
|---|---|---|---|
| `completed` | `resolve_unknown −N` + `settle +X (calculated)` | `reconciled_succeeded` | Validate (F8), and put the raw + canonical artifacts before the tx. Valid → `succeeded` with no new call. Invalid → `ready` (schema_repair) or `failed` per F7 |
| `failed` with usage | `resolve_unknown −N` + `settle +X (calculated)` | `reconciled_failed` | `ready` if the transport budget remains, else `failed` |
| `failed` without usage | `resolve_unknown −N` + `settle +0 (calculated)` | `reconciled_failed` | as above |
| `in_progress` | none | stays `unknown` | Re-poll up to 3 times over 30 s (injected timers), then leave it unknown |
| `not_found` | none | stays `unknown` | unchanged |

The run stays `interrupted` until the user chooses `runs.resume` (`review_recovery`). Relay never auto-resumes after a crash (§4.4 "shows the last completed step and any unresolved request").

**One post-validation outcome function (BH-6).** The reconcile tx classifies the result exactly like the live settle (`validatedOutcome`: valid / invalid_output / scope_changed / artifact_failed; a `failed` answer is a transport failure) and then calls the same `applyPostValidation` as F4 step 7 (`outcome.ts`): the F7 plan and step move (`RECONCILED_*` from `unknown`), the F10 scope rule (APPROVAL_STALE `scope_changed` → approval invalidated, step held `ready`), the revision trigger, and `ledger.overrun`. The resulting BUDGET_OVERRUN / APPROVAL_STALE is deferred (F2 clarification 14) because the run is not `running`. The attempt row records the classified error (OUTPUT_INVALID with issues / PROVIDER_UNAVAILABLE / APPROVAL_STALE), so `nextPurpose` after RECONCILED_RETRY returns `schema_repair` (the prompt carries the G3 repair block) or `transport_retry`, matching the counter that was incremented (BH-5).

## F10: Revision loop & approval reuse (`src/revision.ts`, `src/approvals.ts`) — §12.4 revisionPolicy, §11.3

- After `verify` succeeds with outcome:
  - `accept` → the finalize step → run `ACCEPTED` → `completed`.
  - `incomplete` → finalize → `REVISION_LIMIT { cause: 'verifier_incomplete' }` → `incomplete`.
  - `revise` with `run.revisionCycle < maxRevisionCycles` → `revisionCycle += 1`, new `step_runs` rows for `implement` and `verify` with `revision_index = cycle, retry_index = 0`, and the reviewer's `requestedChanges` passed to the implementer as structured input.
  - `revise` when the limit is reached → finalize → `REVISION_LIMIT { cause: 'revision_limit' }` → `incomplete` (§7.2).
- **Approval reuse rule (§12.4):** a quality revision within the approved scope reuses the approval. The new patch's files must be ⊆ the approved `file_scope_json`, and the plan hash must be unchanged. Any file outside that scope → `APPROVAL_STALE` → `approvals.invalidate(reason: 'scope_changed')` → a new approval is required.
- **Opening an approval** (`steps/approval.ts`): inserts the approval with `plan_hash`, `context_hash`, `file_scope_json`, and `requested_permissions_json = { providers: [effective providerIds of the implement/verify snapshots], tools: [] }` (R3-11), moves the step → `awaiting_approval`, and applies `PLAN_READY`.
- `approvals.decide` (service):
  1. **Idempotency lookup first**, before any hashing: a stored result for the key is replayed.
  2. Load the approval. Compare the input `planHash` and `contextHash` to the stored values *and* to the current plan artifact hash and `run.context_hash`.
  3. Re-hash the input files (`projectFs.hashFiles`, outside any tx). A mismatch → `PROJECT_CHANGED`, and the approval is invalidated (`project_changed`).
  4. In one decide transaction: CAS-decide the approval, apply the run transition (`approved` / `revision_requested` → `queued`, ruling B2; `rejected` → `cancelled`), append `approval.decided`, and **store the idempotency result**. `revision_requested` creates a new `plan` step row (`revision_index + 1`) with the user's note as structured input, and the planner then re-runs. **This consumes a planner attempt and counts against `maxAttempts`, not against the quality revision count.**
  5. After commit: `hooks.afterApprovalCommit({ stepKey, purpose: null, attemptSeq: 0 })` with `stepKey` = the approval step id (`approve` in `workflow.json`), so the crash spec is `afterApprovalCommit@approve` (F13).
  - **Concurrent duplicates:** two in-flight calls with the same key can both miss the lookup in step 1. The first commits. The second's CAS in step 4 finds the approval already decided and returns `CONFLICT` (`details.reason: 'duplicate_in_flight'`). A later retry with that key replays the stored result via step 1.
- **`resnapshot_and_replan` (ruling for Referee BH-4 + storage follow-up).** On `paused(approval_stale)`: before the tx the input drift is computed; when files changed (files input), they are re-read and re-snapshotted through the tools (`snapshotSelectedFiles`, new `input_file` artifacts; a file that can no longer be read fails the decision with that error). In one tx: `RunRepo.replaceInputFiles` (03 C6), a new `runs.context_hash` (same intake formula), `context.assembled { kind: 'resnapshot', contextHash, changedPaths }` (a fresh snapshot binding: an earlier `use_preserved_snapshot` / preserved approval no longer applies), approvals invalidated `plan_changed`, new `plan` + downstream rows, **`revision_cycle` reset to 0** (quality-revision cycles count under one approval; the new approval starts fresh), and RESUME_RESOLVED. The new approval binds the new plan hash and context hash.
- **The planner can never approve its own plan (M2 checklist).** The approval step has no model handler. Only `approvals.decide` from IPC advances it, and the IPC op is only reachable from the renderer.

## F11: Cancellation & pause (`src/cancellation.ts`) — FR-11, §9.5

`CancellationRegistry` maps `runId → Set<AbortController>` (`register(runId, attemptId)`, `unregister(controller)`, `abortRun(runId, reason)`, `hasInFlight(runId)`).

- `runs.cancel`:
  - `queued` or `awaiting_approval` → `CANCEL_REQUESTED` → `cancelled`.
  - `paused` or `interrupted` → `STOP_REQUESTED` → `cancelled`.
  - `running` → `CANCEL_REQUESTED` → `cancelling` (the deadline segment ends), then `abortRun(runId, { kind: 'cancel' })`.

  The in-flight attempt settles through F4 step 7, which always commits the ledger and the attempt state:
  - Aborted before `generate` → `release` (attempt `failed_before_dispatch`).
  - Aborted after dispatch → `move_to_unknown` of the full N (honest charge status).
  - A complete response that raced the abort → settled normally.

  Then the **WORK_STOPPED handler** (`onWorkStopped`, run by the loop once no attempt is in flight) runs **after** settlement. In one tx it sets all non-terminal steps → `skipped` (unknown steps included; their attempts keep the liability), and applies `WORK_STOPPED` → `cancelled`. The report follows (F17). **No new step is dispatched after the cancel request** (the F4 step-2 and step-3 transactions re-read the run status). After cancellation the run's R = 0.
- `runs.cancel` returns `unresolvedCharges`, which lists every attempt with unknown liability.
- `runs.pause` sets the durable **`runs.pause_requested`** column and, after commit, **wakes the loop** (ruling B9: a backoff `wait_until` or idle sleep ends immediately; every loop sleep is interruptible by the wake signal) (`RunRepo.setPauseRequested(id, true)`, 03 R2-12). The loop checks it at the top of every iteration, and the F4 step-2 tx checks it before every reservation, applying `USER_PAUSE` → `paused(user)`. An in-flight call completes normally first. The response `inFlight` is `'waiting'` when `hasInFlight(runId)`, else `'none'`. The flag is cleared by `applyRunEvent` on `USER_PAUSE`, `RESUME_RESOLVED`, and terminal transitions.

## F12: Deadline (`src/deadline.ts`) — §9.1 "elapsed execution time"

- **Execution time accrues only while `running`** (R3-5). `applyRunEvent` calls `RunRepo.enterRunning(id, now)` on every transition into `running` and `leaveRunning(id, now)` on every transition out of it, which adds the segment to `execution_ms_used`. Time spent `awaiting_approval`, `paused`, `queued`, or `interrupted` never counts.
- `deadlineReached(run, now) = execution_ms_used + (running_since ? now − running_since : 0) ≥ executionTimeoutSeconds × 1000`. It is checked by F6 #6 and inside the F4 step-2 tx.
- **The timer arms per running segment.** On entering `running`, a post-commit effect arms `timers.setTimeout(remainingMs)`. On leaving `running`, it is cleared.
  - When it fires with an attempt in flight, `DeadlineWatcher` aborts the registered controllers with reason `{ kind: 'deadline' }`. The attempt settles as in F11, and the step-7 tx applies `LIMIT_REACHED { reason: 'deadline' }` → `paused(deadline)`.
  - When it fires with nothing in flight, the watcher applies `LIMIT_REACHED(deadline)` in its own tx.
- `RunDetail` carries `executionMsUsed` (= `execution_ms_used`, closed segments only); there is no deadline timestamp. Remaining execution time = `executionTimeoutSeconds × 1000 − execution_ms_used − (running_since ? now − running_since : 0)` (the current open segment). The renderer computes it the same way from `limits`, `executionMsUsed`, and `status`, and it never decreases while the run is not `running`.
- **`raise_limits`** (`runs.resume({kind:'raise_limits', maxAttempts?, executionTimeoutSeconds?})`) on `paused(limit_attempts | deadline)`:
  - Validates each new value ≤ `RUN_LIMIT_MAXIMUMS` and strictly above what is already used (`attempt_count`, `execution_ms_used / 1000`).
  - Writes the new `limits_json` in the same CAS as `RESUME_RESOLVED` and appends `run.limits_raised`.
  - Else returns `VALIDATION_FAILED`.

## F13: Runner loop (`src/runner.ts`) and test hooks

```ts
async function loop() {
  while (!stopping) {
    const run = pickNext();                       // one active run (§9.1 concurrency 1): running or cancelling, else the oldest queued
    if (!run) { await wake.wait(IDLE_MS); continue; }
    if (run.status === 'queued') { runChecks(run); continue; }                  // → CHECKS_PASSED or SETUP_BLOCKED
    if (run.status === 'cancelling') { if (!cancellation.hasInFlight(run.id)) await onWorkStopped(run); continue; }
    if (run.pauseRequested) { applyRunEventTx(run, { type: 'USER_PAUSE' }); continue; }
    const next = selectNextStep(steps(run), now());  // pure: latest (revision_index, retry_index) per step_key; dependsOn; not_before_at
    switch (next.kind) {
      case 'step':
        switch (handlerKind(next.step)) {         // 'intake' / 'finalize' from step_key; otherwise the spec kind (R2-13)
          case 'intake':   await runIntake(run, next.step); break;            // steps/intake.ts
          case 'model':    await executeModelAttempt(ctx, run.id, next.step.id); break;
          case 'approval': openApproval(run, next.step); break;               // steps/approval.ts → awaiting_approval
          case 'finalize': await runFinalize(run, next.step); break;          // steps/finalize.ts
        }
        break;
      case 'wait_until':    await wake.wait(next.at - now()); break;          // earliest not_before_at (backoff)
      case 'blocked_failed': applyRunEventTx(run, eventForFailedStep(next.step)); break;  // safety net after recovery/decisions
      case 'none':          applyRunEventTx(run, { type: 'UNRECOVERABLE', error: errors.internal('no_eligible_step') }); break;
    }
  }
}
```

- `pickNext` / `runChecks` never move a run to `running` while another run is `running` or `cancelling`: `runChecks` re-checks inside its tx and skips `CHECKS_PASSED` otherwise, and `applyRunEvent` asserts it (ruling B2).
- Every logged error or message passes through contracts redaction (ruling B6): `logSafe(err, knownSecrets?)` (`src/log-safe.ts`) renders an error with `redactString` plus exact replacement of the resolved API key, and the engine context wraps `deps.logger` so every event name and field goes through `redactString` / `redactDeep`.
- The loop is woken by commands (start, pause, resume, approval decided, cancel) through an in-process `Signal`, so it doesn't wait out the full idle sleep. All waits use `deps.timers`.
- `runChecks` performs dry-run checks for the next model step: providers permitted, credential refs present, snapshot capabilities, and a read-only `admit` of the step's estimate. It applies `CHECKS_PASSED` or `SETUP_BLOCKED` with the matching reason.
- `eventForFailedStep` maps the failed step's `error_json.code`:
  - `OUTPUT_INVALID` / `ARTIFACT_WRITE_FAILED` → `OUTPUT_INVALID_EXHAUSTED`
  - `PROVIDER_UNAVAILABLE` and other provider errors → `TRANSPORT_EXHAUSTED`
  - `MODEL_REFUSED` → `MODEL_REFUSED`
  - `REQUEST_OUTCOME_UNKNOWN` → `UNKNOWN_OUTCOME`
  - `MODEL_UNSUPPORTED` / `CONTEXT_TOO_LARGE` → `SETUP_BLOCKED`
- Any exception escaping a handler is logged as `INTERNAL` with a correlation id. If the run is still `running`, it gets `UNRECOVERABLE` → `failed`.
- Per-step handlers live in `src/steps/{intake,model,approval,finalize,validate-output}.ts`:
  - **intake** (R4-6): `readSelected` → `ArtifactStore.snapshotInputFiles(runId, files, () => ids.next('artifact'))` (one `input_file` artifact per unique sha within the run; on an intake retry, existing refs come from `ArtifactRepo.findInputFile(runId, sha)`) → in the intake tx, one `artifacts` row per unique sha (kind `input_file`, `rel_path` = `ref.storeRelPath`) and `RunRepo.insertInputFiles(runId, [{ relPath, sha256, artifactId: ref.artifactId, sizeBytes, capturedAt }])`, so every `run_input_files` row carries its `artifact_id` → later readers call `readSnapshot({ artifactId, storeRelPath, sha256 })` → `memory.snapshotForRun(runId, projectId, { includeIds: snapshot.memoryIncludeIds })` → intake manifest → `runs.context_hash`. The step → `succeeded`. Failures (`PERMISSION_DENIED`, `PROJECT_CHANGED`, `CONTEXT_TOO_LARGE`) → `SETUP_BLOCKED`.
  - **finalize**: writes the memory suggestions (G), then `memory.recordRunSummary(runId)` writes one approved `run_summary` record (author `run:<id>`, never mandatory; R3-17). The step → `succeeded`, and the run gets `ACCEPTED` or `REVISION_LIMIT`. The report is produced by the terminal effect (F17).

**Crash hooks (R4-11 / R2-23).** `src/testing/crash-hooks.ts` owns the grammar and the parser:

```ts
export type CrashHookName = 'beforeReservationTx' | 'afterDispatchIntent' | 'afterProviderResponse' | 'afterStepCommit' | 'afterApprovalCommit';
export interface CrashSpec { hook: CrashHookName; stepKey: StepKey; n: number }        // n ≥ 1, default 1
// Grammar: RELAY_CRASH_AT=<hook>@<stepKey>[#<n>]   e.g. afterStepCommit@plan, afterDispatchIntent@review#2
export function parseCrashSpec(value: string): Result<CrashSpec>;                          // VALIDATION_FAILED on bad input
export function parseCrashAt(value: string, o?: { exit?: (code: number) => never }): EngineTestHooks;  // throws RelayError on bad input
export function crashHooksFromEnv(env: NodeJS.ProcessEnv, o?: { exit?: (code: number) => never }): EngineTestHooks | undefined;
```

- The returned hooks count invocations of the named hook whose `ctx.stepKey` matches. On the n-th match they call `exit(137)` (default `process.exit`), so n selects the n-th matching attempt.
- `crashHooksFromEnv` returns `undefined` unless `env.RELAY_E2E === '1'` and `RELAY_CRASH_AT` is set. H7 and K4's child both gate on `RELAY_E2E=1`.
- Hooks receive `{ attemptId?, stepKey, purpose, attemptSeq }`. The five call sites are:

| Hook | Call site |
|---|---|
| `beforeReservationTx` | F4, immediately before the step-2 tx (no `attemptId` yet) |
| `afterDispatchIntent` | F4, after the step-3 tx commits |
| `afterProviderResponse` | F4, after `generate` resolves (or the abort short-circuit) |
| `afterStepCommit` | F4, after the step-7 tx commits |
| `afterApprovalCommit` | `approvals.decide`, after the decide tx commits (`purpose: null`; `stepKey` = the approval step id `approve`, so `afterApprovalCommit@approve`) |

## F14: Workflow validation & profile checks (`workflows.validate`, `workflows.publish`, `src/profiles.ts`)

`checkProfile(profile, catalogEntry | undefined, capabilities)` in `profiles.ts` is the single profile validator. It is used by `profiles.upsert`, F14, F15, `switch_profile`, `runs.retryStep`, and `seedDatabase`. It returns `MODEL_UNSUPPORTED` when:
- the model id is not in the catalog;
- the effort is not in `effortLevels`;
- `structuredOutput` is false;
- `params.maxOutputTokens > capabilities.maxOutputTokens`.

`profilesWithWarnings(): { profile: ModelProfile; warnings: CapabilityWarning[] }[]` in `profiles.ts` serves `profiles.list` (02 B5). For each profile it resolves the latest catalog entry and the credential state, runs `checkProfile`, and maps each failure to a `CapabilityWarning` (`profileId` set, `stepKey: null`; codes `model_unknown`, `effort_unsupported`, `structured_output_unsupported`, `output_budget_low`, `missing_credential`). An empty `warnings` array means the profile passes. The renderer (10 J10) displays these results and does not re-check.

Workflow validation combines `validateWorkflowGraph` (contracts) with catalog and credential checks per step:
- The profile exists, and `checkProfile` passes.
- A credential exists (a warning, not an error, for drafts; an error for `runs.preflight`).
- The approval step precedes implement.
- The budget can afford at least the first step's upper bound ("impossible token budgets", §5.3).
- `retryPolicy` values are ≤ `MAX_RETRY_POLICY`.

Each issue carries a field path (`steps[3].maxOutputTokens`) matching the mock's error summary anchors.

## F15: `runs.start` service (FR-03 snapshot)

**Before the transaction (async, R4-29):**
1. Resolve the workflow version. It must be `validated`.
2. For every model step, resolve the effective profile: `profileOverrides[stepKey] ?? spec.profile` (R2-26).
   - Override keys must be model step keys of this workflow (else `VALIDATION_FAILED`), and the profile's provider must be permitted by the project.
   - Resolve the catalog entry (prices) and `adapter.capabilities(modelId)` **here**, outside the tx, then run `checkProfile`.
3. Build `snapshot_json = { steps: { [stepKey]: StepSnapshot }, workflowContentHash, catalogVersion, memoryIncludeIds }`.
   - `StepSnapshot = { kind, role, profile: ProfileSnapshot (with capabilities and prices, R2-10/R2-11), outputSchema, outputKind, instructionVersion, maxOutputTokens, retryPolicy, memoryScope }`.
   - `memoryIncludeIds` = `memoryRecordIds` (approved records to include; pinned rules are always included).
4. Compute the limits: workflow limits ⊕ `limitOverrides`, bounded by `RUN_LIMIT_MAXIMUMS`.

**In one transaction:**
1. Idempotency lookup. A replay returns the stored `{ runId, status }`.
2. Insert the run as `queued`.
3. Insert the step rows, all `pending`, `revision_index 0`, `retry_index 0` (R2-13):
   - a synthetic `intake` row at ordinal 0;
   - the spec steps at ordinals 1..n;
   - a synthetic `finalize` row at ordinal n+1, depending on the last spec step.
4. Write the `allowance_set` ledger entry `+L`.
5. Store the idempotency key and append `run.created`.

The intake step (F13) later snapshots the input files into `run_input_files`; that set changes only through `resnapshot_and_replan` (F10, `RunRepo.replaceInputFiles`), which also recomputes `context_hash`.

Then signal the loop. Preflight uses the same code path with `dryRun: true` and stops before the transaction. **Its first-reservation N (ruling B7)** is computed exactly like dispatch: the same prompt rendering as the context assembler (`renderStepPrompt`: role instructions + output contract, goal, constraints, diff block, file blocks in `run_input_files` order), `buildModelRequest` (output schema, `maxOutputTokens`, `refusalFallback`), and `adapter.estimate` (request overhead, billed hops, allowance prices). Without a key the adapter's local estimate is used, so preflight N equals the first attempt's reservation for the same inputs.

**Config revisions (R3-13).** The snapshot is revision 0 and is never mutated. Every later profile change (`switch_profile`, `runs.retryStep{profileId}`) appends a `run_config_revisions` row and emits `run.config_revised`. `effectiveStepSnapshot` = the latest revision for that step key, else the snapshot entry. Historical attempts keep their own `profile_snapshot_json`.

## F16: Runtime & seed (`src/runtime.ts`, `src/seed.ts`) — the Electron-free composition root

```ts
export interface RuntimeOptions {
  userDataDir: string;
  providerMode: 'live' | 'fake';
  fakeScenario?: string | FakeScenario;      // FAKE_SCENARIOS key or an inline scenario (K2/L scripted variants); fake mode only
  fakeExtraFixtures?: Record<string, unknown>; // extra success fixtures keyed by name (K2 variants); fake mode only
  credentials: CredentialResolver;
  hooks?: EngineTestHooks;
  callLog?: FakeCallLog;                     // @relay/providers createJsonlCallLog(...)
  clock?: Clock;                             // default system clock
  fakeCapabilityOverrides?: Partial<ModelCapabilities>;
  emit?: (e: PushEvent) => void;             // default no-op (H forwards to main)
  logger?: Logger;                           // default: JSON logger to stderr
  timers?: Timers;                           // default: global timers (K/L pass manual timers)
  templates?: TemplateRegistry;              // default: the bundled @relay/templates registry; used by seedDatabase and the engine
  isPidAlive?: (pid: number) => boolean;     // passed to openDb (03 C4 OpenDbOptions); default process.kill(pid, 0), EPERM ⇒ alive
}
export interface Runtime {
  engine: EngineApi; db: Db; projectFs: ProjectFsPort; artifacts: ArtifactStore; providers: ProviderRegistry;
  dispose(): Promise<void>;
}
export async function createRuntime(o: RuntimeOptions): Promise<Runtime>;
```

`createRuntime` composes, in order:
1. `openDb({ path: join(userDataDir, 'relay.sqlite'), clock, ids, backupsDir, isPidAlive })`, with embedded migrations (03 R4-32).
2. `const templates = o.templates ?? bundledTemplateRegistry`; `seedDatabase(db, { catalog: loadCatalogEntries(), templates })`.
3. `createProviderRegistry({ mode: providerMode, fakeScenario, clock, timers, callLog, fakeCapabilityOverrides, extraFixtures: fakeExtraFixtures, logger })` (04 §D8).
4. `createArtifactStore({ userDataDir, clock })`.
5. `projectFs` (wrapping `@relay/tools`).
6. `createMemoryService(...)`, then `createContextAssembler(...)`.
7. `createEngine({ ..., templates, maintenance: { sweepRawResponses } })` (the same `templates` registry as step 2).

It does **not** start the engine. Callers run `await runtime.engine.start()`. `dispose()` calls `engine.stop({ graceMs: 5000 })` and then `db.close()`. H7's runner entry, K's crash child and harness, D9b's live workflow test, and M's scripts all import `createRuntime` from `@relay/engine`. This is the only engine file that value-imports storage, providers, and tools.

`seedDatabase(db, { catalog, templates })` (R2-19) is **idempotent**. A second call writes nothing. It runs in one transaction:
- `catalog.upsertMany(entries)`, keyed by version, so old versions are never edited.
- For each `templates.seedVersions()` entry: `ensureWorkflow`, then insert version 1 if absent. It first validates the spec with `workflowSpecSchema` and checks that every `instructionVersion` resolves to a prompt, then marks the version `validated`.
- Default profiles **Economy / Balanced / Capable** (`DEFAULT_PROFILES` in `seed.ts`: provider, catalog model id, params). Each is inserted only if no profile with that name exists. Each is checked with `checkProfile` against its catalog entry and written with `capabilities_snapshot_json` and `catalog_version` (03 R3-12).

## F17: Run report (`src/report.ts`) — R3-14

- `generateReport(ctx, runId): Promise<Result<ArtifactId>>` builds a `report.v1` object (schema in contracts `outputs/report.v1`). It includes:
  - the goal, final status, and outcome;
  - per-step status and output artifact refs;
  - approval decisions;
  - ledger totals by certainty, plus unresolved unknown charges;
  - revision cycles;
  - `limitations` text constants supplied by G.

  It stores the report as a `report` artifact (canonical JSON, not redacted) and appends `report.created`.
- It runs as a post-commit effect of **every** terminal transition (`completed`, `incomplete`, `cancelled`, `failed`), including terminal transitions made by recovery.
- It is idempotent: if a `report` artifact already exists for the run, it returns that id. `engine.start()` regenerates missing reports for terminal runs, which covers a crash between the terminal commit and the report write.
- `renderReportMarkdown(report): string` is a pure Markdown renderer, used by `artifacts.exportTo` (`what: 'report'`).

## F18: Setup calls (`src/setup-calls.ts`) — the `providers.test` handler (R3-7, FR-02)

`testProviderConnection(ctx, { providerId, modelId? })`:
1. Resolves the credential (`purpose: 'connection_test'`, `attemptId: null`). If it is missing → `AUTH_REQUIRED`.
2. Computes N as the upper bound of the tiny test request (`max_tokens: 16`) at the chosen model's catalog prices. The model is the cheapest catalog model for the provider unless one is given.
3. **Admission + reserve** in one tx:
   - `admitSetup({ setup: LedgerRepo.setupBalances(monthStart, monthEnd), L: settings.setupAllowanceMicrousd ?? SETUP_ALLOWANCE_MICROUSD, N })`, where C + R + U + N ≤ L over the month's `scope='setup'` entries.
   - If blocked, it returns `BUDGET_BLOCKED` with the breakdown and makes no call.
   - Otherwise it appends `reserve +N` with `scope='setup'`, `run_id` NULL, and `attempt_id` NULL.
4. Calls `adapter.testConnection({ apiKey, signal, modelId })` outside the tx, with a 15 s abort timer.
5. **Settle** in one tx (same group):
   - known usage → `release −N` + `settle +X (calculated)`;
   - not sent / no usage → `release −N`;
   - outcome unknown (phase `sent_no_response` / `responded_partial`, an abort after dispatch, or **`REQUEST_OUTCOME_UNKNOWN` in any phase**, e.g. a gateway's `responded` answer; BH-3) → `move_to_unknown` N, which stays as setup liability; the result's `certainty` is `unknown`.
   - It also records `CredentialRefRepo.recordTest(providerId, ok, code, at)`.
6. Returns the 02 `providers.test` output shape `{ ok, latencyMs, modelProbed, error?, costMicrousd, certainty }` (`modelProbed` = the model id used; `error` is the `AppError` when `ok` is false).

## Unit tests (owned by F; colocated; engine tests use `openTestDb()` + `createFakeProvider` + temp-dir tools via `src/testing/harness.ts`)

**Timers (R4-36).** Fake time is applied **only** to the injected `deps.timers` and `deps.clock` (`src/testing/manual-timers.ts`: `createManualTimers()` + `advance(ms)`). Tests never call `vi.useFakeTimers()` globally, because that would also freeze SQLite busy handling and the fake provider's own scheduling.

| File | Must cover |
|---|---|
| `run-machine.test.ts` | Every row of the F2 table, including `LIMIT_REACHED`, `OUTPUT_INVALID_EXHAUSTED`, `TRANSPORT_EXHAUSTED`, `MODEL_REFUSED`, `BUDGET_OVERRUN`, and `UNKNOWN_OUTCOME`. Every other (status, event) pair → ILLEGAL (a generated matrix). One `it()` per §7.2 clarification. The `allowedRunActions` truth table for **every** `PAUSE_REASON` and status, including `decide_unknown` only when `unknownAttempts > 0` and `export_patch` only with a patch. `applyRunEvent`: enter/leave running accrual, `pause_requested` cleared, effects not run on rollback |
| `step-machine.test.ts` | Every F3 row. Terminal steps immutable. No transition targets `validating` in the DB |
| `budget.test.ts` | §9.4 example: L=3.00, C=1.20, R=0.40, U=0, N=1.50 → blocked, total 3.10. Equality allowed. Project-month block independent of run. Project month: C filtered by the window, R and U not date-filtered. `admitSetup`. `settlementEntries` for every row of the F5 table. `fast-check`: for any sequence of admitted reservations, `C+R+U ≤ L` holds **at admission time** |
| `policy.test.ts` | Each F6 check in isolation and the order of failure. Provider changed after approval → `APPROVAL_STALE` `provider_changed`. `use_preserved_snapshot` skips the input-hash comparison only |
| `retry.test.ts` | The F7 table. Limits come from the snapshot `retryPolicy` (a step with `transport: 0` never retries). Transport retry only for `not_sent` or a 5xx before body; `sent_no_response` and `responded_partial` → unknown. Rate-limit wait capped at 60 s, `rate_limit_waits_used` persisted. Backoff sets `not_before_at` (no sleep in F4). Exhausted schema repair / transport → step `failed`, run `paused(output_invalid / provider_unavailable)`, **never** run `failed`. Unknown never auto-retries |
| `retry-step.test.ts` | `runs.retryStep` on a failed step inserts a **new row** (`retry_index + 1`, fresh counters) and leaves the failed row intact; its first attempt has purpose `user_retry`. `runs.retryStep` on a `ready` step (e.g. `paused(budget_run)`) → `CONFLICT`; `switch_profile` on that pause writes a config revision and resumes. `selectNextStep` and `dependsOn` use the latest row. `profileId` → permitted check, a `run_config_revisions` row, a `run.config_revised` event, and historical ledger unchanged. `LIMIT_REACHED` at `maxAttempts` |
| `checkpoints.test.ts` | Happy path writes rows in the F4 order (spy on repos). Missing credential → no attempt row, `paused(auth_required)`. `pause_requested`, a cancelling run, or `attemptCount = maxAttempts` observed **inside** the step-2 tx → no attempt row. `seq` and `request_fingerprint` set in the step-2 tx. Provider not called if the dispatching tx throws. Abort before `generate` → `failed_before_dispatch` + release. `generate` throws → attempt `unknown` (never `dispatching`). Raw artifact `text/plain` for non-JSON and `application/json` otherwise (redacted), canonical output (not redacted), and manifest all written before the step-7 tx and keyed `(attempt, kind, sha)`. Step no longer `executing` → ledger + attempt committed, step untouched. `metadata.stepKey` / `purpose` set. Crash hooks invoked in order with `{attemptId, stepKey, purpose, attemptSeq}`. Settlement group atomic (inject a throw mid-tx → no partial entries). **Overrun:** X > N with L ≫ X → `paused(budget_overrun)`, and `acknowledge_overrun` → queued |
| `recovery.test.ts` | Each F9 row, using DB states crafted directly through repos. **Every** `dispatching` attempt → `unknown` with `move_to_unknown` (with and without a response id). F9b only on `unknown` attempts with lookup support: completed / failed with usage / failed without usage (settle 0 calculated) / in_progress / not_found. **Recovery ledger consistency:** after recovery R = 0 for every recovered run, and each attempt's `attemptBalances` matches its state. Deadline accrual stops at the last heartbeat |
| `revision.test.ts` | revise→revise→limit → incomplete. Verifier `incomplete` → incomplete. Scope expansion invalidates the approval. Unchanged scope reuses the approval |
| `approvals.test.ts` | Stale plan hash → `APPROVAL_STALE`. File changed on disk → `PROJECT_CHANGED`. `requested_permissions_json.providers` recorded at creation. Double decide → `CONFLICT`. Idempotency lookup happens before `hashFiles` (spy), and the store happens in the decide tx. Concurrent duplicate → `CONFLICT` then replay. `afterApprovalCommit` fires after commit. Planner path cannot call decide (there is no handler) |
| `cancellation.test.ts` | Cancel during `hang` → abort → attempt `unknown` (not `dispatching`), U = N, **R = 0**. Steps skipped only in the WORK_STOPPED handler, after settlement. Cancel between steps → no further dispatch. Pause lets the in-flight call finish, then `paused(user)`. Cancel of a paused run → `cancelled` and report generated |
| `deadline.test.ts` | **Deadline not counted during approval:** 20 min `awaiting_approval` on manual timers → no deadline, and `execution_ms_used` unchanged. The deadline fires during a `hang` → `paused(deadline)`, full N unknown. `raise_limits` above the used amount → queued; at or below it → `VALIDATION_FAILED` |
| `profiles.test.ts` | Invalid model id → `MODEL_UNSUPPORTED`. Unsupported effort → `MODEL_UNSUPPORTED`. `maxOutputTokens` above capability → `MODEL_UNSUPPORTED`. `profilesWithWarnings()` returns `[]` warnings for a valid seeded profile and the matching `CapabilityWarning` codes (`effort_unsupported`, `missing_credential`) for a broken one |
| `seed.test.ts` | Seeds catalog, template v1 (`validated`, prompts resolvable), and 3 default profiles with capability snapshots. Second call is a no-op (row counts unchanged) |
| `runtime.test.ts` | `createRuntime` on a temp `userDataDir` in fake mode opens, migrates, and seeds. `engine.start()` acquires the lease, and `dispose()` closes the DB |
| `report.test.ts` | A `report.v1` artifact for each terminal status (completed, incomplete, cancelled, failed). Idempotent. Missing report regenerated at start. Markdown renderer snapshot (byte stability) |
| `setup-calls.test.ts` | Admission over `scope='setup'` entries for the month. `BUDGET_BLOCKED` without a call when exhausted. Settle / release / unknown entries carry `attempt_id` NULL and `certainty` |
| `crash-hooks.test.ts` | Grammar: `afterStepCommit@plan`, `afterDispatchIntent@review#2`, invalid hook / step key / `#0` rejected. The n-th matching invocation calls the injected `exit(137)`. `crashHooksFromEnv` returns `undefined` without `RELAY_E2E=1` |
| `referee-fixes.test.ts` | Referee rulings: B3 lost settlement CAS writes nothing and the stop/restart race settles an attempt once (R never negative); B4 PROJECT_CHANGED at implement invalidates the approval (`project_changed`) unless `use_preserved_snapshot`; B5 fallback iterations priced per model (unknown → provider max, `estimated`); B6 no API key reaches the logger; B7 preflight N = first attempt reservation; B9 `runs.pause` and any wake end a `wait_until` sleep |
| `referee-wave2.test.ts` | Referee Wave-2 rulings: BH-1 responded 4xx → step failed + `paused(provider_unavailable)`, retry_step / choose_profile (→ retryStep) resume, plus the every-`PAUSE_REASON` RESUME_RESOLVED invariant; BH-2 reconciled overrun → `budget_overrun` (also deferred past a remaining unknown); BH-3 setup `REQUEST_OUTCOME_UNKNOWN` in any phase → setup liability; BH-4 replan resets the revision cycle (first implementation after it is OUTPUT_INVALID, not APPROVAL_STALE); `resnapshot_and_replan` with changed files; BH-5 reconciled retry purpose + repair block; BH-6 reconciled scope change → approval invalidated + `paused(approval_stale)`; BH-7 `snapshot_unavailable` and `duplicate_file` |
| `engine.test.ts` (tagged `@m2`) | Full template on the fake `happy-path` scenario: final statuses, **4 model attempts** (review, plan, implement, verify), synthetic intake/finalize rows succeeded, ledger totals equal fake prices × fixture usage, and the report artifact exists |

## Success Criteria (gate)
- [ ] `pnpm typecheck && pnpm test:unit packages/engine --coverage --coverage.include='packages/engine/src/**'` → green, ≥ 90% lines on F files
- [ ] `pnpm lint` → exit 0 (no electron/sqlite imports; no value imports of storage/providers/tools outside `runtime.ts`, tests, and `src/testing/**`)
- [ ] `grep -rn "tx('immediate', async" packages/engine/src | wc -l` → 0
- [ ] `grep -rn "vi.useFakeTimers" packages/engine/src | wc -l` → 0 (only injected timers)
- [ ] `grep -rn "from './testing" packages/engine/src/index.ts` matches only `./testing/crash-hooks`
- [ ] `pnpm test:unit packages/engine -t "@m2"` → green (4 model attempts)
- [ ] `pnpm --filter @relay/tests exec node --conditions=development --import tsx --input-type=module -e "import {createRuntime} from '@relay/engine'; const r=await createRuntime({userDataDir: process.argv[1], providerMode:'fake', credentials:{resolve:async()=>({ok:true,value:'test-key'})}}); await r.engine.start(); await r.dispose()" "$(mktemp -d)"` → exit 0

## Review Checklist
- [ ] Every §7.2 edge is implemented, and **every** added edge and trigger in the F2 "Clarifications of §7.2" list is tested and logged as a clarification in 14
- [ ] `allowedRunActions` covers every `PAUSE_REASON`, and every paused state has at least one non-stop action that leads to `RESUME_RESOLVED`
- [ ] Run status `failed` is reachable only via `UNRECOVERABLE`. Exhausted retries and refusals pause
- [ ] F4: credential before estimate and before any attempt row. Step-2 tx re-checks status, `pause_requested`, and attempts. AbortController registered before the step-3 tx. `try/finally` guarantees no attempt is left `dispatching` in-process
- [ ] Recovery moves every `dispatching` attempt to unknown. F9b touches only `unknown` attempts
- [ ] Every §17.1 scenario that is engine-level has a unit or integration test (cross-check with 11)
- [ ] No path lets model output raise limits, approve, or change providers
- [ ] Settlement never caps actual cost (§9.5), and an overrun always pauses as `budget_overrun`
- [ ] The deadline accrues only while `running`
- [ ] `PAUSE_REASONS` includes `unknown_outcome` and the `UNKNOWN_OUTCOME` transition is tested
- [ ] Crash hooks: all five are invoked at their named call sites, and they are active only with `RELAY_E2E=1`

## Wave 2 implementation clarifications (Agent F)

Recorded where the implemented APIs or later orchestrator rulings refine the text above:
- **F6 #7** compares only the counter of the attempt's purpose (`transport_retry` → transport, `schema_repair` → schemaRepair; rate-limit waits always), error `LIMIT_REACHED{reason:'retry_policy', purpose}` → the matching exhausted event. **#8** also compares the live input hashes (`changedInputs`, skipped after `use_preserved_snapshot`); PROJECT_CHANGED details carry `{changedPaths, before, after}`. **#9** is `0 ≤ limits.maxToolCalls` (`LIMIT_REACHED(tool_calls)` → `SETUP_BLOCKED`).
- **F8** inputs come from `steps/validation-inputs.ts` (snapshot contents + approved scope). A patch file outside the approved scope is `OUTPUT_INVALID(outside_approved_scope)` on the first implementation and `APPROVAL_STALE(scope_changed)` on a quality revision (F10 reuse rule: approval invalidated `scope_changed`, step held `ready`, run `paused(approval_stale)`). Diff-input runs validate paths only (no bytes to apply against). OUTPUT_INVALID details also carry `{schemaId, repairsUsed, repairsMax, rawResponseArtifactId}`.
- **F9b** also auto-emits `RESUME_RESOLVED` for a `paused(unknown_outcome)` run whose last unknown attempt was reconciled and whose steps are not failed (same rule as `runs.decideUnknown`); an `interrupted` run still waits for `review_recovery`. Eligibility uses providers `supportsRequestLookupFor` (injected, `EngineDeps.requestLookup`) with the provider options recorded on the attempt (`estimate_json.providerOptions`, N1). `usageKnown:false` → completed settles N `estimated`; failed keeps the liability (attempt `abandoned`).
- **F10** revision rows are inserted in the verify step-7 (or reconcile) transaction (`revision.ts`); the new implement row's `input_artifact_ids` = the review artifact (the context assembler consuming it is G's Wave 3). `incomplete` runs record `statusDetail = LIMIT_REACHED{limit:'revisions', incompleteCause, revisionCycle?, maxRevisionCycles?}`.
- **resnapshot_and_replan** re-plans (new plan / approval / downstream rows, approvals invalidated `plan_changed`, `revision_cycle` reset to 0) and, when the inputs changed, first re-snapshots them (`RunRepo.replaceInputFiles`, new `context_hash`; see F10). *(Superseded Wave-2 text: changed files used to return `PROJECT_CHANGED{reason:'resnapshot_requires_new_run'}`.)* `use_preserved_snapshot` is accepted only for a `PROJECT_CHANGED` stale; it re-opens an approval whose row still waits on an invalidated approval, and `approvals.decide` skips the input re-hash afterwards.
- **runs.retryStep** follows this plan (CONFLICT for a non-failed step) over 02's "a ready/pending step keeps its row" wording; budget/setup pauses use `switch_profile`. `runs.increaseAllowance` also writes `limits_json.budgetMicrousd` and requires a strict increase (`VALIDATION_FAILED not_an_increase`).
- **F18** sizes N from providers `connectionTestRequest` (injected `EngineDeps.connectionTestRequest`; OpenAI 256 output tokens), treats `truncated` as a working connection, and recovery moves an orphaned setup reservation to the setup liability at start. `app.createBackup` goes through `EngineDeps.backup` (runtime.ts wraps storage `createBackup` + `toDisplayPath`).
- `attempt.stream_progress` events are persisted (≤ 1 / 500 ms) so the per-run `seq` stays gapless; every step/attempt-scoped event payload carries `stepRunId`.
