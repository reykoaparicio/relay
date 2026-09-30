// 06 F9: crash recovery at engine.start(), one transaction per run.
// created/reserved attempts → released (failed_before_dispatch, step → ready); EVERY dispatching attempt → unknown
// with move_to_unknown N (R4-3); running → interrupted (RUNNER_LOST); cancelling → cancelled with open steps skipped.
// Succeeded steps are never touched (FR-07). F9b: the reconcile task (after start) looks up `unknown` attempts that
// have a provider response id on providers that support request lookup.
import { computeCost, errors, redactDeep, redactString } from '@relay/contracts';
import type { ArtifactId, AttemptId, EpochMs, Microusd, RunId } from '@relay/contracts';
import type { ModelRequest, NormalizedUsage, ProviderAdapter, ReconciliationResult } from '@relay/providers';
import type { AttemptRow, Repos } from '@relay/storage';
import { resolveUnknownEntries, settlementEntries } from './budget.js';
import type { ArtifactPut } from './checkpoints.js';
import { isJsonText, outcomeLabel, putArtifact } from './checkpoints.js';
import { canonicalJson, utf8 } from './hash.js';
import { logSafe } from './log-safe.js';
import type { EngineCtx } from './ports.js';
import type { ResultFlags, Validation } from './retry.js';
import { flagsOf } from './retry.js';
import { planRevision } from './revision.js';
import { effectiveStepSnapshot } from './snapshot.js';
import { validateOutput } from './steps/validate-output.js';
import { loadValidationInputs } from './steps/validation-inputs.js';
import type { PostCommitEffect } from './run-machine.js';
import { appendRunEvent, applyRunEvent, runEffects } from './run-machine.js';
import { applyStepEvent, skipOpenSteps } from './step-machine.js';

function recoverAttempt(r: Repos, fx: PostCommitEffect[], a: AttemptRow, now: EpochMs): void {
  const N = r.ledger.attemptBalances(a.id).reserved;
  const run = r.runs.get(a.runId);
  const refs = { reservation: N, attemptId: a.id, runId: a.runId, projectId: run.projectId, priceCatalogVersion: a.priceCatalogVersion, createdAt: now };
  const step = r.steps.get(a.stepRunId);
  if (a.state === 'created' || a.state === 'reserved') {
    r.ledger.append(settlementEntries({ ...refs, cost: { kind: 'not_charged' } }));
    r.attempts.transition(a.id, [a.state], 'failed_before_dispatch', { finishedAt: now });
    if (step.state === 'reserved') applyStepEvent(r, fx, step, 'RESERVATION_RELEASED');
    return;
  }
  if (a.state === 'dispatching') {
    r.ledger.append(settlementEntries({ ...refs, cost: { kind: 'unknown' } }));
    r.attempts.transition(a.id, ['dispatching'], 'unknown', { error: errors.requestOutcomeUnknown(a.id), finishedAt: now });
    if (step.state === 'executing') applyStepEvent(r, fx, step, 'OUTCOME_UNKNOWN', { error: errors.requestOutcomeUnknown(a.id) });
    appendRunEvent(r, fx, a.runId, 'attempt.unknown', { attemptId: a.id, stepRunId: a.stepRunId, recovered: true });
  }
}

/**
 * B1: the run's last sign of life before the crash — the latest of its running-segment start, its row update, its
 * attempts' timestamps, and its last event (the runner lease row is overwritten by the new owner's acquire, so its
 * heartbeat is not readable here). Never later than `now`: downtime never counts toward the deadline (F12).
 */
export function lastAliveAt(r: Repos, runId: RunId, now: EpochMs): EpochMs {
  const run = r.runs.get(runId);
  const times: number[] = [run.updatedAt];
  if (run.runningSince !== null) times.push(run.runningSince);
  for (const a of r.attempts.listForRun(runId)) {
    times.push(a.createdAt);
    for (const t of [a.dispatchedAt, a.firstByteAt, a.finishedAt]) if (t !== null) times.push(t);
  }
  const lastSeq = r.events.lastSeq(runId);
  const last = lastSeq > 0 ? r.events.list(runId, lastSeq - 1, 1)[0] : undefined;
  if (last !== undefined) times.push(last.at);
  return Math.min(now, Math.max(...times)) as EpochMs;
}

