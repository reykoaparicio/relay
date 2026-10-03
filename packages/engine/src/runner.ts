// 06 F13 + F1: the runner loop (one active run, §9.1 concurrency 1) and the engine factory. The loop is the queue:
// running/cancelling first, else the oldest queued run. Waits use the injected timers; commands wake the loop.
import { IDEMPOTENCY_TTL_MS, isDatabaseBusyError, RUNNER_HEARTBEAT_MS, RUNNER_STALE_AFTER_MS, RelayError, epochMs, errors, getRunnerOperation, isRelayError, toAppError, toIpc, toValidationIssues } from '@relay/contracts';
import type { EpochMs, IpcResult, RunId, RunnerChannel, RunnerInputOf, StepKey, ValidationIssue } from '@relay/contracts';
import type { Repos, RunRow, StepRow } from '@relay/storage';
import { logSafe, redactingLogger } from './log-safe.js';
import { createCancellationRegistry, onWorkStopped } from './cancellation.js';
import { executeModelAttempt } from './checkpoints.js';
import { admitAgainstLedger } from './budget.js';
import { createWakeSignal } from './clock.js';
import { createDeadlineWatcher } from './deadline.js';
import type { DeadlineWatcher, EngineApi, EngineCtx, EngineDeps, RunSnapshot } from './ports.js';
import type { ReadinessIssue } from './policy.js';
import { budgetReadiness, checkStepReadiness, minimumReservation } from './policy.js';
import { reconcileUnknownAttempts, recoverOnStart } from './recovery.js';
import { generateReport, isReportStale, refreshReport } from './report.js';
import { eventForFailure } from './retry.js';
import type { PostCommitEffect, RunMachineEvent } from './run-machine.js';
import { appendRunEvent, applyRunEvent, runEffects } from './run-machine.js';
import type { Handler, ParsedInputOf } from './handler-types.js';
import { createHandlers } from './handlers.js';
import { undeclaredErrorCode } from './error-conformance.js';
import { readSettings } from './settings.js';
import { effectiveModelSteps, snapshotOf } from './snapshot.js';
import { applyStepEvent } from './step-machine.js';
import { runFinalize } from './steps/finalize.js';
import { openApproval } from './steps/approval.js';
import { runIntake } from './steps/intake.js';

/** Default idle wait when there is no work (commands wake the loop earlier). */
const IDLE_MS = 1_000;

/**
 * F1 step 4 / 03 C8 (R3-16): the retention sweep runs at boot and then every 24 h (injected timers). It purges raw
 * responses past the retention setting and idempotency rows older than `IDEMPOTENCY_TTL_MS` (02 §B0).
 */
export const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/**
 * E2 #2: waits (ms) before re-running a QUERY whose statement hit a database lock that outlasted the short
 * `busy_timeout`. Each wait yields the event loop (heartbeats keep flowing). Commands are never re-run here (a retry
 * could repeat an earlier committed transaction of the same handler): they return the retryable `database_busy`.
 */
export const QUERY_BUSY_RETRY_DELAYS_MS: readonly number[] = [50, 150, 400];
/** Backoff of the run loop after a tick hit a database lock (the run is left as it is, never failed for it). */
const LOOP_BUSY_BACKOFF_MS = 250;
/**
 * E2 #6: reports regenerated before `start()` resolves (so a crash-lost report normally exists by the time the app is
 * ready); the rest are generated in the background, {@link REPORT_REGEN_PER_BATCH} per batch between idle waits.
 */
const REPORT_REGEN_AT_START = 2;
const REPORT_REGEN_PER_BATCH = 2;

/** What the loop should do next for a running run (pure). */
type NextStep =
  | { readonly kind: 'step'; readonly step: StepRow }
  | { readonly kind: 'wait_until'; readonly at: EpochMs }
  | { readonly kind: 'blocked_failed'; readonly step: StepRow }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'none' };

/** Which handler serves a step: 'intake' / 'finalize' from the snapshot kind, otherwise the spec kind (R2-13). */
export function handlerKind(snapshot: RunSnapshot, stepKey: StepKey): 'intake' | 'model' | 'approval' | 'finalize' | null {
  return snapshot.steps[stepKey]?.kind ?? null;
}

