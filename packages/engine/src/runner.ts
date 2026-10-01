// 06 F13 + F1: the runner loop (one active run, §9.1 concurrency 1) and the engine factory. The loop is the queue:
// running/cancelling first, else the oldest queued run. Waits use the injected timers; commands wake the loop.
import { RUNNER_HEARTBEAT_MS, RUNNER_STALE_AFTER_MS, RelayError, errors, getRunnerOperation, isRelayError, toAppError, toIpc, toValidationIssues } from '@relay/contracts';
import type { EpochMs, IpcResult, RunId, RunnerChannel, RunnerInputOf, StepKey, ValidationIssue } from '@relay/contracts';
import type { Repos, RunRow, StepRow } from '@relay/storage';
import { logSafe, redactingLogger } from './log-safe.js';
import { createCancellationRegistry, onWorkStopped } from './cancellation.js';
import { executeModelAttempt } from './checkpoints.js';
import { admit } from './budget.js';
import { createWakeSignal, monthWindow } from './clock.js';
import { createDeadlineWatcher } from './deadline.js';
import type { DeadlineWatcher, EngineApi, EngineCtx, EngineDeps, RunSnapshot } from './ports.js';
import type { ReadinessIssue } from './policy.js';
import { budgetReadiness, checkStepReadiness, minimumReservation } from './policy.js';
import { reconcileUnknownAttempts, recoverOnStart } from './recovery.js';
import { generateReport, regenerateMissingReports } from './report.js';
import { eventForFailure } from './retry.js';
import type { PostCommitEffect, RunMachineEvent } from './run-machine.js';
import { appendRunEvent, applyRunEvent, runEffects } from './run-machine.js';
import type { Handler, ParsedInputOf } from './services.js';
import { createHandlers, readSettings } from './services.js';
import { effectiveStepSnapshot, snapshotOf } from './snapshot.js';
import { applyStepEvent } from './step-machine.js';
import { runFinalize } from './steps/finalize.js';
import { openApproval } from './steps/approval.js';
import { runIntake } from './steps/intake.js';

/** Default idle wait when there is no work (commands wake the loop earlier). */
export const IDLE_MS = 1_000;

/** F1 step 4 / 03 C8 (R3-16): the raw-response retention sweep runs at boot and then every 24 h (injected timers). */
export const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** What the loop should do next for a running run (pure). */
export type NextStep =
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
  const snapshot = snapshotOf(run);
  const open = r.steps.latestPerStepKey(run.id)
    .filter((s) => snapshot.steps[s.stepKey]?.kind === 'model' && s.state !== 'succeeded' && s.state !== 'skipped')
    .sort((a, b) => a.ordinal - b.ordinal);
  const issues: ReadinessIssue[] = [];
  for (const s of open) {
    const snap = effectiveStepSnapshot(r, run, s.stepKey);
    const { providerId, modelId } = snap.profile;
    issues.push(...checkStepReadiness(project.providerPolicy.allowedProviderIds, { stepKey: s.stepKey, profile: snap.profile,
      capabilities: snap.profile.capabilities, catalogEntry: r.catalog.get(providerId, modelId), hasCredential: r.credentials.get(providerId) !== undefined }));
  }
  const next = open.find((s) => s.state === 'ready' || s.state === 'pending');
  if (next !== undefined) {
    const { start, end } = monthWindow(now);
    const budget = budgetReadiness(admit({
      run: r.ledger.runBalances(run.id), N: minimumReservation(effectiveStepSnapshot(r, run, next.stepKey)),
      project: project.monthlyAllowanceMicrousd === null ? null
        : { L: project.monthlyAllowanceMicrousd, ...r.ledger.projectMonthBalances(run.projectId, start, end) },
    }));
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
    const correlationId = ctx.ids.next('correlation');
    ctx.logger.error('loop.handler_threw', { runId: run.id, correlationId, code: isRelayError(e) ? e.appError.code : 'INTERNAL',
      err: logSafe(e) });
    await applyTx(ctx, run.id, { type: 'UNRECOVERABLE', error: toAppError(e, correlationId) }, ['running']);
  }
  return true;
}

/**
 * Input issues of a runner channel. A workflow draft patch is strict (P0 edits only): an unknown key there is a
 * structural edit, reported as `structural_edit_p1` (02 §B5, §5.3).
 */
export function inputIssues(channel: RunnerChannel, issues: Parameters<typeof toValidationIssues>[0]): ValidationIssue[] {
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
    await ctx.maintenance.sweepRawResponses(ctx.clock.now(), readSettings(ctx.db.repos).rawResponseRetentionDays);
  };

  return {
    async handle<C extends RunnerChannel>(channel: C, input: RunnerInputOf<C>): Promise<IpcResult<C>> {
      const def = getRunnerOperation(channel);
      if (def === undefined) return { ok: false, error: errors.validationFailed([{ path: 'channel', message: 'Unknown channel.', code: 'unknown_channel' }]) };
      const parsed = def.input.safeParse(input);
      if (!parsed.success) return { ok: false, error: errors.validationFailed(inputIssues(channel, parsed.error.issues)) };
      const handler: Handler<C> = handlers[channel];
      try {
        return toIpc(await handler(parsed.data as ParsedInputOf<C>));
      } catch (e) {
        const correlationId = ctx.ids.next('correlation');
        if (!isRelayError(e)) ctx.logger.error('handler.threw', { channel, correlationId, err: logSafe(e) });
        return { ok: false, error: toAppError(e, correlationId) };
      }
    },
    async start() {
      if (started) return;
      const lease = ctx.db.repos.lease.acquire(ownerId, process.pid, ctx.clock.now(), RUNNER_STALE_AFTER_MS);
      if (lease === 'held_by_other') throw new RelayError(errors.runnerUnavailable({ userMessage: 'Another Relay runner is already using this data folder.' }));
      started = true;
      stopping = false;
      ctx.lease.owned = true;
      ctx.lease.ownerId = ownerId;
      intervals.push(ctx.timers.setInterval(() => {
        if (!ctx.db.repos.lease.heartbeat(ownerId, ctx.clock.now())) ctx.lease.owned = false; // taken over: stop dispatching
      }, RUNNER_HEARTBEAT_MS));
      await recoverOnStart(ctx);
      // F1 step 3: terminal runs whose post-commit report never ran (a crash after the terminal commit) get one now.
      await regenerateMissingReports(ctx).catch((e: unknown) => {
        ctx.logger.warn('report.regenerate_crashed', { err: logSafe(e) });
      });
      for (const run of ctx.db.repos.runs.listActive().filter((x) => x.status === 'running')) ctx.deadlines.arm(run.id);
      const sweepSafely = (): Promise<void> => sweep().catch((e: unknown) => {
        ctx.logger.warn('retention.sweep_failed', { err: logSafe(e) });
      });
      await sweepSafely();
      // Cleared with the heartbeat in stop(): a stopped engine never sweeps.
      intervals.push(ctx.timers.setInterval(() => {
        if (!stopping) void sweepSafely();
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
      await Promise.race([Promise.all([loopDone, reconcileDone]), grace]);
      ctx.timers.clearTimeout(timer);
      for (const h of intervals.splice(0)) ctx.timers.clearInterval(h);
      ctx.deadlines.disarmAll();
      ctx.lease.owned = false; // B3: before the release, so an attempt still in flight never dispatches or settles
      ctx.db.repos.lease.release(ownerId);
      started = false;
    },
  };
}
