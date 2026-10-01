// 06 F2 "Who emits RESUME_RESOLVED" + F7 + F12: the user decisions on a blocked run — `runs.resume` (every
// RecoveryDecision kind), `runs.increaseAllowance`, `runs.decideUnknown`, `runs.retryStep`, and the re-evaluation of
// `paused(budget_project)` runs after a project allowance edit. Async resolution (profiles, estimates, file hashes)
// happens BEFORE each transaction; the transaction re-reads the run, applies the decision + the run transition, and
// stores the idempotency result (02 §B0: a replay returns the stored result and never re-applies the decision).
import { RUN_LIMIT_MAXIMUMS, err, errors, ok } from '@relay/contracts';
import type {
  AppError,
  AttemptId,
  BudgetBreakdown,
  CostSummary,
  EpochMs,
  Microusd,
  PauseReason,
  ProfileId,
  ProfileSnapshot,
  RecoveryDecision,
  Result,
  RunDetail,
  RunId,
  RunStatus,
  StepKey,
  StepRunId,
} from '@relay/contracts';
import type { ConfigRevisionReason, Repos, RunRow, StepRow } from '@relay/storage';
import type { InputDrift } from './approval-binding.js';
import { inputDrift, invalidateApproval } from './approval-binding.js';
import { admit, resolveUnknownEntries } from './budget.js';
import { buildModelRequest } from './checkpoints.js';
import { monthWindow } from './clock.js';
import { executionMsAt } from './deadline.js';
import { requestHash } from './hash.js';
import type { EngineCtx } from './ports.js';
import { toModelProfile } from './profiles.js';
import { pendingDeferredPause } from './outcome.js';
import { resumeIfUnknownsResolved } from './recovery.js';
import { nextPurpose } from './retry.js';
import type { PostCommitEffect } from './run-machine.js';
import { appendRunEvent, applyRunEvent, isTerminal, runEffects } from './run-machine.js';
import { resolveProfile } from './run-start.js';
import { RESNAPSHOT_KIND, ancestorsOf, effectiveStepSnapshot, hasSnapshotPreserved, snapshotOf } from './snapshot.js';
import type { Snapshotted } from './steps/intake.js';
import { diffReferencedPaths, inputFileRows, intakeContextHash, snapshotSelectedFiles } from './steps/intake.js';
import { applyStepEvent, isTerminalStep } from './step-machine.js';
import { allLedgerEntries, attemptsOverran, costSummaryOf, toRunDetail } from './views.js';

// ---------------------------------------------------------------- shared helpers

type Tx<T> = (r: Repos, fx: PostCommitEffect[], now: EpochMs) => Result<T>;

/** Runs `fn` in one tx; post-commit effects run only when it committed a success. */
async function inTx<T>(ctx: EngineCtx, fn: Tx<T>): Promise<Result<T>> {
  const fx: PostCommitEffect[] = [];
  const res = ctx.db.txResult('immediate', (r) => fn(r, fx, ctx.clock.now()));
  if (res.ok) await runEffects(ctx, fx);
  return res;
}

/** Idempotent replay (02 §B0): the stored ids, CONFLICT for the same key with another request, or null. */
function storedFor(r: Repos, op: string, input: { readonly idempotencyKey: string }): Result<{ runId: RunId; status: string | undefined }> | null {
  const stored = r.idempotency.get(op, input.idempotencyKey);
  if (stored === undefined) return null;
  if (stored.requestHash !== requestHash({ ...input })) return err(errors.conflict({ reason: 'idempotency_key_reused', op }));
  return ok({ runId: stored.result.ids['runId'] as RunId, status: stored.result.status });
}

function remember(r: Repos, op: string, input: { readonly idempotencyKey: string }, runId: RunId): void {
  r.idempotency.put(op, input.idempotencyKey, requestHash({ ...input }), { ids: { runId }, status: r.runs.get(runId).status });
}

const notApplicable = (run: RunRow, decision: string): AppError =>
  errors.conflict({ reason: 'decision_not_applicable', decision, status: run.status, pauseReason: run.pauseReason });

const isPausedFor = (run: RunRow, reasons: readonly PauseReason[]): boolean =>
  run.status === 'paused' && run.pauseReason !== null && reasons.includes(run.pauseReason);

function runDetail(ctx: EngineCtx, runId: RunId): RunDetail {
  return toRunDetail(ctx.db.repos, ctx.db.repos.runs.getInspectorProjection(runId));
}