/** Latest-row steps whose dependencies all succeeded and that are still `pending` (DEPS_MET). */
export function stepsToPromote(latest: readonly StepRow[], snapshot: RunSnapshot): StepRow[] {
  const state = new Map(latest.map((s) => [s.stepKey as string, s.state]));
  return latest.filter((s) => s.state === 'pending' && (snapshot.steps[s.stepKey]?.dependsOn ?? []).every((d) => state.get(d) === 'succeeded'));
}

/** Pure F13 `selectNextStep` over the latest row per step key (ordered by ordinal). */
export function selectNextStep(latest: readonly StepRow[], now: EpochMs): NextStep {
  const failed = latest.find((s) => s.state === 'failed' || s.state === 'unknown');
  if (failed !== undefined) return { kind: 'blocked_failed', step: failed };
  const eligible = latest.filter((s) => s.state === 'ready' || s.state === 'reserved');
  const now_ = eligible.find((s) => s.notBeforeAt === null || s.notBeforeAt <= now);
  if (now_ !== undefined) return { kind: 'step', step: now_ };
  const at = eligible.reduce<EpochMs | null>((min, s) => (s.notBeforeAt !== null && (min === null || s.notBeforeAt < min) ? s.notBeforeAt : min), null);
  if (at !== null) return { kind: 'wait_until', at };
  if (latest.some((s) => s.state === 'awaiting_approval' || s.state === 'executing')) return { kind: 'waiting' };
  return { kind: 'none' };
}

/** A run that holds the single execution slot (§9.1 concurrency 1). */
const holdsSlot = (x: RunRow): boolean => x.status === 'running' || x.status === 'cancelling';

/** Pick the one active run: running or cancelling first, else the oldest queued (§9.1). */
export function pickNext(r: Repos): RunRow | undefined {
  return r.runs.listActive().find(holdsSlot) ?? r.runs.nextQueued();
}

async function applyTx(ctx: EngineCtx, runId: RunId, ev: RunMachineEvent, from: RunRow['status'][]): Promise<void> {
  const fx: PostCommitEffect[] = [];
  ctx.db.tx('immediate', (r) => {
    const cur = r.runs.get(runId);
    if (from.includes(cur.status)) applyRunEvent(r, cur, ev, ctx.clock.now(), fx);
  });
  await runEffects(ctx, fx);
}

/**
 * F13 `runChecks` readiness of a queued run (pure over the repos, read-only): for every model step still to run, its
 * effective profile's provider is permitted, a credential ref exists (never the key), and the model is in the catalog
 * and supported; then a read-only §9.3 admission of the next model step's minimum reservation (F6
 * {@link minimumReservation}). Same checks as `runs.preflight` issues.
 */
export function queuedRunIssues(r: Repos, run: RunRow, now: EpochMs): ReadinessIssue[] {
  const project = r.projects.get(run.projectId);
  const models = effectiveModelSteps(r, run); // one parse + one revisions query for every step (17)
  const open = r.steps.latestPerStepKey(run.id).flatMap((s) => {
    const snap = models.get(s.stepKey);
    return snap !== undefined && s.state !== 'succeeded' && s.state !== 'skipped' ? [{ step: s, snap }] : [];
  }).sort((a, b) => a.step.ordinal - b.step.ordinal);
  const issues: ReadinessIssue[] = [];
  for (const { step: s, snap } of open) {
    const { providerId, modelId } = snap.profile;
    issues.push(...checkStepReadiness(project.providerPolicy.allowedProviderIds, { stepKey: s.stepKey, profile: snap.profile,
      capabilities: snap.profile.capabilities, catalogEntry: r.catalog.get(providerId, modelId), hasCredential: r.credentials.get(providerId) !== undefined,
      maxOutputTokens: snap.maxOutputTokens }));
  }
  const next = open.find((x) => x.step.state === 'ready' || x.step.state === 'pending');
  if (next !== undefined) {
    const N = minimumReservation(next.snap);
    const budget = budgetReadiness(admitAgainstLedger(r.ledger, { run: r.ledger.runBalances(run.id), project, N, now }));
    if (budget !== null) issues.push(budget);
  }
  return issues;
}

/**
 * F13 `runChecks`: the dry-run checks before a queued run starts ({@link queuedRunIssues}). The first issue pauses the
 * run (`SETUP_BLOCKED` with `setup_blocked` / `auth_required` / `budget_run` / `budget_project`, F2 clarification 9)
 * BEFORE any reservation or provider call; otherwise `CHECKS_PASSED`. One tx, so the checks and the transition agree.
 */
