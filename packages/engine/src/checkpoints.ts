// 06 F4: the checkpoint protocol (§7.4) — the single function that executes one model step attempt. Numbered
// comments map 1:1 to §7.4. No `await` ever happens inside a db.tx callback (the storage types forbid it).
import { redactDeep, redactString } from '@relay/contracts';
import type { AppError, ApprovalId, ArtifactId, ArtifactKind, AttemptId, AttemptPurpose, EpochMs, Microusd, ProviderId, RunId, StepRunId, UsageView } from '@relay/contracts';
import type { ModelRequest, ModelResult, ProviderAdapter, UsageEstimate } from '@relay/providers';
import type { ApprovalRow, ArtifactInsert, AttemptRow, Repos, RunRow, StepRow } from '@relay/storage';
import type { TemplateRegistry } from '@relay/templates';
import { logSafe } from './log-safe.js';
import { reserveEntries, settleAmount, settlementEntries, isOverrun } from './budget.js';
import type { SettleAmount } from './budget.js';
import { monthWindow } from './clock.js';
import { deadlineReached } from './deadline.js';
import { canonicalJson, sha256Hex, utf8 } from './hash.js';
import type { ApprovalBinding } from './policy.js';
import { checkDispatch } from './policy.js';
import type { AbortReason, AssembledContext, CrashHookCtx, EngineCtx, ModelStepSnapshot, RunSnapshot } from './ports.js';
import { classify, eventForError, nextAttemptPlan, nextPurpose, retryOfFor, runEventFor } from './retry.js';
import type { AttemptPlan, ClassifiedOutcome, OutcomeKind } from './retry.js';
import { admit } from './budget.js';
import { appendRunEvent, applyRunEvent, runEffects } from './run-machine.js';
import type { PostCommitEffect, RunMachineEvent } from './run-machine.js';
import { effectiveStepSnapshot, hasSnapshotPreserved, requiresApproval, snapshotOf, ancestorsOf } from './snapshot.js';
import { applyStepEvent } from './step-machine.js';
import { validateOutput } from './steps/validate-output.js';
import { errors } from '@relay/contracts';

/** What `executeModelAttempt` did. */
export type AttemptOutcome =
  | { readonly kind: 'blocked'; readonly why: 'paused' | 'not_running' | 'conflict' }
  | { readonly kind: 'settled'; readonly attemptId: AttemptId; readonly outcome: OutcomeKind; readonly plan: AttemptPlan['kind'] };

/** Result of one artifact write (5.). */
type ArtifactPut =
  | { readonly ok: true; readonly meta: Omit<ArtifactInsert, 'stepRunId' | 'attemptId'> }
  | { readonly ok: false; readonly kind: ArtifactKind };

/** Pure: builds the provider request. `metadata` never carries secrets (04 R2-3). */
export function buildModelRequest(
  templates: Pick<TemplateRegistry, 'jsonSchema'>,
  stepSnap: ModelStepSnapshot,
  assembled: Pick<AssembledContext, 'system' | 'user'>,
  metadata: ModelRequest['metadata'],
): ModelRequest {
  const { profile } = stepSnap;
  return {
    providerId: profile.providerId,
    modelId: profile.modelId,
    system: assembled.system,
    messages: [{ role: 'user', content: assembled.user }],
    outputSchema: { name: stepSnap.outputSchema, jsonSchema: templates.jsonSchema(stepSnap.outputSchema) },
    maxOutputTokens: stepSnap.maxOutputTokens,
    ...(profile.params.effort === undefined ? {} : { effort: profile.params.effort }),
    refusalFallback: profile.params.refusalFallback,
    metadata,
  };
}

/** sha256 of the normalized request without the per-attempt id (no secrets are ever in a request). */
export function fingerprintRequest(request: ModelRequest): string {
  return sha256Hex(canonicalJson({ ...request, metadata: { ...request.metadata, attemptId: undefined } }));
}