/** The run's model steps whose latest row still has work (not succeeded / skipped). */
function openModelSteps(r: Repos, run: RunRow): StepRow[] {
  const snapshot = snapshotOf(run);
  return r.steps.latestPerStepKey(run.id).filter((s) => snapshot.steps[s.stepKey]?.kind === 'model' && s.state !== 'succeeded' && s.state !== 'skipped');
}

/** A permitted profile for `stepKey` (provider ∈ project policy, `checkProfile` against live capabilities). */
async function permittedProfile(ctx: EngineCtx, run: RunRow, stepKey: StepKey, profileId: ProfileId): Promise<Result<ProfileSnapshot>> {
  const row = ctx.db.repos.profiles.get(profileId);
  if (row === undefined) return err(errors.notFound('profile'));
  const project = ctx.db.repos.projects.get(run.projectId);
  return resolveProfile(ctx, project, stepKey, toModelProfile(row));
}

/** R3-13: appends a config revision + `run.config_revised` (the effective profile of `stepKey` from now on). */
function reviseConfig(r: Repos, fx: PostCommitEffect[], run: RunRow, stepKey: StepKey, next: ProfileSnapshot, reason: ConfigRevisionReason): void {
  const prev = effectiveStepSnapshot(r, run, stepKey).profile;
  const rev = r.configRevisions.append(run.id, stepKey, prev, next, reason);
  appendRunEvent(r, fx, run.id, 'run.config_revised', { stepKey, stepRunId: r.steps.latestFor(run.id, stepKey)?.id ?? null, revision: rev.revision, reason, from: prev.name, to: next.name, providerId: next.providerId, modelId: next.modelId });
}

function revisionReason(run: RunRow): ConfigRevisionReason {
  if (run.pauseReason === 'model_refused') return 'model_refused';
  if (run.pauseReason === 'budget_run' || run.pauseReason === 'budget_project') return 'budget_cheaper_profile';
  return 'user_switch';
}

// ---------------------------------------------------------------- next-admission estimate (increaseAllowance, projects.update)

/**
 * N of the next eligible model step, built exactly like dispatch (context → request → adapter estimate), or null
 * when no model step is left or the estimate cannot be built (the loop's authoritative checks then decide).
 */
export async function estimateNextReservation(ctx: EngineCtx, runId: RunId): Promise<Microusd | null> {
  const r = ctx.db.repos;
  const run = r.runs.get(runId);
  const step = openModelSteps(r, run).find((s) => s.state === 'ready' || s.state === 'pending');
  if (step === undefined) return null;
  try {
    const stepSnap = effectiveStepSnapshot(r, run, step.stepKey);
    const prior = r.attempts.listForStep(step.id);
    const purpose = nextPurpose(step, prior);
    const assembled = await ctx.context.assemble({ run, step, snapshot: stepSnap.profile, stepSpec: stepSnap,
      preservedSnapshot: hasSnapshotPreserved(r, runId), purpose, priorAttempts: prior });
    if (!assembled.ok) return null;
    const request = buildModelRequest(ctx.templates, stepSnap, assembled.value, { attemptId: 'estimate', runId, stepKey: step.stepKey, purpose },
      r.projects.get(run.projectId).providerPolicy.providerOptions);
    const adapter = ctx.providers.get(stepSnap.profile.providerId);
    const credential = await ctx.credentials.resolve({ providerId: stepSnap.profile.providerId, purpose: 'dispatch', attemptId: null });
    const estimate = await adapter.estimate(request, stepSnap.profile.prices, {
      ...(credential.ok ? { apiKey: credential.value } : {}), priceCatalogVersion: stepSnap.profile.priceCatalogVersion,
    });
    return estimate.upperAllowanceMicrousd;
  } catch (e) {
    ctx.logger.warn('estimate.next_failed', { runId, err: e instanceof Error ? e.name : 'unknown' });
    return null;
  }
}

/** Read-only §9.3 admission of N for `run` inside the caller's tx (null N = nothing to admit → passes). */
function nextAdmission(r: Repos, run: RunRow, N: Microusd | null, now: EpochMs): { ok: boolean; breakdown: BudgetBreakdown | null } {
  if (N === null) return { ok: true, breakdown: null };
  const project = r.projects.get(run.projectId);
  const { start, end } = monthWindow(now);
  const decision = admit({
    run: r.ledger.runBalances(run.id), N,
    project: project.monthlyAllowanceMicrousd === null ? null : { L: project.monthlyAllowanceMicrousd, ...r.ledger.projectMonthBalances(run.projectId, start, end) },
  });
  return { ok: decision.ok, breakdown: decision.breakdown };
}