export async function runChecks(ctx: EngineCtx, run: RunRow): Promise<void> {
  const fx: PostCommitEffect[] = [];
  ctx.db.tx('immediate', (r) => {
    const cur = r.runs.get(run.id);
    if (cur.status !== 'queued') return;
    const now = ctx.clock.now();
    const issue = queuedRunIssues(r, cur, now)[0];
    if (issue !== undefined) {
      if (issue.reason === 'budget_run' || issue.reason === 'budget_project') appendRunEvent(r, fx, cur.id, 'ledger.blocked', { ...issue.error.details, stepRunId: null });
      applyRunEvent(r, cur, { type: 'SETUP_BLOCKED', reason: issue.reason, error: issue.error }, now, fx);
      return;
    }
    // B2 guard: CHECKS_PASSED never moves a run to running while another run holds the slot.
    if (r.runs.listActive().some((x) => x.id !== run.id && holdsSlot(x))) return;
    applyRunEvent(r, cur, { type: 'CHECKS_PASSED' }, now, fx);
  });
  await runEffects(ctx, fx);
}

/** Promotes pending steps whose dependencies succeeded (one tx), then returns the latest rows. */
function promote(ctx: EngineCtx, run: RunRow, snapshot: RunSnapshot): { latest: readonly StepRow[]; fx: PostCommitEffect[] } {
  const fx: PostCommitEffect[] = [];
  const latest = ctx.db.tx('immediate', (r) => {
    let rows = r.steps.latestPerStepKey(run.id);
    const ready = stepsToPromote(rows, snapshot);
    for (const s of ready) applyStepEvent(r, fx, s, 'DEPS_MET');
    if (ready.length > 0) rows = r.steps.latestPerStepKey(run.id);
    return rows;
  });
  return { latest, fx };
}

/** One iteration for a running run. */
async function advance(ctx: EngineCtx, run: RunRow): Promise<void> {
  const snapshot = snapshotOf(run);
  const { latest, fx } = promote(ctx, run, snapshot);
  await runEffects(ctx, fx);
  const next = selectNextStep(latest, ctx.clock.now());
  switch (next.kind) {
    case 'step': {
      const kind = handlerKind(snapshot, next.step.stepKey);
      if (kind === 'intake') return runIntake(ctx, run.id, next.step.id);
      if (kind === 'approval') return openApproval(ctx, run.id, next.step.id);
      if (kind === 'finalize') return runFinalize(ctx, run.id, next.step.id);
      if (kind === 'model') {
        const out = await executeModelAttempt(ctx, run.id, next.step.id);
        // A conflict (the step is not dispatchable, e.g. still `reserved`, or the attempt moved meanwhile) changed
        // nothing: back off until woken or idle, instead of re-preparing (and re-counting tokens) in a hot loop.
        if (out.kind === 'blocked' && out.why === 'conflict') await ctx.wake.wait(ctx.idleMs ?? IDLE_MS);
        return;
      }
      return applyTx(ctx, run.id, { type: 'UNRECOVERABLE', error: errors.internal(ctx.ids.next('correlation')) }, ['running']);
    }
    case 'wait_until':
      return ctx.wake.wait(next.at - ctx.clock.now());
    case 'blocked_failed':
      return applyTx(ctx, run.id, eventForFailure(next.step.error ?? errors.providerUnavailable()), ['running']);
    case 'waiting':
      return ctx.wake.wait(ctx.idleMs ?? IDLE_MS);
    case 'none':
      return applyTx(ctx, run.id, { type: 'UNRECOVERABLE', error: errors.internal(ctx.ids.next('correlation')) }, ['running']);
  }
}