function recoverRun(ctx: EngineCtx, runId: RunId, attempts: readonly AttemptRow[]): PostCommitEffect[] {
  const fx: PostCommitEffect[] = [];
  ctx.db.tx('immediate', (r) => {
    const now = ctx.clock.now();
    const aliveAt = lastAliveAt(r, runId, now); // before recovery writes anything
    for (const a of attempts) recoverAttempt(r, fx, a, now);
    const run = r.runs.get(runId);
    if (run.status === 'running') applyRunEvent(r, run, { type: 'RUNNER_LOST', lastAliveAt: aliveAt }, now, fx);
    if (run.status === 'cancelling') {
      skipOpenSteps(r, fx, runId);
      applyRunEvent(r, run, { type: 'RUNNER_LOST' }, now, fx);
    }
  });
  return fx;
}

/**
 * F18 crash safety: a setup (`providers.test`) reservation still outstanding at start belongs to a call whose runner
 * died between the reserve and the settle tx. Whether it left is unknown, so the full amount moves to the setup
 * liability (`move_to_unknown`, like a dispatching attempt), never silently released.
 */
export function recoverSetupReservations(ctx: EngineCtx): Microusd {
  return ctx.db.tx('immediate', (r) => {
    const now = ctx.clock.now();
    const outstanding = r.ledger.setupBalances(0 as EpochMs, Number.MAX_SAFE_INTEGER as EpochMs).R;
    if (outstanding <= 0) return 0 as Microusd;
    r.ledger.append(settlementEntries({ reservation: outstanding, cost: { kind: 'unknown' }, attemptId: null, runId: null, projectId: null,
      priceCatalogVersion: null, createdAt: now, scope: 'setup' }));
    ctx.logger.warn('recovery.setup_reservation', { microusd: outstanding });
    return outstanding;
  });
}

/** Runs recovery for every run with an in-flight attempt or a running/cancelling status. Returns the run ids. */
export async function recoverOnStart(ctx: EngineCtx): Promise<RunId[]> {
  const r = ctx.db.repos;
  recoverSetupReservations(ctx);
  const pending = r.attempts.listUnresolved().filter((a) => a.state !== 'unknown');
  const byRun = new Map<RunId, AttemptRow[]>();
  for (const a of pending) byRun.set(a.runId, [...(byRun.get(a.runId) ?? []), a]);
  for (const run of r.runs.listActive()) {
    if ((run.status === 'running' || run.status === 'cancelling') && !byRun.has(run.id)) byRun.set(run.id, []);
  }
  for (const [runId, attempts] of byRun) await runEffects(ctx, recoverRun(ctx, runId, attempts));
  return [...byRun.keys()];
}

// ---------------------------------------------------------------- F9b reconcile task

/** F9b: an `in_progress` answer is re-polled up to 3 times over 30 s (injected timers). */
export const RECONCILE_MAX_POLLS = 3;
export const RECONCILE_POLL_INTERVAL_MS = 10_000;

/** What reconciling one attempt did. */
export type ReconcileOutcome = 'completed' | 'failed' | 'in_progress' | 'not_found' | 'skipped';