// ---------------------------------------------------------------- runs.resume

/** Parsed `runs.resume` input. */
export interface ResumeInput {
  readonly idempotencyKey: string;
  readonly runId: RunId;
  readonly decision: RecoveryDecision;
}

type Prepared = { readonly profile?: ProfileSnapshot; readonly drift?: InputDrift; readonly resnapshot?: readonly Snapshotted[] };

function resumeContinue(r: Repos, fx: PostCommitEffect[], run: RunRow, now: EpochMs): Result<void> {
  if (run.status === 'interrupted') {
    // F2: RECOVERY_DECIDED only when every unknown attempt has been decided (review_recovery).
    const unknownAttempts = r.attempts.listForRun(run.id).filter((a) => a.state === 'unknown').length;
    if (unknownAttempts > 0) return err(errors.conflict({ reason: 'unknown_attempts', unknownAttempts }));
    // A reconciled overrun (X > liability) or scope change is never acknowledged by review_recovery: the run pauses
    // with that reason (budget_overrun → acknowledge_overrun), the same invariant as a live run (BH-2, BH-6).
    applyRunEvent(r, run, pendingDeferredPause(r, run.id) ?? { type: 'RECOVERY_DECIDED' }, now, fx);
    return ok(undefined);
  }
  if (!isPausedFor(run, ['user', 'rate_limited', 'auth_required', 'setup_blocked'])) return err(notApplicable(run, 'continue'));
  if (run.pauseReason === 'auth_required') {
    const missing = [...new Set(openModelSteps(r, run).map((s) => effectiveStepSnapshot(r, run, s.stepKey).profile.providerId))]
      .find((p) => r.credentials.get(p) === undefined);
    if (missing !== undefined) return err(errors.authRequired(missing));
  }
  if (run.pauseReason === 'rate_limited') {
    // F2: resuming from rate_limited resets the ready step's wait counter.
    for (const s of r.steps.latestPerStepKey(run.id)) {
      if (s.state === 'ready' && s.rateLimitWaitsUsed > 0) r.steps.transition(s.id, ['ready'], 'ready', { rateLimitWaitsUsed: 0, notBeforeAt: null });
    }
  }
  applyRunEvent(r, run, { type: 'RESUME_RESOLVED' }, now, fx);
  return ok(undefined);
}

/** Supersedes the open (non-terminal) latest rows of `keys` with fresh `pending` rows (revision_index + 1). */
function supersede(r: Repos, fx: PostCommitEffect[], ctx: EngineCtx, run: RunRow, keys: readonly StepKey[], now: EpochMs): void {
  const latest = r.steps.latestPerStepKey(run.id);
  const rows = latest.filter((s) => keys.includes(s.stepKey) && s.state !== 'pending');
  for (const s of rows) if (!isTerminalStep(s.state)) applyStepEvent(r, fx, s, 'RUN_CANCELLED');
  r.steps.insertMany(rows.map((s) => ({ id: ctx.ids.next('stepRun'), runId: run.id, stepKey: s.stepKey, ordinal: s.ordinal,
    revisionIndex: s.revisionIndex + 1, state: 'pending' as const, profileName: s.profileName, createdAt: now })));
}

/** Approval steps whose latest row still waits on an invalidated approval get a fresh row (a new approval opens). */
function reopenStaleApprovals(r: Repos, fx: PostCommitEffect[], ctx: EngineCtx, run: RunRow, now: EpochMs): void {
  const snapshot = snapshotOf(run);
  const stale = r.steps.latestPerStepKey(run.id).filter((s) => snapshot.steps[s.stepKey]?.kind === 'approval' && s.state === 'awaiting_approval');
  if (stale.length > 0 && r.approvals.pendingForRun(run.id) === undefined) supersede(r, fx, ctx, run, stale.map((s) => s.stepKey), now);
}