/** One loop iteration (exported for deterministic tests). Returns false when there was no work. */
export async function tick(ctx: EngineCtx): Promise<boolean> {
  const run = pickNext(ctx.db.repos);
  if (run === undefined) return false;
  try {
    if (run.status === 'queued') await runChecks(ctx, run);
    else if (run.status === 'cancelling') {
      if (ctx.cancellation.hasInFlight(run.id)) await ctx.wake.wait(ctx.idleMs ?? IDLE_MS);
      else await onWorkStopped(ctx, run.id);
    } else if (run.pauseRequested) await applyTx(ctx, run.id, { type: 'USER_PAUSE' }, ['running']);
    else await advance(ctx, run);
  } catch (e) {
    // E2 #2: a lock held by another process is transient — back off and retry the same work; never fail the run for it.
    if (isDatabaseBusyError(e)) {
      ctx.logger.warn('loop.database_busy', { runId: run.id });
      await ctx.wake.wait(LOOP_BUSY_BACKOFF_MS);
      return true;
    }
    const correlationId = ctx.ids.next('correlation');
    ctx.logger.error('loop.handler_threw', { runId: run.id, correlationId, code: isRelayError(e) ? e.appError.code : 'INTERNAL',
      err: logSafe(e) });
    await applyTx(ctx, run.id, { type: 'UNRECOVERABLE', error: toAppError(e, correlationId) }, ['running']);
  }
  return true;
}

/** Waits between lease acquisitions that met a database lock at start (E2 #1). */
const LEASE_BUSY_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500, 1_000, 2_000];

/**
 * Acquires the runner lease, retrying a database lock with backoff (yielding) before giving up with the boot variant of
 * `DATABASE_UNAVAILABLE database_busy` (E2 #1): a short lock at boot is not fatal for the session.
 */
async function acquireLease(ctx: EngineCtx, ownerId: string): Promise<'acquired' | 'held_by_other'> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return ctx.db.repos.lease.acquire(ownerId, process.pid, ctx.clock.now(), RUNNER_STALE_AFTER_MS);
    } catch (e) {
      const wait = isDatabaseBusyError(e) ? LEASE_BUSY_RETRY_DELAYS_MS[attempt] : undefined;
      if (wait === undefined) {
        if (isDatabaseBusyError(e)) throw new RelayError(errors.databaseUnavailable('database_busy'), { cause: e });
        throw e;
      }
      ctx.logger.warn('lease.acquire_busy_retry', { attempt: attempt + 1, waitMs: wait });
      await delay(ctx, wait);
    }
  }
}

/** Resolves after `ms` on the injected timers (never global timers, R4-36). */
function delay(ctx: Pick<EngineCtx, 'timers'>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    ctx.timers.setTimeout(resolve, ms);
  });
}

/**
 * Generates up to `limit` missing reports of terminal runs (F1 step 3), then — with what is left of `limit` — checks
 * terminal runs whose costs may have moved after their report was written and refreshes the stale ones (D1-4: a crash
 * between the legacy conversion / a reconciliation and the report refresh). Returns how many runs are still to do.
 * Failures are logged and skipped; every run handled here is added to `skip`, so the next batch never repeats it.
 */
export async function regenerateReportBatch(ctx: EngineCtx, limit: number, skip: Set<string> = new Set()): Promise<number> {
  const pending = ctx.db.repos.runs.listTerminalWithoutReport().filter((r) => !skip.has(r.id));
  for (const run of pending.slice(0, limit)) {
    const res = await generateReport(ctx, run.id);
    if (res.ok) ctx.logger.info('report.regenerated', { runId: run.id });
    else {
      skip.add(run.id);
      ctx.logger.warn('report.regenerate_failed', { runId: run.id, code: res.error.code });
    }
  }
  const room = Math.max(0, limit - pending.length);
  const stale = ctx.db.repos.runs.listTerminalWithUncertainCosts().filter((r) => !skip.has(r.id));
  for (const run of stale.slice(0, room)) {
    skip.add(run.id);
    if (!(await isReportStale(ctx, run.id))) continue;
    const res = await refreshReport(ctx, run.id);
    if (res.ok) ctx.logger.info('report.stale_refreshed', { runId: run.id });
    else ctx.logger.warn('report.stale_refresh_failed', { runId: run.id, code: res.error.code });
  }
  return Math.max(0, pending.length - limit) + Math.max(0, stale.length - room);
}

/**
 * Input issues of a runner channel. A workflow draft patch is strict (P0 edits only): an unknown key there is a
 * structural edit, reported as `structural_edit_p1` (02 §B5, §5.3).
 */
function inputIssues(channel: RunnerChannel, issues: Parameters<typeof toValidationIssues>[0]): ValidationIssue[] {
  const mapped = toValidationIssues(issues);
  return channel === 'relay/v1/workflows.saveDraft'
    ? mapped.map((i) => (i.code === 'unrecognized_keys' ? { ...i, code: 'structural_edit_p1' } : i))
    : mapped;
}

