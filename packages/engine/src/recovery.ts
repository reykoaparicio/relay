// 06 F9: crash recovery at engine.start(), one transaction per run.
// created/reserved attempts → released (failed_before_dispatch, step → ready); EVERY dispatching attempt → unknown,
// settled at once as an ESTIMATE (decision 1: release −N + settle +estimate; never an unknown liability); running →
// interrupted (RUNNER_LOST); cancelling → cancelled with open steps skipped. Succeeded steps are never touched
// (FR-07). Legacy unknown liabilities are converted to estimates first (`convertLegacyUnknowns`). F9b: the reconcile
// task (after start) looks up uncertain attempts that have a provider response id on providers that support request
// lookup, and replaces the estimate by the real cost (a correction, never a second charge).
import { computeCost, errors, isTerminalRunStatus, redactDeep, redactString } from '@relay/contracts';
import type { ArtifactId, AttemptId, EpochMs, Microusd, RunId } from '@relay/contracts';
import type { ModelRequest, NormalizedUsage, ReconciliationResult } from '@relay/providers';
import type { AttemptRow, Repos } from '@relay/storage';
import { resolveUnknownEntries, settlementEntries } from './budget.js';
import { chargeDateOf, convertLegacyUnknowns, correctionDateOf, correctionEntries, persistedMayNotHaveBeenCharged, persistedOutputTokens, recordedInputTokens, settledByCertaintyOf, uncertainCost, uncertainError } from './uncertain.js';
import type { SettleAmount } from './budget.js';
import type { ArtifactPut } from './checkpoints.js';
import { isJsonText, putArtifact } from './checkpoints.js';
import { canonicalJson, utf8 } from './hash.js';
import { logSafe } from './log-safe.js';
import { adapterOf } from './provider-lookup.js';
import { refreshReport } from './report.js';
import type { EngineCtx } from './ports.js';
import { applyPostValidation, deferPause, isDeferrablePause } from './outcome.js';
import type { ClassifiedOutcome, ResultFlags, Validation } from './retry.js';
import { flagsOf, overrunError, validatedOutcome } from './retry.js';
import { effectiveStepSnapshot } from './snapshot.js';
import { validateOutput } from './steps/validate-output.js';
import { loadValidationInputs } from './steps/validation-inputs.js';
import type { PostCommitEffect } from './run-machine.js';
import { appendRunEvent, applyRunEvent, deferredPauseEvent, runEffects } from './run-machine.js';
import { applyStepEvent, skipOpenSteps } from './step-machine.js';

/**
 * Recovers one attempt. The attempt CAS goes FIRST and the ledger moves only when it wins (like `settle`,
 * `forceUnknown`, and `commitReconciled`): `a` was read before the tx, so another writer may have moved it since.
 * Exported for tests (not from the barrel).
 */