function resumePreserved(r: Repos, fx: PostCommitEffect[], ctx: EngineCtx, run: RunRow, now: EpochMs): Result<void> {
  if (!isPausedFor(run, ['approval_stale'])) return err(notApplicable(run, 'use_preserved_snapshot'));
  // Only a project change can be answered with the preserved snapshot; a changed plan/scope/provider needs a replan.
  if (run.statusDetail?.code !== 'PROJECT_CHANGED') return err(errors.conflict({ reason: 'not_a_project_change', code: run.statusDetail?.code ?? null }));
  appendRunEvent(r, fx, run.id, 'run.snapshot_preserved', { at: now });
  reopenStaleApprovals(r, fx, ctx, run, now);
  applyRunEvent(r, run, { type: 'RESUME_RESOLVED' }, now, fx);
  return ok(undefined);
}

/**
 * F10 re-snapshot (inside the replan tx): the files re-read before the tx become the run's input snapshot
 * (`RunRepo.replaceInputFiles`, new `input_file` artifacts), and `runs.context_hash` is recomputed — the new plan's
 * approval binds the new hashes. Recorded as `context.assembled { kind: resnapshot }` (a fresh snapshot binding:
 * an earlier `use_preserved_snapshot` no longer applies).
 */
function resnapshotInputs(r: Repos, fx: PostCommitEffect[], run: RunRow, files: readonly Snapshotted[], drift: InputDrift | undefined, now: EpochMs): void {
  const rows = inputFileRows(r, run, files, now);
  r.runs.replaceInputFiles(run.id, rows);
  const contextHash = intakeContextHash(r, run);
  r.runs.setContextHash(run.id, contextHash);
  appendRunEvent(r, fx, run.id, 'context.assembled', { kind: RESNAPSHOT_KIND, contextHash, files: rows.length,
    changedPaths: drift?.changed ?? [], previousContextHash: run.contextHash });
}

function resumeReplan(r: Repos, fx: PostCommitEffect[], ctx: EngineCtx, run: RunRow, pre: Prepared, now: EpochMs): Result<void> {
  if (!isPausedFor(run, ['approval_stale'])) return err(notApplicable(run, 'resnapshot_and_replan'));
  if (pre.resnapshot !== undefined) resnapshotInputs(r, fx, run, pre.resnapshot, pre.drift, now);
  const snapshot = snapshotOf(run);
  const planKey = Object.keys(snapshot.steps).find((k) => {
    const s = snapshot.steps[k];
    return s?.kind === 'model' && s.outputSchema === 'plan.v1';
  }) as StepKey | undefined;
  if (planKey === undefined) return err(errors.conflict({ reason: 'no_plan_step' }));
  const downstream = Object.keys(snapshot.steps).filter((k) => ancestorsOf(snapshot, k as StepKey).has(planKey)) as StepKey[];
  for (const a of [r.approvals.latestApprovedForRun(run.id), r.approvals.pendingForRun(run.id)]) {
    if (a !== undefined) invalidateApproval(r, fx, run.id, a.id, 'plan_changed', now);
  }
  supersede(r, fx, ctx, run, [planKey, ...downstream.filter((k) => snapshot.steps[k]?.kind !== 'finalize')], now);
  // BH-4: quality-revision cycles count under ONE approval; the new plan's approval starts at cycle 0 (so its first
  // implementation is validated as a first implementation, not as a revision).
  if (run.revisionCycle !== 0) r.runs.setRevisionCycle(run.id, 0);
  applyRunEvent(r, run, { type: 'RESUME_RESOLVED' }, now, fx);
  return ok(undefined);
}

function resumeSwitchProfile(r: Repos, fx: PostCommitEffect[], run: RunRow, d: { stepKey: StepKey }, pre: Prepared, now: EpochMs): Result<void> {
  if (!isPausedFor(run, ['budget_run', 'budget_project', 'setup_blocked', 'output_invalid', 'provider_unavailable', 'model_refused', 'unknown_outcome'])) {
    return err(notApplicable(run, 'switch_profile'));
  }
  const step = r.steps.latestFor(run.id, d.stepKey);
  if (step === undefined || snapshotOf(run).steps[d.stepKey]?.kind !== 'model') {
    return err(errors.validationFailed([{ path: 'decision.stepKey', message: 'Not a model step of this run.', code: 'unknown_step' }]));
  }
  // A failed step changes profile through runs.retryStep (a new row); a finished step cannot change.
  if (step.state !== 'ready' && step.state !== 'pending') {
    return err(errors.conflict({ reason: 'step_not_ready', state: step.state, ...(step.state === 'failed' ? { useOp: 'relay/v1/runs.retryStep' } : {}) }));
  }
  if (pre.profile === undefined) return err(errors.notFound('profile'));
  reviseConfig(r, fx, run, d.stepKey, pre.profile, revisionReason(run));
  r.steps.transition(step.id, [step.state], step.state, { profileName: pre.profile.name });
  applyRunEvent(r, run, { type: 'RESUME_RESOLVED' }, now, fx);
  return ok(undefined);
}