/** Sleeps on the injected timers; resolves false when `signal` aborts first. */
function pause(ctx: Pick<EngineCtx, 'timers'>, ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      ctx.timers.clearTimeout(handle);
      resolve(false);
    };
    const handle = ctx.timers.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * N1: the provider options the attempt's request was actually sent with (recorded in `estimate_json` at reservation),
 * or undefined for attempts recorded before that field existed (the project's current options are used then).
 */
export function recordedProviderOptions(a: Pick<AttemptRow, 'estimate'>): ModelRequest['providerOptions'] | undefined {
  const e = a.estimate;
  if (typeof e !== 'object' || e === null || !('providerOptions' in e)) return undefined;
  const o = e.providerOptions;
  return typeof o === 'object' && o !== null ? o : {};
}

/**
 * F9b eligibility: `unknown`, a provider response id, and request-lookup support for the attempt's capability snapshot
 * under the project's provider options (an OpenAI project with `storeResponses: false` never looks up).
 */
export function isReconcilable(ctx: Pick<EngineCtx, 'db' | 'requestLookup'>, a: AttemptRow): boolean {
  if (a.state !== 'unknown' || a.providerResponseId === null) return false;
  const options = recordedProviderOptions(a) ?? ctx.db.repos.projects.get(ctx.db.repos.runs.get(a.runId).projectId).providerPolicy.providerOptions;
  const caps = a.profileSnapshot.capabilities;
  return ctx.requestLookup === undefined ? caps.supportsRequestLookup : ctx.requestLookup(a.providerId, caps, options);
}

type Resolution =
  | { readonly kind: 'completed'; readonly json: unknown; readonly usage: NormalizedUsage; readonly rawUsage: unknown; readonly flags: ResultFlags }
  | { readonly kind: 'failed'; readonly usage: NormalizedUsage | null; readonly flags: ResultFlags };

/**
 * The settled amount of a reconciled attempt: usage × snapshot prices (`calculated`); no usage on a failure → 0;
 * `usageKnown: false` → the full liability N (`estimated`, never $0); a price-tier mismatch → `estimated`.
 */
export function reconciledAmount(res: Resolution, prices: AttemptRow['profileSnapshot']['prices'], liability: Microusd): { X: Microusd; certainty: 'calculated' | 'estimated' } {
  if (res.flags.usageKnown === false) return { X: liability, certainty: 'estimated' };
  const X = res.usage === null ? (0 as Microusd) : computeCost(res.usage, prices).microusd;
  return { X, certainty: res.flags.priceTierMismatch === true ? 'estimated' : 'calculated' };
}

/** RESUME_RESOLVED for a paused(unknown_outcome) run whose last unknown attempt was just resolved (step not failed). */
export function resumeIfUnknownsResolved(r: Repos, fx: PostCommitEffect[], runId: RunId, now: EpochMs): void {
  const run = r.runs.get(runId);
  if (run.status !== 'paused' || run.pauseReason !== 'unknown_outcome') return;
  if (r.attempts.listForRun(runId).some((x) => x.state === 'unknown')) return;
  if (r.steps.latestPerStepKey(runId).some((s) => s.state === 'failed' || s.state === 'unknown')) return;
  applyRunEvent(r, run, { type: 'RESUME_RESOLVED' }, now, fx);
}

/** The step move for a reconciled attempt (reconcile tx). */
function reconcileStep(
  r: Repos,
  fx: PostCommitEffect[],
  ctx: EngineCtx,
  i: { attempt: AttemptRow; res: Resolution; validated: Validation | null; output: { id: ArtifactId; value: unknown } | null; now: EpochMs },
): void {
  const step = r.steps.get(i.attempt.stepRunId);
  if (step.state !== 'unknown') return;
  const run = r.runs.get(i.attempt.runId);
  const policy = effectiveStepSnapshot(r, run, step.stepKey).retryPolicy;
  if (i.res.kind === 'completed' && i.validated?.ok === true && i.output !== null) {
    applyStepEvent(r, fx, step, 'RECONCILED_VALID', { outputArtifactId: i.output.id, outcome: outcomeLabel(i.output.value), error: null, notBeforeAt: null });
    planRevision(r, fx, ctx, r.steps.get(step.id), i.now);
    return;
  }
  if (i.res.kind === 'completed') {
    const error = i.validated?.ok === false ? i.validated.error : errors.artifactWriteFailed();
    if (step.schemaRepairsUsed < policy.schemaRepair) {
      applyStepEvent(r, fx, step, 'RECONCILED_RETRY', { schemaRepairsUsed: step.schemaRepairsUsed + 1, error, notBeforeAt: null });
    } else applyStepEvent(r, fx, step, 'RECONCILED_FAILED', { error });
    return;
  }
  const error = errors.providerUnavailable(i.attempt.providerId);
  if (step.transportRetriesUsed < policy.transport) {
    applyStepEvent(r, fx, step, 'RECONCILED_RETRY', { transportRetriesUsed: step.transportRetriesUsed + 1, error, notBeforeAt: null });
  } else applyStepEvent(r, fx, step, 'RECONCILED_FAILED', { error });
}

/** One tx: resolve the unknown liability (resolve_unknown −N + settle +X), the attempt, the step. */
function commitReconciled(
  ctx: EngineCtx,
  fx: PostCommitEffect[],
  i: { attempt: AttemptRow; res: Resolution; validated: Validation | null; output: { id: ArtifactId; value: unknown } | null; puts: readonly ArtifactPut[] },
): boolean {
  const a = i.attempt;
  return ctx.db.tx('immediate', (r) => {
    const now = ctx.clock.now();
    const usage = i.res.usage;
    // A failure without known usage keeps the unknown liability (never resolved to $0): the attempt is abandoned.
    const keepLiability = i.res.kind === 'failed' && i.res.flags.usageKnown === false;
    const to = keepLiability ? 'abandoned' : i.res.kind === 'completed' ? 'reconciled_succeeded' : 'reconciled_failed';
    const won = r.attempts.transition(a.id, ['unknown'], to, {
      usage: usage === null ? null : { ...usage }, rawUsage: i.res.kind === 'completed' ? redactDeep(i.res.rawUsage) : null, finishedAt: now,
    });
    if (!won) return false; // decided by the user or reconciled elsewhere meanwhile
    const run = r.runs.get(a.runId);
    const liability = r.ledger.attemptBalances(a.id).unknown;
    const { X, certainty } = keepLiability ? { X: 0 as Microusd, certainty: 'unknown' as const } : reconciledAmount(i.res, a.profileSnapshot.prices, liability);
    if (!keepLiability) {
      r.ledger.append(resolveUnknownEntries({ liability, settled: X, certainty, attemptId: a.id, runId: a.runId,
        projectId: run.projectId, priceCatalogVersion: a.priceCatalogVersion, createdAt: now }));
    }
    for (const put of i.puts) {
      if (!put.ok) continue;
      r.artifacts.insertIfAbsent({ ...put.meta, stepRunId: a.stepRunId, attemptId: a.id });
      appendRunEvent(r, fx, a.runId, 'artifact.created', { artifactId: put.meta.id, kind: put.meta.kind, attemptId: a.id, stepRunId: a.stepRunId });
    }
    appendRunEvent(r, fx, a.runId, 'attempt.settled', { attemptId: a.id, stepRunId: a.stepRunId, reconciled: i.res.kind, liabilityKept: keepLiability,
      cost: keepLiability ? { kind: 'unknown' } : { kind: 'known', microusd: X, certainty } });
    if (X > liability) appendRunEvent(r, fx, a.runId, 'ledger.overrun', { attemptId: a.id, stepRunId: a.stepRunId, N: liability, X });
    reconcileStep(r, fx, ctx, { ...i, now });
    resumeIfUnknownsResolved(r, fx, a.runId, now);
    return true;
  });
}

async function settleResolution(ctx: EngineCtx, attempt: AttemptRow, res: Resolution): Promise<void> {
  const run = ctx.db.repos.runs.get(attempt.runId);
  const step = ctx.db.repos.steps.get(attempt.stepRunId);
  const puts: ArtifactPut[] = [];
  let validated: Validation | null = null;
  let output: { id: ArtifactId; value: unknown } | null = null;
  if (res.kind === 'completed') {
    const stepSnap = effectiveStepSnapshot(ctx.db.repos, run, step.stepKey);
    const raw = JSON.stringify(res.json);
    puts.push(await putArtifact(ctx, run, { kind: 'raw_response', bytes: utf8(redactString(raw)), mediaType: isJsonText(raw) ? 'application/json' : 'text/plain' }));
    validated = validateOutput(stepSnap, res.json, ctx.templates, await loadValidationInputs(ctx, run, step.revisionIndex));
    if (validated.ok) {
      const put = await putArtifact(ctx, run, { kind: stepSnap.outputKind, schemaId: stepSnap.outputSchema,
        bytes: utf8(canonicalJson(validated.value)), mediaType: 'application/json' });
      puts.push(put);
      if (put.ok) output = { id: put.meta.id, value: validated.value };
    }
  }
  const fx: PostCommitEffect[] = [];
  const committed = commitReconciled(ctx, fx, { attempt, res, validated, output, puts });
  if (!committed) ctx.logger.warn('reconcile.skipped', { runId: attempt.runId, attemptId: attempt.id, reason: 'attempt_already_moved' });
  await runEffects(ctx, fx);
}

/**
 * F9b for one attempt: credential (`dispatch`, the attempt's id) → `adapter.reconcile` outside any tx → settle.
 * `in_progress` is re-polled up to {@link RECONCILE_MAX_POLLS} times; `not_found` leaves the attempt unknown.
 */
export async function reconcileAttempt(ctx: EngineCtx, attempt: AttemptRow, signal: AbortSignal): Promise<ReconcileOutcome> {
  let adapter: ProviderAdapter;
  try {
    adapter = ctx.providers.get(attempt.providerId);
  } catch {
    return 'skipped';
  }
  const lookup = adapter.reconcile?.bind(adapter);
  const responseId = attempt.providerResponseId;
  if (lookup === undefined || responseId === null) return 'skipped';
  const credential = await ctx.credentials.resolve({ providerId: attempt.providerId, purpose: 'dispatch', attemptId: attempt.id });
  if (!credential.ok) return 'skipped';
  for (let poll = 0; ; poll += 1) {
    let res: ReconciliationResult;
    try {
      res = await lookup({ providerResponseId: responseId }, { apiKey: credential.value, signal });
    } catch (e) {
      ctx.logger.warn('reconcile.failed', { runId: attempt.runId, attemptId: attempt.id, err: logSafe(e, [credential.value]) });
      return 'skipped';
    }
    switch (res.kind) {
      case 'completed':
        await settleResolution(ctx, attempt, { ...res, flags: flagsOf(res) });
        return 'completed';
      case 'failed':
        await settleResolution(ctx, attempt, { kind: 'failed', usage: res.usage ?? null, flags: flagsOf(res) });
        return 'failed';
      case 'not_found':
        return 'not_found';
      case 'in_progress':
        if (poll >= RECONCILE_MAX_POLLS || !(await pause(ctx, RECONCILE_POLL_INTERVAL_MS, signal))) return 'in_progress';
    }
  }
}

/** F9b: reconciles every eligible unknown attempt (sequentially). Never throws; failures are logged. */
export async function reconcileUnknownAttempts(ctx: EngineCtx, signal: AbortSignal): Promise<Map<AttemptId, ReconcileOutcome>> {
  const out = new Map<AttemptId, ReconcileOutcome>();
  for (const a of ctx.db.repos.attempts.listUnresolved().filter((a) => isReconcilable(ctx, a))) {
    if (signal.aborted) break;
    try {
      out.set(a.id, await reconcileAttempt(ctx, a, signal));
    } catch (e) {
      ctx.logger.error('reconcile.threw', { runId: a.runId, attemptId: a.id, err: logSafe(e) });
      out.set(a.id, 'skipped');
    }
  }
  return out;
}