/** F6 #8 inputs: the latest approved approval, the current plan artifact hash, and the run context hash. */
export function loadApprovalBinding(r: Repos, run: RunRow, snapshot: RunSnapshot, stepKey: StepRow['stepKey'], providerId: ProviderId): ApprovalBinding {
  const planKey = [...ancestorsOf(snapshot, stepKey)].find((k) => {
    const s = snapshot.steps[k];
    return s?.kind === 'model' && s.outputSchema === 'plan.v1';
  });
  const planStep = planKey === undefined ? undefined : r.steps.latestFor(run.id, planKey);
  const planArtifact = planStep?.outputArtifactId == null ? undefined : r.artifacts.get(planStep.outputArtifactId);
  const valid = r.approvals.latestApprovedForRun(run.id);
  const preserved = valid === undefined ? preservedApproval(r, run.id) : undefined;
  return {
    approval: valid ?? preserved,
    preservedAfterProjectChange: preserved !== undefined,
    currentPlanHash: planArtifact?.sha256 ?? null,
    runContextHash: run.contextHash,
    providerId,
  };
}

/** Event payload marker recording an approval invalidated because the project changed (B4). */
const PROJECT_CHANGED_MARK = 'approval_invalidated';

/**
 * B4: the approval invalidated as `project_changed` when the user afterwards chose `use_preserved_snapshot` (its
 * `run.snapshot_preserved` event follows the invalidation record), else undefined — a new approval is then required.
 */
export function preservedApproval(r: Repos, runId: RunId): ApprovalRow | undefined {
  const events = r.events.list(runId, 0, Number.MAX_SAFE_INTEGER);
  const mark = events.findLast((e) => e.type === 'error.recorded' && e.payload['kind'] === PROJECT_CHANGED_MARK);
  if (mark === undefined) return undefined;
  if (!events.some((e) => e.type === 'run.snapshot_preserved' && e.seq > mark.seq)) return undefined;
  const id = mark.payload['approvalId'];
  const a = typeof id === 'string' ? r.approvals.get(id as ApprovalId) : undefined;
  return a?.decision === 'approved' && a.invalidatedReason === 'project_changed' ? a : undefined;
}

/** Invalidates `approvalId` with `reason` (caller's tx); a project change is also recorded on the run (B4). */
function invalidateApproval(r: Repos, fx: PostCommitEffect[], runId: RunId, approvalId: ApprovalId, reason: 'plan_changed' | 'provider_changed' | 'project_changed', now: EpochMs): void {
  if (!r.approvals.invalidate(approvalId, reason, now)) return;
  if (reason === 'project_changed') {
    appendRunEvent(r, fx, runId, 'error.recorded', { kind: PROJECT_CHANGED_MARK, code: 'PROJECT_CHANGED', approvalId, invalidatedReason: reason });
  }
}

/** Applies `ev` (CAS from running) in its own tx; returns `blocked`. */
async function pauseRun(ctx: EngineCtx, runId: RunId, ev: RunMachineEvent | null, extra?: (r: Repos, now: EpochMs, fx: PostCommitEffect[]) => void): Promise<AttemptOutcome> {
  if (ev === null) return { kind: 'blocked', why: 'conflict' };
  const fx: PostCommitEffect[] = [];
  ctx.db.tx('immediate', (r) => {
    const now = ctx.clock.now();
    const cur = r.runs.get(runId);
    if (cur.status !== 'running') return;
    extra?.(r, now, fx);
    applyRunEvent(r, cur, ev, now, fx);
  });
  await runEffects(ctx, fx);
  return { kind: 'blocked', why: 'paused' };
}