function resumeRaiseLimits(
  r: Repos,
  fx: PostCommitEffect[],
  run: RunRow,
  d: { maxAttempts?: number | undefined; executionTimeoutSeconds?: number | undefined },
  now: EpochMs,
): Result<void> {
  if (!isPausedFor(run, ['limit_attempts', 'deadline'])) return err(notApplicable(run, 'raise_limits'));
  const issues = [];
  if (d.maxAttempts !== undefined && (d.maxAttempts <= run.attemptCount || d.maxAttempts > RUN_LIMIT_MAXIMUMS.maxAttempts)) {
    issues.push({ path: 'decision.maxAttempts', message: `Must be above the ${String(run.attemptCount)} attempts already used.`, code: 'not_above_used' });
  }
  const t = d.executionTimeoutSeconds;
  if (t !== undefined && (t * 1000 <= executionMsAt(run, now) || t > RUN_LIMIT_MAXIMUMS.executionTimeoutSeconds)) {
    issues.push({ path: 'decision.executionTimeoutSeconds', message: 'Must be above the execution time already used.', code: 'not_above_used' });
  }
  if (run.pauseReason === 'limit_attempts' && d.maxAttempts === undefined) issues.push({ path: 'decision.maxAttempts', message: 'Raise the attempt limit to continue.', code: 'required' });
  if (run.pauseReason === 'deadline' && t === undefined) issues.push({ path: 'decision.executionTimeoutSeconds', message: 'Raise the execution time to continue.', code: 'required' });
  if (issues.length > 0) return err(errors.validationFailed(issues));
  const limits = { ...run.limits, ...(d.maxAttempts === undefined ? {} : { maxAttempts: d.maxAttempts }), ...(t === undefined ? {} : { executionTimeoutSeconds: t }) };
  r.runs.setLimits(run.id, limits); // F12: in the same tx (CAS) as RESUME_RESOLVED
  appendRunEvent(r, fx, run.id, 'run.limits_raised', { from: run.limits, to: limits });
  applyRunEvent(r, run, { type: 'RESUME_RESOLVED' }, now, fx);
  return ok(undefined);
}

function applyResume(r: Repos, fx: PostCommitEffect[], ctx: EngineCtx, run: RunRow, d: RecoveryDecision, pre: Prepared, now: EpochMs): Result<void> {
  switch (d.kind) {
    case 'continue':
      return resumeContinue(r, fx, run, now);
    case 'use_preserved_snapshot':
      return resumePreserved(r, fx, ctx, run, now);
    case 'resnapshot_and_replan':
      return resumeReplan(r, fx, ctx, run, pre, now);
    case 'switch_profile':
      return resumeSwitchProfile(r, fx, run, d, pre, now);
    case 'raise_limits':
      return resumeRaiseLimits(r, fx, run, d, now);
    case 'acknowledge_overrun':
      if (!isPausedFor(run, ['budget_overrun'])) return err(notApplicable(run, d.kind));
      applyRunEvent(r, run, { type: 'RESUME_RESOLVED' }, now, fx); // admission still applies at the next dispatch
      return ok(undefined);
  }
}

async function prepareResume(ctx: EngineCtx, run: RunRow, d: RecoveryDecision): Promise<Result<Prepared>> {
  if (d.kind === 'switch_profile') {
    const profile = await permittedProfile(ctx, run, d.stepKey, d.profileId);
    return profile.ok ? ok({ profile: profile.value }) : profile;
  }
  if (d.kind === 'resnapshot_and_replan' && isPausedFor(run, ['approval_stale'])) {
    const drift = await inputDrift(ctx, run);
    if (drift.changed.length === 0) return ok({ drift });
    // F10: the project changed — re-read and re-snapshot the run's files through the tools (outside any tx). A file
    // that can no longer be read (deleted, excluded, too large) fails the decision with that error. A diff-input run
    // re-reads the current files its imported diff references.
    const relPaths = run.input.kind === 'files' ? ok(run.input.relPaths) : await diffReferencedPaths(ctx, run.projectId, run.input.diffArtifactId);
    if (!relPaths.ok) return relPaths;
    const files = await snapshotSelectedFiles(ctx, run.id, relPaths.value);
    if ('error' in files) return err(files.error);
    return ok({ drift, resnapshot: files });
  }
  return ok({});
}