/** Builds the engine-internal context (EngineDeps + cancellation, deadlines, wake, terminal effect). */
export function createEngineContext(deps: EngineDeps): EngineCtx {
  let deadlines: DeadlineWatcher | undefined;
  const ctx: EngineCtx = {
    ...deps,
    logger: redactingLogger(deps.logger), // B6: nothing reaches the log sink unredacted
    cancellation: createCancellationRegistry(),
    wake: createWakeSignal(deps.timers),
    lease: { owned: true },
    get deadlines(): DeadlineWatcher {
      deadlines ??= createDeadlineWatcher(ctx);
      return deadlines;
    },
    onTerminal: async (runId) => {
      const res = await generateReport(ctx, runId);
      if (!res.ok) ctx.logger.warn('report.failed', { runId, code: res.error.code });
    },
  };
  return ctx;
}

/** Creates the engine (F1). Does not start it. */
export function createEngine(deps: EngineDeps): EngineApi {
  return createEngineFromContext(createEngineContext(deps));
}

/** Creates the engine over an existing context (tests share the context with the engine). */
export function createEngineFromContext(ctx: EngineCtx): EngineApi {
  const handlers = createHandlers(ctx);
  const ownerId = `runner_${ctx.ids.next('correlation')}`;
  let stopping = false;
  let started = false;
  let loopDone: Promise<void> = Promise.resolve();
  let reconcileDone: Promise<unknown> = Promise.resolve();
  let backgroundDone: Promise<unknown> = Promise.resolve();
  let reconcileAbort = new AbortController();
  const intervals: unknown[] = [];

  const loop = async (): Promise<void> => {
    const isStopping = (): boolean => stopping;
    while (!isStopping() && ctx.lease.owned) {
      const worked = await tick(ctx);
      if (!worked && !isStopping()) await ctx.wake.wait(ctx.idleMs ?? IDLE_MS);
    }
  };

  const sweep = async (): Promise<void> => {
    const now = ctx.clock.now();
    // Idempotency first and on its own: a failing raw-response purge must not keep expired keys around.
    const removed = ctx.db.tx('immediate', (r) => r.idempotency.sweep(epochMs(now - IDEMPOTENCY_TTL_MS)));
    if (removed > 0) ctx.logger.info('retention.idempotency_swept', { removed });
    await ctx.maintenance.sweepRawResponses(now, readSettings(ctx.db.repos).rawResponseRetentionDays);
  };

  return {
    async handle<C extends RunnerChannel>(channel: C, input: RunnerInputOf<C>): Promise<IpcResult<C>> {
      const def = getRunnerOperation(channel);
      if (def === undefined) return { ok: false, error: errors.validationFailed([{ path: 'channel', message: 'Unknown channel.', code: 'unknown_channel' }]) };
      const parsed = def.input.safeParse(input);
      if (!parsed.success) return { ok: false, error: errors.validationFailed(inputIssues(channel, parsed.error.issues)) };
      const handler: Handler<C> = handlers[channel];
      let result: IpcResult<C>;
      for (let attempt = 0; ; attempt += 1) {
        try {
          result = toIpc(await handler(parsed.data as ParsedInputOf<C>));
          break;
        } catch (e) {
          const wait = def.kind === 'query' && isDatabaseBusyError(e) ? QUERY_BUSY_RETRY_DELAYS_MS[attempt] : undefined;
          if (wait !== undefined) {
            await delay(ctx, wait); // yields: the heartbeat keeps running while another process holds the lock
            continue;
          }
          const correlationId = ctx.ids.next('correlation');
          if (!isRelayError(e)) ctx.logger.error('handler.threw', { channel, correlationId, err: logSafe(e) });
          result = { ok: false, error: toAppError(e, correlationId) };
          break;
        }
      }
      // 02 §B5: a code the op does not declare is a contract bug (the renderer has no copy for it). Logged here; the
      // test harnesses turn it into a failure.
      const undeclared = undeclaredErrorCode(channel, result);
      if (undeclared !== null) ctx.logger.error('handler.undeclared_error_code', { channel, code: undeclared });
      return result;
    },
    async start() {
      if (started) return;
      const lease = await acquireLease(ctx, ownerId);
      if (lease === 'held_by_other') throw new RelayError(errors.runnerUnavailable({ userMessage: 'Another Relay runner is already using this data folder.' }));
      started = true;
      stopping = false;
      ctx.lease.owned = true;
      ctx.lease.ownerId = ownerId;
      intervals.push(ctx.timers.setInterval(() => {
        // E2 #2: a heartbeat that meets a lock is skipped (the next one, 2 s later, refreshes the lease; stale is 10 s).
        try {
          if (!ctx.db.repos.lease.heartbeat(ownerId, ctx.clock.now())) ctx.lease.owned = false; // taken over: stop dispatching
        } catch (e) {
          if (isDatabaseBusyError(e)) ctx.logger.warn('lease.heartbeat_skipped_busy', {});
          else ctx.logger.error('lease.heartbeat_failed', { err: logSafe(e) });
        }
      }, RUNNER_HEARTBEAT_MS));
      await recoverOnStart(ctx);
      // F1 step 3 / E2 #6: terminal runs whose post-commit report never ran (a crash after the terminal commit) get one.
      // A bounded first batch runs now; the rest never delays `ready` and runs in the background, batch by batch.
      const failedReports = new Set<string>();
      const leftover = await regenerateReportBatch(ctx, REPORT_REGEN_AT_START, failedReports).catch((e: unknown) => {
        ctx.logger.warn('report.regenerate_crashed', { err: logSafe(e) });
        return 0;
      });
      const regenerateRest = async (): Promise<void> => {
        for (let left = leftover; left > 0 && !stopping; ) {
          await delay(ctx, 0);
          left = await regenerateReportBatch(ctx, REPORT_REGEN_PER_BATCH, failedReports);
        }
      };
      // E2 #4: rolling automatic backup (daily; also re-checked by the 24 h sweep interval below).
      const autoBackupSafely = (): Promise<void> => ctx.db.autoBackup().then((b) => {
        if (b !== null) ctx.logger.info('backup.auto_created', { sizeBytes: b.sizeBytes });
      }, (e: unknown) => {
        ctx.logger.warn('backup.auto_failed', { err: logSafe(e) });
      });
      backgroundDone = Promise.all([
        regenerateRest().catch((e: unknown) => {
          ctx.logger.warn('report.regenerate_crashed', { err: logSafe(e) });
        }),
        autoBackupSafely(),
      ]);
      for (const run of ctx.db.repos.runs.listActive().filter((x) => x.status === 'running')) ctx.deadlines.arm(run.id);
      const sweepSafely = (): Promise<void> => sweep().catch((e: unknown) => {
        ctx.logger.warn('retention.sweep_failed', { err: logSafe(e) });
      });
      await sweepSafely();
      // Cleared with the heartbeat in stop(): a stopped engine never sweeps.
      intervals.push(ctx.timers.setInterval(() => {
        if (stopping) return;
        void sweepSafely();
        backgroundDone = Promise.all([backgroundDone, autoBackupSafely()]);
      }, RETENTION_SWEEP_INTERVAL_MS));
      loopDone = loop().catch((e: unknown) => {
        ctx.logger.error('loop.crashed', { err: logSafe(e) });
      });
      // F9b: after start, look up unknown attempts whose provider supports it (never blocks the loop).
      reconcileAbort = new AbortController();
      reconcileDone = reconcileUnknownAttempts(ctx, reconcileAbort.signal).catch((e: unknown) => {
        ctx.logger.error('reconcile.crashed', { err: logSafe(e) });
      });
    },
    async stop({ graceMs }) {
      if (!started) return;
      stopping = true;
      reconcileAbort.abort();
      ctx.wake.signal();
      let timer: unknown;
      const grace = new Promise<void>((resolve) => {
        timer = ctx.timers.setTimeout(resolve, graceMs);
      });
      await Promise.race([Promise.all([loopDone, reconcileDone, backgroundDone]), grace]);
      ctx.timers.clearTimeout(timer);
      for (const h of intervals.splice(0)) ctx.timers.clearInterval(h);
      ctx.deadlines.disarmAll();
      ctx.lease.owned = false; // B3: before the release, so an attempt still in flight never dispatches or settles
      ctx.db.repos.lease.release(ownerId);
      started = false;
    },
  };
}