async function putArtifact(
  ctx: EngineCtx,
  run: RunRow,
  a: { readonly kind: ArtifactKind; readonly bytes: Uint8Array; readonly mediaType: string; readonly schemaId?: string },
): Promise<ArtifactPut> {
  const id: ArtifactId = ctx.ids.next('artifact');
  try {
    const put = await ctx.artifacts.put({ scopeDir: `artifacts/${run.id}`, artifactId: id, bytes: a.bytes, mediaType: a.mediaType });
    if (!put.ok) {
      ctx.logger.warn('artifact.write_failed', { runId: run.id, kind: a.kind, code: put.error.code });
      return { ok: false, kind: a.kind };
    }
    return {
      ok: true,
      meta: {
        id,
        runId: run.id,
        projectId: run.projectId,
        kind: a.kind,
        relPath: put.value.relPath,
        sha256: put.value.sha256,
        sizeBytes: put.value.sizeBytes,
        mediaType: a.mediaType,
        schemaId: a.schemaId ?? null,
        createdAt: ctx.clock.now(),
      },
    };
  } catch (e) {
    ctx.logger.warn('artifact.write_failed', { runId: run.id, kind: a.kind, err: logSafe(e) });
    return { ok: false, kind: a.kind };
  }
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function rawTextOf(result: ModelResult): string | null {
  return result.kind === 'success' || result.kind === 'truncated' ? result.rawText : null;
}

function usageView(o: ClassifiedOutcome): UsageView | null {
  const u = o.usage;
  if (u === null) return null;
  return {
    uncachedInputTokens: u.uncachedInputTokens,
    cacheReadInputTokens: u.cacheReadInputTokens,
    cacheWriteInputTokens: u.cacheWriteInputTokens,
    outputTokens: u.outputTokens,
    ...(u.reasoningTokens === undefined ? {} : { reasoningTokens: u.reasoningTokens }),
    ...(o.partial ? { partial: true } : {}),
  };
}

/** The attempt state `generate` threw for: the request may have left (never left `dispatching`). */
function outcomeUnknown(): ModelResult {
  return { kind: 'error', error: errors.providerUnavailable(), phase: 'sent_no_response' };
}

function abortedBeforeSend(): ModelResult {
  return { kind: 'error', error: errors.providerUnavailable(), phase: 'not_sent' };
}

/** Release a reservation that was never sent (caller's tx): `release −N`, attempt → failed_before_dispatch, step → ready. */
export function releaseNotSent(
  r: Repos,
  fx: PostCommitEffect[],
  i: { readonly run: RunRow; readonly attemptId: AttemptId; readonly stepRunId: StepRunId; readonly N: Microusd; readonly priceCatalogVersion: string; readonly now: EpochMs },
): void {
  r.ledger.append(settlementEntries({ reservation: i.N, cost: { kind: 'not_charged' }, attemptId: i.attemptId, runId: i.run.id,
    projectId: i.run.projectId, priceCatalogVersion: i.priceCatalogVersion, createdAt: i.now }));
  r.attempts.transition(i.attemptId, ['created', 'reserved'], 'failed_before_dispatch', { finishedAt: i.now });
  const s = r.steps.get(i.stepRunId);
  if (s.state === 'reserved') applyStepEvent(r, fx, s, 'RESERVATION_RELEASED');
}

/** Best-effort: never leave `dispatching` in-process (F4 finally). Recovery (F9) repeats this if it fails. */
function forceUnknown(ctx: EngineCtx, i: { run: RunRow; attemptId: AttemptId; stepRunId: StepRunId; N: Microusd; priceCatalogVersion: string }): PostCommitEffect[] {
  const fx: PostCommitEffect[] = [];
  try {
    ctx.db.tx('immediate', (r) => {
      const now = ctx.clock.now();
      if (!r.attempts.transition(i.attemptId, ['dispatching'], 'unknown', { error: errors.requestOutcomeUnknown(i.attemptId), finishedAt: now })) return;
      r.ledger.append(settlementEntries({ reservation: i.N, cost: { kind: 'unknown' }, attemptId: i.attemptId, runId: i.run.id,
        projectId: i.run.projectId, priceCatalogVersion: i.priceCatalogVersion, createdAt: now }));
      const s = r.steps.get(i.stepRunId);
      if (s.state === 'executing') applyStepEvent(r, fx, s, 'OUTCOME_UNKNOWN', { error: errors.requestOutcomeUnknown(i.attemptId) });
      appendRunEvent(r, fx, i.run.id, 'attempt.unknown', { attemptId: i.attemptId });
      const cur = r.runs.get(i.run.id);
      if (cur.status === 'running') {
        applyRunEvent(r, cur, { type: 'UNKNOWN_OUTCOME', attemptId: i.attemptId, error: errors.requestOutcomeUnknown(i.attemptId) }, now, fx);
      }
    });
  } catch (e) {
    ctx.logger.error('attempt.force_unknown_failed', { runId: i.run.id, attemptId: i.attemptId, err: logSafe(e) });
    return [];
  }
  return fx;
}

function outcomeLabel(value: unknown): string | null {
  const o = (value as { outcome?: unknown } | null)?.outcome;
  return typeof o === 'string' ? o : null;
}

/** Moves the executing step per the F7 plan (step-7 tx). */
function applyStepOutcome(r: Repos, fx: PostCommitEffect[], s: StepRow, plan: AttemptPlan, output: { id: ArtifactId; value: unknown } | null): void {
  switch (plan.kind) {
    case 'succeed':
      applyStepEvent(r, fx, s, 'SETTLED_VALID', {
        outputArtifactId: output?.id ?? null,
        outcome: outcomeLabel(output?.value ?? null),
        error: null,
        notBeforeAt: null,
      });
      return;
    case 'release':
      applyStepEvent(r, fx, s, 'NOT_SENT');
      return;
    case 'retry': {
      const counter =
        plan.counter === 'transport'
          ? { transportRetriesUsed: s.transportRetriesUsed + 1 }
          : plan.counter === 'schema_repair'
            ? { schemaRepairsUsed: s.schemaRepairsUsed + 1 }
            : { rateLimitWaitsUsed: s.rateLimitWaitsUsed + 1 };
      applyStepEvent(r, fx, s, 'SETTLED_RETRY', { ...counter, notBeforeAt: plan.notBeforeAt });
      return;
    }
    case 'hold':
      applyStepEvent(r, fx, s, 'SETTLED_RETRY', { error: plan.error });
      return;
    case 'fail':
      applyStepEvent(r, fx, s, 'SETTLED_FAILED', { error: plan.error });
      return;
    case 'unknown':
      applyStepEvent(r, fx, s, 'OUTCOME_UNKNOWN', { error: plan.error });
      return;
  }
}

type Admitted = { readonly ok: true; readonly seq: number } | { readonly ok: false; readonly why: 'paused' | 'not_running' | 'conflict' };

/** 2. One tx: re-check the run INSIDE the tx, admit (§9.3), create the attempt + reservation. */
function reserve(
  ctx: EngineCtx,
  fx: PostCommitEffect[],
  i: { runId: RunId; stepRunId: StepRunId; attemptId: AttemptId; purpose: AttemptPurpose; prior: readonly AttemptRow[];
    stepSnap: ModelStepSnapshot; request: ModelRequest; estimate: UsageEstimate },
): Admitted {
  return ctx.db.tx('immediate', (r): Admitted => {
    const now = ctx.clock.now();
    const cur = r.runs.get(i.runId);
    if (cur.status !== 'running') return { ok: false, why: 'not_running' }; // cancel/pause won the race
    if (cur.pauseRequested) {
      applyRunEvent(r, cur, { type: 'USER_PAUSE' }, now, fx);
      return { ok: false, why: 'paused' };
    }
    if (cur.attemptCount >= cur.limits.maxAttempts) {
      applyRunEvent(r, cur, { type: 'LIMIT_REACHED', reason: 'limit_attempts', error: errors.limitReached('attempts') }, now, fx);
      return { ok: false, why: 'paused' };
    }
    if (deadlineReached(cur, now)) {
      applyRunEvent(r, cur, { type: 'LIMIT_REACHED', reason: 'deadline', error: errors.limitReached('deadline') }, now, fx);
      return { ok: false, why: 'paused' };
    }
    const step = r.steps.get(i.stepRunId);
    if (step.state !== 'ready') return { ok: false, why: 'conflict' };
    const project = r.projects.get(cur.projectId);
    const N = i.estimate.upperAllowanceMicrousd;
    const { start, end } = monthWindow(now);
    const decision = admit({
      run: r.ledger.runBalances(i.runId),
      N,
      project: project.monthlyAllowanceMicrousd === null ? null
        : { L: project.monthlyAllowanceMicrousd, ...r.ledger.projectMonthBalances(cur.projectId, start, end) },
    });
    if (!decision.ok) {
      appendRunEvent(r, fx, i.runId, 'ledger.blocked', { ...decision.breakdown });
      const scope = decision.breakdown.scope === 'project' ? 'project' : 'run';
      applyRunEvent(r, cur, { type: 'BUDGET_BLOCKED', scope, error: errors.budgetBlocked(decision.breakdown) }, now, fx);
      return { ok: false, why: 'paused' };
    }
    const seq = r.attempts.nextSeq(i.stepRunId);
    const pcv = i.estimate.priceCatalogVersion;
    r.attempts.insert({
      id: i.attemptId, runId: i.runId, stepRunId: i.stepRunId, seq, purpose: i.purpose, retryOfAttemptId: retryOfFor(i.purpose, i.prior),
      providerId: i.stepSnap.profile.providerId, modelId: i.stepSnap.profile.modelId, profileSnapshot: i.stepSnap.profile,
      requestFingerprint: fingerprintRequest(i.request), state: 'reserved', reservationMicrousd: N, estimate: i.estimate,
      priceCatalogVersion: pcv, createdAt: now,
    });
    r.ledger.append(reserveEntries({ N, attemptId: i.attemptId, runId: i.runId, projectId: cur.projectId, priceCatalogVersion: pcv, createdAt: now }));
    r.runs.incrementAttemptCount(i.runId);
    applyStepEvent(r, fx, step, 'RESERVED');
    appendRunEvent(r, fx, i.runId, 'attempt.created', { attemptId: i.attemptId, stepRunId: i.stepRunId, purpose: i.purpose, seq });
    appendRunEvent(r, fx, i.runId, 'ledger.reserved', { attemptId: i.attemptId, N });
    return { ok: true, seq };
  });
}

interface Prepared {
  readonly run: RunRow;
  readonly step: StepRow;
  readonly stepSnap: ModelStepSnapshot;
  readonly purpose: AttemptPurpose;
  readonly prior: readonly AttemptRow[];
  readonly assembled: AssembledContext;
  readonly attemptId: AttemptId;
  readonly request: ModelRequest;
  readonly adapter: ProviderAdapter;
  readonly apiKey: string;
  readonly estimate: UsageEstimate;
  readonly hook: CrashHookCtx;
}

/** 1. Validate inputs, build the immutable execution snapshot, resolve the credential BEFORE the estimate, run policy. */
async function prepare(ctx: EngineCtx, runId: RunId, stepRunId: StepRunId): Promise<Prepared | AttemptOutcome> {
  const { db } = ctx;
  const run = db.repos.runs.get(runId);
  const step = db.repos.steps.get(stepRunId);
  const prior = db.repos.attempts.listForStep(stepRunId);
  const purpose = nextPurpose(step, prior);
  const snapshot = snapshotOf(run);
  const stepSnap = effectiveStepSnapshot(db.repos, run, step.stepKey);
  const hook: CrashHookCtx = { stepKey: step.stepKey, purpose, attemptSeq: prior.length + 1 };
  const assembled = await ctx.context.assemble({ run, step, snapshot: stepSnap.profile, stepSpec: stepSnap,
    preservedSnapshot: hasSnapshotPreserved(db.repos, runId), purpose, priorAttempts: prior });
  if (!assembled.ok) {
    // B4: the stale check (PROJECT_CHANGED) of an approval-bound step invalidates its approval: a new approval is
    // required unless the user chooses use_preserved_snapshot.
    const binding = requiresApproval(snapshot, step.stepKey)
      ? loadApprovalBinding(db.repos, run, snapshot, step.stepKey, stepSnap.profile.providerId) : null;
    return pauseRun(ctx, runId, eventForError(assembled.error), invalidateStale(runId, binding, assembled.error));
  }
  const attemptId = ctx.ids.next('attempt');
  const request = buildModelRequest(ctx.templates, stepSnap, assembled.value, { attemptId, runId, stepKey: step.stepKey, purpose });
  const providerId = stepSnap.profile.providerId;
  let adapter: ProviderAdapter;
  try {
    adapter = ctx.providers.get(providerId);
  } catch {
    return pauseRun(ctx, runId, eventForError(errors.modelUnsupported({ providerId, reason: 'no_adapter' })));
  }
  const credential = await ctx.credentials.resolve({ providerId, purpose: 'dispatch', attemptId: null });
  const estimate = await adapter.estimate(request, stepSnap.profile.prices, {
    ...(credential.ok ? { apiKey: credential.value } : {}),
    priceCatalogVersion: stepSnap.profile.priceCatalogVersion,
  });
  const binding = requiresApproval(snapshot, step.stepKey) ? loadApprovalBinding(db.repos, run, snapshot, step.stepKey, providerId) : null;
  const policy = checkDispatch({ run: db.repos.runs.get(runId), step: db.repos.steps.get(stepRunId), stepSnap, request, estimate,
    credentialOk: credential.ok, binding, project: db.repos.projects.get(run.projectId), now: ctx.clock.now() });
  if (!policy.ok) return pauseRun(ctx, runId, eventForError(policy.error), invalidateStale(runId, binding, policy.error));
  if (!credential.ok) return pauseRun(ctx, runId, eventForError(credential.error)); // unreachable: check #3
  return { run, step, stepSnap, purpose, prior, assembled: assembled.value, attemptId, request, adapter, apiKey: credential.value, estimate, hook };
}

/** F6 #8 / B4: the invalidation that goes with an APPROVAL_STALE or PROJECT_CHANGED pause (none otherwise). */
function invalidateStale(runId: RunId, binding: ApprovalBinding | null, error: AppError): ((r: Repos, now: EpochMs, fx: PostCommitEffect[]) => void) | undefined {
  const approval = binding?.approval;
  if ((error.code !== 'APPROVAL_STALE' && error.code !== 'PROJECT_CHANGED') || approval === undefined || approval.invalidatedAt !== null) return undefined;
  const reason = error.code === 'PROJECT_CHANGED' ? 'project_changed' : error.details?.['reason'] === 'provider_changed' ? 'provider_changed' : 'plan_changed';
  return (r, now, fx) => {
    invalidateApproval(r, fx, runId, approval.id, reason, now);
  };
}

/** 4. Calls the provider outside any transaction. Adapters never throw for provider conditions; a throw is a bug. */
async function dispatch(ctx: EngineCtx, p: Prepared, controller: AbortController): Promise<ModelResult> {
  if (controller.signal.aborted) return abortedBeforeSend(); // `generate` never invoked
  try {
    return await p.adapter.generate(p.request, {
      apiKey: p.apiKey,
      signal: controller.signal,
      hooks: {
        onResponseId: (seen) => {
          ctx.db.tx('immediate', (r) => {
            r.attempts.setProviderIds(p.attemptId, { requestId: seen.providerRequestId, responseId: seen.providerResponseId });
          });
        },
      },
    });
  } catch (err) {
    ctx.logger.error('adapter.threw', { runId: p.run.id, attemptId: p.attemptId, err: logSafe(err, [p.apiKey]) });
    return outcomeUnknown();
  }
}

interface Settled {
  readonly outcome: ClassifiedOutcome;
  readonly plan: AttemptPlan;
}

/**
 * 7. One tx: the attempt CAS `dispatching → final` FIRST; only when it wins: ledger moves (one group) + artifact rows +
 * the completion event ALWAYS, step and run conditionally. When the CAS loses (recovery or another runner already
 * moved the attempt to unknown / settled it), NOTHING is written and `null` is returned — an attempt settles once.
 */
function settle(
  ctx: EngineCtx,
  fx: PostCommitEffect[],
  p: Prepared,
  i: { outcome: ClassifiedOutcome; cost: SettleAmount; puts: readonly ArtifactPut[]; output: { id: ArtifactId; value: unknown } | null;
    firstByteAt: EpochMs | null },
): Settled | null {
  const N = p.estimate.upperAllowanceMicrousd;
  return ctx.db.tx('immediate', (r): Settled | null => {
    const now = ctx.clock.now();
    const { run, attemptId } = p;
    const o = i.outcome;
    const won = r.attempts.transition(attemptId, ['dispatching'], o.attemptState, {
      usage: usageView(o), rawUsage: redactDeep(o.rawUsage), stopReason: o.stopReason, error: o.error,
      providerRequestId: o.providerRequestId, firstByteAt: i.firstByteAt, finishedAt: now,
    });
    if (!won) return null;
    r.ledger.append(settlementEntries({ reservation: N, cost: i.cost, attemptId, runId: run.id, projectId: run.projectId,
      priceCatalogVersion: p.estimate.priceCatalogVersion, createdAt: now }));
    for (const put of i.puts) {
      if (put.ok) {
        r.artifacts.insertIfAbsent({ ...put.meta, stepRunId: p.step.id, attemptId });
        appendRunEvent(r, fx, run.id, 'artifact.created', { artifactId: put.meta.id, kind: put.meta.kind, attemptId });
      } else {
        appendRunEvent(r, fx, run.id, 'artifact.write_failed', { kind: put.kind, attemptId });
      }
    }
    appendRunEvent(r, fx, run.id, 'attempt.settled', { attemptId, state: o.attemptState, cost: i.cost });
    if (o.attemptState === 'unknown') appendRunEvent(r, fx, run.id, 'attempt.unknown', { attemptId });
    const s = r.steps.get(p.step.id);
    const plan = nextAttemptPlan(s, o, p.stepSnap.retryPolicy, now, p.purpose);
    if (s.state === 'executing') applyStepOutcome(r, fx, s, plan, i.output);
    if (isOverrun(i.cost, N)) appendRunEvent(r, fx, run.id, 'ledger.overrun', { attemptId, N, X: i.cost.kind === 'known' ? i.cost.microusd : N });
    const cur = r.runs.get(run.id);
    const ev = runEventFor(o, plan, i.cost, N, attemptId);
    if (ev !== null && cur.status === 'running') applyRunEvent(r, cur, ev, now, fx);
    return { outcome: o, plan };
  });
}

/** B5: prices for fallback iterations — the attempt's provider catalog in the DB (latest version per model). */
function fallbackLookup(ctx: EngineCtx, p: Prepared) {
  const { providerId, modelId } = p.stepSnap.profile;
  return {
    profileModelId: modelId,
    pricesFor: (id: string) => ctx.db.repos.catalog.get(providerId, id)?.prices,
    providerPrices: () => ctx.db.repos.catalog.list(providerId).map((e) => e.prices),
  };
}

/** 5–6. Persist raw response + manifest (+ canonical output when valid), then classify and price the result. */
async function persistAndClassify(ctx: EngineCtx, p: Prepared, result: ModelResult, signal: AbortSignal) {
  const puts: ArtifactPut[] = [];
  const raw = rawTextOf(result);
  if (raw !== null) {
    puts.push(await putArtifact(ctx, p.run, { kind: 'raw_response', bytes: utf8(redactString(raw)),
      mediaType: isJsonText(raw) ? 'application/json' : 'text/plain' })); // redacted (R4-24)
  }
  puts.push(await putArtifact(ctx, p.run, { kind: 'context_manifest', bytes: utf8(canonicalJson(p.assembled.manifest)), mediaType: 'application/json' }));
  const validated = result.kind === 'success' ? validateOutput(p.stepSnap, result.json, ctx.templates) : null;
  let output: { id: ArtifactId; value: unknown } | null = null;
  let canonicalOk = true;
  if (validated?.ok === true) {
    const put = await putArtifact(ctx, p.run, { kind: p.stepSnap.outputKind, schemaId: p.stepSnap.outputSchema,
      bytes: utf8(canonicalJson(validated.value)), mediaType: 'application/json' }); // canonical output, NEVER redacted
    puts.push(put);
    canonicalOk = put.ok;
    if (put.ok) output = { id: put.meta.id, value: validated.value };
  }
  const outcome = classify(result, validated, canonicalOk, { aborted: signal.aborted, abortReason: signal.reason as AbortReason | undefined, attemptId: p.attemptId });
  const cost = settleAmount(outcome, p.stepSnap.profile.prices, fallbackLookup(ctx, p));
  return { puts, output, outcome, cost };
}

/** B3: whether this process still owns the runner lease (re-read at every use; `stop()` flips it concurrently). */
function ownsLease(ctx: Pick<EngineCtx, 'lease'>): boolean {
  return ctx.lease.owned;
}

/**
 * Executes one model step attempt (§7.4). After it returns or throws, no attempt it created is left `reserved` by a
 * cancel race or `dispatching` (the finally block forces `unknown`; recovery handles a crash).
 */
export async function executeModelAttempt(ctx: EngineCtx, runId: RunId, stepRunId: StepRunId): Promise<AttemptOutcome> {
  const p = await prepare(ctx, runId, stepRunId);
  if ('kind' in p) return p;
  const { db, clock } = ctx;
  ctx.hooks?.beforeReservationTx?.(p.hook);
  const fx: PostCommitEffect[] = [];
  const admitted = reserve(ctx, fx, { ...p, runId, stepRunId });
  await runEffects(ctx, fx);
  if (!admitted.ok) return { kind: 'blocked', why: admitted.why };
  const hook: CrashHookCtx = { ...p.hook, attemptId: p.attemptId, attemptSeq: admitted.seq };
  const N = p.estimate.upperAllowanceMicrousd;

  // 3. Durable dispatch intent. The controller is registered BEFORE this tx, so any later cancel aborts it.
  const controller = ctx.cancellation.register(runId, p.attemptId);
  let dispatched = false;
  let committed = false;
  try {
    const fx3: PostCommitEffect[] = [];
    if (!ownsLease(ctx)) return { kind: 'blocked', why: 'not_running' }; // stop() released the lease: recovery owns it now
    const dispatchedAt = db.tx('immediate', (r): EpochMs | null => {
      const now = clock.now();
      if (r.runs.get(runId).status !== 'running' || controller.signal.aborted) {
        releaseNotSent(r, fx3, { run: p.run, attemptId: p.attemptId, stepRunId, N, priceCatalogVersion: p.estimate.priceCatalogVersion, now });
        return null;
      }
      r.attempts.transition(p.attemptId, ['reserved'], 'dispatching', { dispatchedAt: now });
      applyStepEvent(r, fx3, r.steps.get(stepRunId), 'DISPATCHING');
      appendRunEvent(r, fx3, runId, 'attempt.dispatching', { attemptId: p.attemptId });
      return now;
    });
    dispatched = dispatchedAt !== null;
    await runEffects(ctx, fx3);
    if (dispatchedAt === null) return { kind: 'blocked', why: 'not_running' };
    ctx.hooks?.afterDispatchIntent?.(hook);

    const result = await dispatch(ctx, p, controller);
    ctx.hooks?.afterProviderResponse?.(hook);

    const persisted = await persistAndClassify(ctx, p, result, controller.signal);
    const firstByteAt = result.kind === 'success' && result.firstByteMs !== undefined ? ((dispatchedAt + result.firstByteMs) as EpochMs) : null;
    if (!ownsLease(ctx)) {
      // B3: the lease was released while the call was in flight; the next owner's recovery settles this attempt.
      ctx.logger.warn('attempt.settle_skipped', { runId, attemptId: p.attemptId, reason: 'lease_released' });
      return { kind: 'blocked', why: 'not_running' };
    }
    const fx7: PostCommitEffect[] = [];
    const final = settle(ctx, fx7, p, { ...persisted, firstByteAt });
    committed = true;
    if (final === null) {
      ctx.logger.warn('attempt.settle_skipped', { runId, attemptId: p.attemptId, reason: 'attempt_already_moved' });
      return { kind: 'blocked', why: 'conflict' };
    }
    await runEffects(ctx, fx7);
    ctx.hooks?.afterStepCommit?.(hook);

    // 8. Only then make dependent work eligible.
    ctx.wake.signal();
    return { kind: 'settled', attemptId: p.attemptId, outcome: final.outcome.kind, plan: final.plan.kind };
  } finally {
    ctx.cancellation.unregister(controller);
    if (dispatched && !committed && ownsLease(ctx)) {
      await runEffects(ctx, forceUnknown(ctx, { run: p.run, attemptId: p.attemptId, stepRunId, N, priceCatalogVersion: p.estimate.priceCatalogVersion }));
    }
  }
}