/** `runs.resume` (every RecoveryDecision kind). */
export async function resumeRun(ctx: EngineCtx, input: ResumeInput): Promise<Result<{ status: RunStatus }>> {
  const OP = 'runs.resume';
  const replay = storedFor(ctx.db.repos, OP, input);
  if (replay !== null) return replay.ok ? ok({ status: ctx.db.repos.runs.get(replay.value.runId).status }) : replay;
  const run = ctx.db.repos.runs.get(input.runId);
  const pre = await prepareResume(ctx, run, input.decision);
  if (!pre.ok) return pre;
  const res = await inTx(ctx, (r, fx, now) => {
    const again = storedFor(r, OP, input);
    if (again !== null) return again.ok ? ok({ status: r.runs.get(again.value.runId).status }) : again;
    const cur = r.runs.get(input.runId);
    const applied = applyResume(r, fx, ctx, cur, input.decision, pre.value, now);
    if (!applied.ok) return applied;
    remember(r, OP, input, cur.id);
    return ok({ status: r.runs.get(cur.id).status });
  });
  if (res.ok) ctx.wake.signal();
  return res;
}

// ---------------------------------------------------------------- runs.increaseAllowance

/** Parsed `runs.increaseAllowance` input. */
export interface IncreaseAllowanceInput {
  readonly idempotencyKey: string;
  readonly runId: RunId;
  readonly newAllowanceMicrousd: Microusd;
}

function costNow(r: Repos, runId: RunId): CostSummary {
  return costSummaryOf(r.ledger.runBalances(runId), r.ledger.settledByCertainty(runId), attemptsOverran(allLedgerEntries(r, runId)));
}

/**
 * `runs.increaseAllowance`: `allowance_change +(L′ − L)` (a model can never reach this), and an automatic
 * RESUME_RESOLVED on `paused(budget_run | budget_overrun)` when the next admission would now pass.
 */
export async function increaseAllowance(ctx: EngineCtx, input: IncreaseAllowanceInput): Promise<Result<{ cost: CostSummary; status: RunStatus; budget: BudgetBreakdown | null }>> {
  const OP = 'runs.increaseAllowance';
  const replay = storedFor(ctx.db.repos, OP, input);
  if (replay !== null) return replay.ok ? ok({ cost: costNow(ctx.db.repos, input.runId), status: ctx.db.repos.runs.get(input.runId).status, budget: null }) : replay;
  const before = ctx.db.repos.runs.get(input.runId);
  const N = isPausedFor(before, ['budget_run', 'budget_overrun']) ? await estimateNextReservation(ctx, before.id) : null;
  const res = await inTx(ctx, (r, fx, now) => {
    const run = r.runs.get(input.runId);
    if (isTerminal(run.status) || run.status === 'cancelling') return err(errors.conflict({ reason: 'run_terminal', status: run.status }));
    const L = r.ledger.runBalances(run.id).L;
    if (input.newAllowanceMicrousd <= L) {
      return err(errors.validationFailed([{ path: 'newAllowanceMicrousd', message: 'The new allowance must be larger than the current one.', code: 'not_an_increase' }]));
    }
    r.ledger.append([{ scope: 'run', type: 'allowance_change', bucket: 'allowance', deltaMicrousd: input.newAllowanceMicrousd - L, runId: run.id,
      projectId: run.projectId, attemptId: null, createdAt: now }]);
    r.runs.setLimits(run.id, { ...run.limits, budgetMicrousd: input.newAllowanceMicrousd });
    appendRunEvent(r, fx, run.id, 'run.limits_raised', { budgetMicrousd: { from: L, to: input.newAllowanceMicrousd } });
    let budget: BudgetBreakdown | null = null;
    if (isPausedFor(run, ['budget_run', 'budget_overrun'])) {
      const next = nextAdmission(r, run, N, now);
      if (next.ok) applyRunEvent(r, r.runs.get(run.id), { type: 'RESUME_RESOLVED' }, now, fx);
      else budget = next.breakdown;
    }
    remember(r, OP, input, run.id);
    return ok({ cost: costNow(r, run.id), status: r.runs.get(run.id).status, budget });
  });
  if (res.ok) ctx.wake.signal();
  return res;
}