export function recoverAttempt(r: Repos, fx: PostCommitEffect[], a: AttemptRow, now: EpochMs): void {
  const N = r.ledger.attemptBalances(a.id).reserved;
  const run = r.runs.get(a.runId);
  const refs = { reservation: N, attemptId: a.id, runId: a.runId, projectId: run.projectId, priceCatalogVersion: a.priceCatalogVersion, createdAt: now };
  const step = r.steps.get(a.stepRunId);
  if (a.state === 'created' || a.state === 'reserved') {
    if (!r.attempts.transition(a.id, [a.state], 'failed_before_dispatch', { finishedAt: now })) return;
    r.ledger.append(settlementEntries({ ...refs, cost: { kind: 'not_charged' } }));
    if (step.state === 'reserved') applyStepEvent(r, fx, step, 'RESERVATION_RELEASED');
    return;
  }
  if (a.state === 'dispatching') {
    // Decision 1: the estimate is input tokens (recorded estimate) + output observed before the crash (stream progress).
    const out = persistedOutputTokens(r, a);
    const cost = uncertainCost({ inputTokens: recordedInputTokens(a), outputTokens: out }, a.profileSnapshot.prices);
    const mayNot = persistedMayNotHaveBeenCharged(a, out);
    const error = uncertainError(a.id, cost.microusd, mayNot);
    if (!r.attempts.transition(a.id, ['dispatching'], 'unknown', { error, finishedAt: now, outcomeUncertain: true, mayNotHaveBeenCharged: mayNot })) return;
    // D1-1: booked at the charge date (the month the request left), like the legacy conversion — never at the restart.
    r.ledger.append(settlementEntries({ ...refs, createdAt: chargeDateOf(a), cost }));
    if (step.state === 'executing') applyStepEvent(r, fx, step, 'OUTCOME_UNKNOWN', { error });
    appendRunEvent(r, fx, a.runId, 'attempt.unknown', { attemptId: a.id, stepRunId: a.stepRunId, recovered: true, cost, mayNotHaveBeenCharged: mayNot });
    // §9.5: an estimate above the reservation is an overrun like any other (applied when the run continues).
    if (cost.microusd > N) {
      appendRunEvent(r, fx, a.runId, 'ledger.overrun', { attemptId: a.id, stepRunId: a.stepRunId, N, X: cost.microusd });
      deferPause(r, fx, a.runId, { type: 'BUDGET_OVERRUN', attemptId: a.id, error: overrunError(a.id, N, cost.microusd) });
    }
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
 * died between the reserve and the settle tx. Whether it left is unknown, so it is never silently released: decision 1
 * settles it as an estimate at the reserved amount (no token count survives for a setup call; a connection test is a
 * few tokens, so the reservation is the honest upper estimate).
 */
export function recoverSetupReservations(ctx: EngineCtx): Microusd {
  return ctx.db.tx('immediate', (r) => {
    const now = ctx.clock.now();
    const outstanding = r.ledger.setupBalances(0 as EpochMs, Number.MAX_SAFE_INTEGER as EpochMs).R;
    if (outstanding <= 0) return 0 as Microusd;
    r.ledger.append(settlementEntries({ reservation: outstanding, cost: { kind: 'known', microusd: outstanding, certainty: 'estimated' }, attemptId: null,
      runId: null, projectId: null, priceCatalogVersion: null, createdAt: now, scope: 'setup' }));
    ctx.logger.warn('recovery.setup_reservation', { microusd: outstanding });
    return outstanding;
  });
}

/** Runs recovery for every run with an in-flight attempt or a running/cancelling status. Returns the run ids. */
export async function recoverOnStart(ctx: EngineCtx): Promise<RunId[]> {
  const r = ctx.db.repos;
  await convertLegacyUnknowns(ctx); // decision 1: old DBs show no unknown charges (idempotent, logged)
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
const RECONCILE_MAX_POLLS = 3;
const RECONCILE_POLL_INTERVAL_MS = 10_000;

/** What reconciling one attempt did. */
type ReconcileOutcome = 'completed' | 'failed' | 'in_progress' | 'not_found' | 'skipped';

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
  const candidate = a.state === 'unknown' || (a.state === 'abandoned' && a.outcomeUncertain);
  if (!candidate || a.providerResponseId === null) return false;
  const options = recordedProviderOptions(a) ?? ctx.db.repos.projects.get(ctx.db.repos.runs.get(a.runId).projectId).providerPolicy.providerOptions;
  const caps = a.profileSnapshot.capabilities;
  return ctx.requestLookup === undefined ? caps.supportsRequestLookup : ctx.requestLookup(a.providerId, caps, options);
}

type Resolution =
  | { readonly kind: 'completed'; readonly json: unknown; readonly usage: NormalizedUsage; readonly rawUsage: unknown; readonly flags: ResultFlags }
  | { readonly kind: 'failed'; readonly usage: NormalizedUsage | null; readonly flags: ResultFlags };

/**
 * The settled amount of a reconciled attempt: usage × snapshot prices (`calculated`); no usage on a failure → 0;
 * `usageKnown: false` → `liability` (the current estimate, or a legacy unknown liability; `estimated`, never $0); a
 * price-tier mismatch → `estimated`.
 */
export function reconciledAmount(res: Resolution, prices: AttemptRow['profileSnapshot']['prices'], liability: Microusd): { X: Microusd; certainty: 'calculated' | 'estimated' } {
  if (res.flags.usageKnown === false) return { X: liability, certainty: 'estimated' };
  const X = res.usage === null ? (0 as Microusd) : computeCost(res.usage, prices).microusd;
  return { X, certainty: res.flags.priceTierMismatch === true ? 'estimated' : 'calculated' };
}

/**
 * Once the last unknown attempt of a `paused(unknown_outcome)` run is resolved (reconciled or decided): a pause a
 * reconciled outcome deferred (an overrun X > liability → `budget_overrun`, a quality revision outside the approved
 * scope → `approval_stale`) is applied INSTEAD of resuming — never auto-resumed (BH-2, BH-6). Otherwise
 * RESUME_RESOLVED when no step is failed or unknown. Other pause reasons keep waiting for their own decision (the
 * durable deferred pause still wins over it, `applyRunEvent`).
 */
export function resumeIfUnknownsResolved(r: Repos, fx: PostCommitEffect[], runId: RunId, now: EpochMs): void {
  const run = r.runs.get(runId);
  if (run.status !== 'paused' || run.pauseReason !== 'unknown_outcome') return;
  if (r.attempts.listForRun(runId).some((x) => x.state === 'unknown')) return;
  if (run.deferredPause !== null) {
    applyRunEvent(r, run, deferredPauseEvent(run.deferredPause), now, fx);
    return;
  }
  if (r.steps.latestPerStepKey(runId).some((s) => s.state === 'failed' || s.state === 'unknown')) return;
  applyRunEvent(r, run, { type: 'RESUME_RESOLVED' }, now, fx);
}

type ReconcileInput = {
  attempt: AttemptRow;
  res: Resolution;
  validated: Validation | null;
  output: { id: ArtifactId; value: unknown } | null;
  puts: readonly ArtifactPut[];
};

/**
 * The F7 outcome of a reconciled attempt, classified exactly like a live result: a completed response goes through
 * the same {@link validatedOutcome} (valid / invalid_output / scope_changed / artifact_failed); a failure is a
 * transport failure (retried with the transport budget).
 */
function reconciledOutcome(i: ReconcileInput): ClassifiedOutcome {
  const common = { charge: { kind: 'not_charged' } as const, usage: i.res.usage, partial: false, stopReason: null, retryAfterMs: null,
    abortReason: null, providerRequestId: null };
  if (i.res.kind === 'failed') {
    return { ...common, kind: 'transport', attemptState: 'failed', error: errors.providerUnavailable(i.attempt.providerId), rawUsage: null };
  }
  const canonicalOk = i.validated?.ok !== true || i.output !== null;
  return { ...common, ...validatedOutcome(i.validated, canonicalOk), rawUsage: i.res.rawUsage };
}

/** The attempt's current settlement in the caller's tx: a legacy unknown liability, or its (estimated) settled part. */
function currentCharge(r: Repos, a: AttemptRow): { readonly legacyLiability: Microusd; readonly estimate: Microusd; readonly settled: Microusd } {
  const legacyLiability = r.ledger.attemptBalances(a.id).unknown;
  const own = settledByCertaintyOf(r.ledger.listForRun(a.runId).map((x) => x.entry), a.id);
  return { legacyLiability, estimate: own.estimated as Microusd, settled: own.total as Microusd };
}

/**
 * The ledger move of a reconciled attempt (caller's tx). Decision 1: the estimate the attempt was settled with is
 * replaced by the real cost through a correction group (`settle −estimate` + `settle +X`), so the estimate is never
 * counted twice. A legacy unknown liability (data from before decision 1, normally converted at start) is resolved as
 * before. `keep`: the provider reported a failure without usage — the estimate stays as it is.
 */
function settleReconciled(r: Repos, a: AttemptRow, res: Resolution, keep: boolean): { readonly cost: SettleAmount; readonly event: SettleAmount } {
  const run = r.runs.get(a.runId);
  // D1-1: the correction (or the legacy resolution) is booked in the month of the charge, never at the lookup's date.
  const at = correctionDateOf(r.ledger.listForRun(a.runId).map((x) => x.entry), a);
  const refs = { attemptId: a.id, runId: a.runId, projectId: run.projectId, priceCatalogVersion: a.priceCatalogVersion, createdAt: at };
  const cur = currentCharge(r, a);
  if (cur.legacyLiability > 0) {
    if (keep) return { cost: { kind: 'unknown' }, event: { kind: 'unknown' } };
    const { X, certainty } = reconciledAmount(res, a.profileSnapshot.prices, cur.legacyLiability);
    r.ledger.append(resolveUnknownEntries({ ...refs, liability: cur.legacyLiability, settled: X, certainty }));
    const cost: SettleAmount = { kind: 'known', microusd: X, certainty };
    return { cost, event: cost };
  }
  const estimated: SettleAmount = { kind: 'known', microusd: cur.settled, certainty: 'estimated' };
  // Kept: no overrun is raised again (the estimate was checked against N when it was booked).
  if (keep) return { cost: { kind: 'unknown' }, event: estimated };
  const { X, certainty } = reconciledAmount(res, a.profileSnapshot.prices, cur.estimate);
  r.ledger.append(correctionEntries({ ...refs, estimate: cur.estimate, X, certainty }));
  const cost: SettleAmount = { kind: 'known', microusd: X, certainty };
  return { cost, event: cost };
}

/**
 * One tx: correct the estimate (or resolve a legacy liability), the attempt, then the SAME post-validation function as
 * the live settle (BH-6). The attempt records the classified error, so the next attempt's purpose matches the counter
 * the retry consumed (BH-5). A pause the outcome requires is deferred until the run's uncertain attempts are resolved
 * (BH-2). The overrun check compares the real cost with the attempt's reservation N.
 */
function commitReconciled(ctx: EngineCtx, fx: PostCommitEffect[], i: ReconcileInput): boolean {
  const a = i.attempt;
  const outcome = reconciledOutcome(i);
  return ctx.db.tx('immediate', (r) => {
    const now = ctx.clock.now();
    const usage = i.res.usage;
    // A failure without known usage keeps the estimate (never resolved to $0): the attempt is abandoned.
    const keep = i.res.kind === 'failed' && i.res.flags.usageKnown === false;
    const to = keep ? 'abandoned' : i.res.kind === 'completed' ? 'reconciled_succeeded' : 'reconciled_failed';
    const won = r.attempts.transition(a.id, ['unknown'], to, {
      usage: usage === null ? null : { ...usage }, rawUsage: i.res.kind === 'completed' ? redactDeep(i.res.rawUsage) : null, finishedAt: now,
      error: outcome.error,
    });
    if (!won) return false; // retried by the user or reconciled elsewhere meanwhile
    const run = r.runs.get(a.runId);
    const N = a.reservationMicrousd;
    const { cost, event: settledCost } = settleReconciled(r, a, i.res, keep);
    if (keep) r.attempts.markLookupDone(a.id); // D1-3: a definitive answer without usage is never looked up again
    for (const put of i.puts) {
      if (!put.ok) continue;
      r.artifacts.insertIfAbsent({ ...put.meta, stepRunId: a.stepRunId, attemptId: a.id });
      appendRunEvent(r, fx, a.runId, 'artifact.created', { artifactId: put.meta.id, kind: put.meta.kind, attemptId: a.id, stepRunId: a.stepRunId });
    }
    appendRunEvent(r, fx, a.runId, 'attempt.settled', { attemptId: a.id, stepRunId: a.stepRunId, reconciled: i.res.kind, estimateKept: keep, cost: settledCost });
    const step = r.steps.get(a.stepRunId);
    const { event } = applyPostValidation(r, fx, ctx, { source: 'reconcile', stepRunId: a.stepRunId, runId: a.runId, attemptId: a.id, outcome,
      policy: effectiveStepSnapshot(r, run, step.stepKey).retryPolicy, purpose: a.purpose, output: i.output, cost, N, now });
    if (isDeferrablePause(event)) {
      // A running run (e.g. resumed meanwhile) takes the pause now, exactly like a live settle; otherwise it is
      // stored durably and applied by the next event that would let the run continue (clarification 14).
      const cur = r.runs.get(a.runId);
      if (cur.status === 'running') applyRunEvent(r, cur, event, now, fx);
      else deferPause(r, fx, a.runId, event);
    }
    resumeIfUnknownsResolved(r, fx, a.runId, now);
    return true;
  });
}

/**
 * Decision 1: an uncertain attempt the user already retried (`abandoned`) can only have its COST corrected — its
 * step moved on, so no output, step or run change. Skipped once nothing estimated is left (already corrected).
 */
function commitCostCorrection(ctx: EngineCtx, fx: PostCommitEffect[], a: AttemptRow, res: Resolution): boolean {
  return ctx.db.tx('immediate', (r) => {
    const cur = currentCharge(r, a);
    if (cur.legacyLiability > 0 || cur.estimate <= 0) return false;
    if (res.kind === 'failed' && res.flags.usageKnown === false) {
      r.attempts.markLookupDone(a.id); // D1-3: nothing better than the estimate, ever: no lookup at the next start
      return false;
    }
    const { X, certainty } = reconciledAmount(res, a.profileSnapshot.prices, cur.estimate);
    const run = r.runs.get(a.runId);
    const at = correctionDateOf(r.ledger.listForRun(a.runId).map((x) => x.entry), a); // D1-1: the estimate's month
    r.ledger.append(correctionEntries({ attemptId: a.id, runId: a.runId, projectId: run.projectId, priceCatalogVersion: a.priceCatalogVersion, createdAt: at,
      estimate: cur.estimate, X, certainty }));
    if (res.usage !== null) r.attempts.transition(a.id, ['abandoned'], 'abandoned', { usage: { ...res.usage } });
    appendRunEvent(r, fx, a.runId, 'attempt.settled', { attemptId: a.id, stepRunId: a.stepRunId, reconciled: res.kind, correctionOnly: true,
      cost: { kind: 'known', microusd: X, certainty } });
    return true;
  });
}

async function settleResolution(ctx: EngineCtx, attempt: AttemptRow, res: Resolution): Promise<void> {
  if (attempt.state === 'abandoned') {
    const fx: PostCommitEffect[] = [];
    const corrected = commitCostCorrection(ctx, fx, attempt, res);
    await runEffects(ctx, fx);
    if (corrected && isTerminalRunStatus(ctx.db.repos.runs.get(attempt.runId).status)) await refreshReport(ctx, attempt.runId);
    return;
  }
  const run = ctx.db.repos.runs.get(attempt.runId);
  const step = ctx.db.repos.steps.get(attempt.stepRunId);
  const puts: ArtifactPut[] = [];
  let validated: Validation | null = null;
  let output: { id: ArtifactId; value: unknown } | null = null;
  if (res.kind === 'completed') {
    const stepSnap = effectiveStepSnapshot(ctx.db.repos, run, step.stepKey);
    const raw = JSON.stringify(res.json);
    puts.push(await putArtifact(ctx, run, { kind: 'raw_response', bytes: utf8(redactString(raw)), mediaType: isJsonText(raw) ? 'application/json' : 'text/plain' }));
    validated = validateOutput(stepSnap, res.json, ctx.templates, await loadValidationInputs(ctx, run));
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
  // Round-3 M5: the settlement changed the costs of a FINISHED run: its report is replaced by a fresh one.
  if (committed && isTerminalRunStatus(ctx.db.repos.runs.get(attempt.runId).status)) await refreshReport(ctx, attempt.runId);
}

/**
 * F9b for one attempt: credential (`dispatch`, the attempt's id) → `adapter.reconcile` outside any tx → settle.
 * `in_progress` is re-polled up to {@link RECONCILE_MAX_POLLS} times; `not_found` leaves the attempt unknown.
 */
export async function reconcileAttempt(ctx: EngineCtx, attempt: AttemptRow, signal: AbortSignal): Promise<ReconcileOutcome> {
  const found = adapterOf(ctx, attempt.providerId);
  if (!found.ok) return 'skipped'; // no adapter: the attempt stays unknown (the user decides)
  const adapter = found.value;
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

/**
 * An `abandoned` uncertain attempt is looked up only while its estimate is still uncorrected and no lookup answered
 * definitively without usage (D1-3: a corrected or kept one never costs another provider lookup at the next start).
 * `unknown` attempts always qualify.
 */
function stillToCorrect(ctx: Pick<EngineCtx, 'db'>, a: AttemptRow): boolean {
  if (a.state !== 'abandoned') return true;
  if (a.lookupDone) return false; // D1-3: the provider already answered definitively (no usage): the estimate stays
  return settledByCertaintyOf(ctx.db.repos.ledger.listForRun(a.runId).map((x) => x.entry), a.id).estimated > 0;
}

/** F9b: reconciles every eligible uncertain attempt (sequentially). Never throws; failures are logged. */
export async function reconcileUnknownAttempts(ctx: EngineCtx, signal: AbortSignal): Promise<Map<AttemptId, ReconcileOutcome>> {
  const out = new Map<AttemptId, ReconcileOutcome>();
  for (const a of ctx.db.repos.attempts.listReconcileCandidates().filter((a) => isReconcilable(ctx, a) && stillToCorrect(ctx, a))) {
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