/**
 * `projects.update` follow-up (edit_project_allowance): every `paused(budget_project)` run of the project whose next
 * admission would now pass gets RESUME_RESOLVED. Returns the resumed run ids.
 */
export async function reevaluateProjectBudget(ctx: EngineCtx, projectId: RunRow['projectId']): Promise<RunId[]> {
  const page = ctx.db.repos.runs.list({ projectId, statuses: ['paused'], limit: 100 });
  const runs = page.ok ? page.value.items.filter((x) => x.pauseReason === 'budget_project') : [];
  const resumed: RunId[] = [];
  for (const run of runs) {
    const N = await estimateNextReservation(ctx, run.id);
    const res = await inTx(ctx, (r, fx, now) => {
      const cur = r.runs.get(run.id);
      if (!isPausedFor(cur, ['budget_project']) || !nextAdmission(r, cur, N, now).ok) return ok(false);
      applyRunEvent(r, cur, { type: 'RESUME_RESOLVED' }, now, fx);
      return ok(true);
    });
    if (res.ok && res.value) resumed.push(run.id);
  }
  if (resumed.length > 0) ctx.wake.signal();
  return resumed;
}

// ---------------------------------------------------------------- runs.decideUnknown

/** Parsed `runs.decideUnknown` input. */
export interface DecideUnknownInput {
  readonly idempotencyKey: string;
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly decision: 'retry_acknowledging_charge' | 'mark_failed_keep_liability' | 'accept_estimated_charge';
}

function applyUnknownDecision(r: Repos, fx: PostCommitEffect[], run: RunRow, input: DecideUnknownInput, now: EpochMs): Result<void> {
  const a = r.attempts.find(input.attemptId);
  if (a?.runId !== run.id) return err(errors.notFound('attempt'));
  if (a.state !== 'unknown') return err(errors.conflict({ reason: 'attempt_not_unknown', state: a.state }));
  const step = r.steps.get(a.stepRunId);
  const unknownError = errors.requestOutcomeUnknown(a.id, { details: { decision: input.decision } });
  switch (input.decision) {
    case 'retry_acknowledging_charge':
      // R4-28: the liability stays; the attempt no longer prompts. The next attempt is a user_retry of this one.
      r.attempts.transition(a.id, ['unknown'], 'abandoned', { error: unknownError, finishedAt: now });
      if (step.state === 'unknown') applyStepEvent(r, fx, step, 'USER_RETRY', { error: null, notBeforeAt: null });
      break;
    case 'mark_failed_keep_liability':
      r.attempts.transition(a.id, ['unknown'], 'abandoned', { error: unknownError, finishedAt: now });
      if (step.state === 'unknown') applyStepEvent(r, fx, step, 'USER_ABANDON', { error: errors.requestOutcomeUnknown(a.id) });
      break;
    case 'accept_estimated_charge': {
      const liability = r.ledger.attemptBalances(a.id).unknown;
      r.ledger.append(resolveUnknownEntries({ liability, settled: liability, certainty: 'estimated', attemptId: a.id, runId: run.id,
        projectId: run.projectId, priceCatalogVersion: a.priceCatalogVersion, createdAt: now }));
      r.attempts.transition(a.id, ['unknown'], 'failed', { error: errors.requestOutcomeUnknown(a.id, { details: { chargeAccepted: true } }), finishedAt: now });
      if (step.state === 'unknown') applyStepEvent(r, fx, step, 'USER_ABANDON', { error: errors.requestOutcomeUnknown(a.id) });
      break;
    }
  }
  appendRunEvent(r, fx, run.id, 'attempt.settled', { attemptId: a.id, stepRunId: a.stepRunId, decision: input.decision });
  resumeIfUnknownsResolved(r, fx, run.id, now);
  return ok(undefined);
}

/** `runs.decideUnknown` (§4.4, §7.5) on `paused(unknown_outcome)` or `interrupted`. */
export async function decideUnknown(ctx: EngineCtx, input: DecideUnknownInput): Promise<Result<RunDetail>> {
  const OP = 'runs.decideUnknown';
  const replay = storedFor(ctx.db.repos, OP, input);
  if (replay !== null) return replay.ok ? ok(runDetail(ctx, input.runId)) : replay;
  const res = await inTx(ctx, (r, fx, now) => {
    const run = r.runs.get(input.runId);
    if (!(isPausedFor(run, ['unknown_outcome']) || run.status === 'interrupted')) return err(notApplicable(run, input.decision));
    const applied = applyUnknownDecision(r, fx, run, input, now);
    if (!applied.ok) return applied;
    remember(r, OP, input, run.id);
    return ok(undefined);
  });
  if (!res.ok) return res;
  ctx.wake.signal();
  return ok(runDetail(ctx, input.runId));
}

// ---------------------------------------------------------------- runs.retryStep

/** Parsed `runs.retryStep` input. */
export interface RetryStepInput {
  readonly idempotencyKey: string;
  readonly runId: RunId;
  readonly stepId: StepRunId;
  readonly profileId?: ProfileId | undefined;
}

/**
 * Pauses whose failed step `runs.retryStep` accepts (retry_step, and choose_profile on a failed step). A responded
 * 4xx pauses as provider_unavailable (BH-1); `setup_blocked` is listed only so a run paused that way by an earlier
 * build with a FAILED step is not stuck (choose_profile maps to retryStep for a failed step, 02 B5).
 */
const RETRYABLE_PAUSES: readonly PauseReason[] = ['output_invalid', 'provider_unavailable', 'model_refused', 'unknown_outcome', 'setup_blocked'];

function applyRetryStep(r: Repos, fx: PostCommitEffect[], ctx: EngineCtx, run: RunRow, input: RetryStepInput, profile: ProfileSnapshot | null, now: EpochMs): Result<void> {
  if (!isPausedFor(run, RETRYABLE_PAUSES)) return err(notApplicable(run, 'retry_step'));
  const step = r.steps.find(input.stepId);
  if (step?.runId !== run.id) return err(errors.notFound('step'));
  const latest = r.steps.latestFor(run.id, step.stepKey);
  // F7: only for a FAILED step (its latest row); budget/setup pauses change profile through switch_profile.
  if (latest?.id !== step.id || step.state !== 'failed' || snapshotOf(run).steps[step.stepKey]?.kind !== 'model') {
    return err(errors.conflict({ reason: 'step_not_failed', state: step.state }));
  }
  if (r.attempts.listForRun(run.id).some((a) => a.state === 'unknown')) return err(errors.conflict({ reason: 'unknown_attempts' }));
  if (run.attemptCount >= run.limits.maxAttempts) return err(errors.limitReached('attempts'));
  if (profile !== null) reviseConfig(r, fx, run, step.stepKey, profile, revisionReason(run));
  const next = r.steps.insertRetry(step, { id: ctx.ids.next('stepRun'), state: 'ready', profileName: profile?.name ?? step.profileName, createdAt: now });
  appendRunEvent(r, fx, run.id, 'step.state_changed', { stepRunId: next.id, stepKey: next.stepKey, from: null, to: 'ready', trigger: 'USER_RETRY_STEP',
    retryIndex: next.retryIndex, retryOf: step.id });
  applyRunEvent(r, run, { type: 'RESUME_RESOLVED' }, now, fx);
  return ok(undefined);
}

/** `runs.retryStep`: a new row (`retry_index + 1`, fresh counters) for the failed step; the failed row is kept. */
export async function retryStep(ctx: EngineCtx, input: RetryStepInput): Promise<Result<RunDetail>> {
  const OP = 'runs.retryStep';
  const replay = storedFor(ctx.db.repos, OP, input);
  if (replay !== null) return replay.ok ? ok(runDetail(ctx, input.runId)) : replay;
  const run = ctx.db.repos.runs.get(input.runId);
  let profile: ProfileSnapshot | null = null;
  if (input.profileId !== undefined) {
    const step = ctx.db.repos.steps.find(input.stepId);
    if (step?.runId !== run.id) return err(errors.notFound('step'));
    const resolved = await permittedProfile(ctx, run, step.stepKey, input.profileId);
    if (!resolved.ok) return resolved;
    profile = resolved.value;
  }
  const res = await inTx(ctx, (r, fx, now) => {
    const applied = applyRetryStep(r, fx, ctx, r.runs.get(input.runId), input, profile, now);
    if (!applied.ok) return applied;
    remember(r, OP, input, input.runId);
    return ok(undefined);
  });
  if (!res.ok) return res;
  ctx.wake.signal();
  return ok(runDetail(ctx, input.runId));
}
