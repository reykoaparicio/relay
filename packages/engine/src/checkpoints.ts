// 06 F4: the checkpoint protocol (§7.4) — the single function that executes one model step attempt. Numbered
// comments map 1:1 to §7.4. No `await` ever happens inside a db.tx callback (the storage types forbid it).
import { STREAM_PROGRESS_THROTTLE_MS, redactDeep, redactString } from '@relay/contracts';
import type { AppError, ArtifactId, ArtifactKind, AttemptId, AttemptPurpose, EpochMs, Microusd, ProviderId, RunId, StepRunId, UsageView } from '@relay/contracts';
import type { ModelRequest, ModelResult, ProviderAdapter, UsageEstimate } from '@relay/providers';
import type { ArtifactInsert, AttemptRow, Repos, RunRow, SnapshotBinding, StepRow } from '@relay/storage';
import type { TemplateRegistry } from '@relay/templates';
import { logSafe } from './log-safe.js';
import { admitAgainstLedger, reserveEntries, settleAmount, settlementEntries } from './budget.js';
import type { SettleAmount } from './budget.js';
import { deadlineReached } from './deadline.js';
import { canonicalJson, sha256Hex, utf8 } from './hash.js';
import type { ApprovalBinding } from './policy.js';
import { checkDispatch } from './policy.js';
import { invalidateApproval, loadApprovalBinding } from './approval-binding.js';
import { isAbortReason } from './cancellation.js';
import { applyPostValidation } from './outcome.js';
import { adapterOf } from './provider-lookup.js';
import { loadValidationInputs } from './steps/validation-inputs.js';
import type { AssembledContext, CrashHookCtx, EngineCtx, ModelStepSnapshot } from './ports.js';
import { classify, eventForError, nextPurpose, retryOfFor } from './retry.js';
import type { AttemptPlan, ClassifiedOutcome, OutcomeKind } from './retry.js';
import { appendRunEvent, applyRunEvent, runEffects } from './run-machine.js';
import type { PostCommitEffect, RunMachineEvent } from './run-machine.js';
import { effectiveStepSnapshot, isSnapshotPreserved, requiresApproval, snapshotBindingOf, snapshotOf } from './snapshot.js';
import { applyStepEvent } from './step-machine.js';
import { validateOutput } from './steps/validate-output.js';
import { errors } from '@relay/contracts';

/** What `executeModelAttempt` did. `lease_lost`: this process no longer owns the runner lease; nothing was written. */
type AttemptOutcome =
  | { readonly kind: 'blocked'; readonly why: 'paused' | 'not_running' | 'conflict' | 'lease_lost' }
  | { readonly kind: 'settled'; readonly attemptId: AttemptId; readonly outcome: OutcomeKind; readonly plan: AttemptPlan['kind'] };

/** Result of one artifact write (5.). */
export type ArtifactPut =
  | { readonly ok: true; readonly meta: Omit<ArtifactInsert, 'stepRunId' | 'attemptId'> }
  | { readonly ok: false; readonly kind: ArtifactKind };

/** Pure: builds the provider request. `metadata` never carries secrets (04 R2-3). */
export function buildModelRequest(
  templates: Pick<TemplateRegistry, 'jsonSchema'>,
  stepSnap: ModelStepSnapshot,
  assembled: Pick<AssembledContext, 'system' | 'user'>,
  metadata: ModelRequest['metadata'],
  providerOptions?: ModelRequest['providerOptions'],
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
    ...(providerOptions === undefined ? {} : { providerOptions }),
    metadata,
  };
}

/** sha256 of the normalized request without the per-attempt id (no secrets are ever in a request). */
function fingerprintRequest(request: ModelRequest): string {
  return sha256Hex(canonicalJson({ ...request, metadata: { ...request.metadata, attemptId: undefined } }));
}

/**
 * Applies `ev` (CAS from running) in its own tx; returns `blocked`. It runs after `prepare`'s awaits, so the lease is
 * re-checked INSIDE the tx (B3): a process that lost it writes nothing (the new owner's recovery decides).
 */
async function pauseRun(ctx: EngineCtx, runId: RunId, ev: RunMachineEvent | null, extra?: (r: Repos, now: EpochMs, fx: PostCommitEffect[]) => void): Promise<AttemptOutcome> {
  if (ev === null) return { kind: 'blocked', why: 'conflict' };
  const fx: PostCommitEffect[] = [];
  const owned = ctx.db.tx('immediate', (r) => {
    if (!ownsLeaseInTx(ctx, r)) return false;
    const now = ctx.clock.now();
    const cur = r.runs.get(runId);
    if (cur.status !== 'running') return true;
    extra?.(r, now, fx);
    applyRunEvent(r, cur, ev, now, fx);
    return true;
  });
  if (!owned) return { kind: 'blocked', why: 'lease_lost' };
  await runEffects(ctx, fx);
  return { kind: 'blocked', why: 'paused' };
}

/** Writes one artifact file (5.); a failure is logged and returned, never thrown. */
export async function putArtifact(
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

export function isJsonText(text: string): boolean {
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

/**
 * Release a reservation that was never sent (caller's tx): the attempt CAS `created | reserved → failed_before_dispatch`
 * FIRST, and only when it wins `release −N` and step → ready (E1 #6: recovery or a new runner may have released it
 * already; an attempt's reservation is released once).
 */
function releaseNotSent(
  r: Repos,
  fx: PostCommitEffect[],
  i: { readonly run: RunRow; readonly attemptId: AttemptId; readonly stepRunId: StepRunId; readonly N: Microusd; readonly priceCatalogVersion: string; readonly now: EpochMs },
): boolean {
  if (!r.attempts.transition(i.attemptId, ['created', 'reserved'], 'failed_before_dispatch', { finishedAt: i.now })) return false;
  r.ledger.append(settlementEntries({ reservation: i.N, cost: { kind: 'not_charged' }, attemptId: i.attemptId, runId: i.run.id,
    projectId: i.run.projectId, priceCatalogVersion: i.priceCatalogVersion, createdAt: i.now }));
  const s = r.steps.get(i.stepRunId);
  if (s.state === 'reserved') applyStepEvent(r, fx, s, 'RESERVATION_RELEASED');
  return true;
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
      appendRunEvent(r, fx, i.run.id, 'attempt.unknown', { attemptId: i.attemptId, stepRunId: i.stepRunId });
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

export { outcomeLabel } from './outcome.js';

type Admitted = { readonly ok: true; readonly seq: number } | { readonly ok: false; readonly why: 'paused' | 'not_running' | 'conflict' | 'lease_lost' };

/** What {@link reserve} admits: the prepared attempt (ids, purpose, profile, request, estimate). */
interface ReserveInput {
  readonly runId: RunId;
  readonly stepRunId: StepRunId;
  readonly attemptId: AttemptId;
  readonly purpose: AttemptPurpose;
  readonly prior: readonly AttemptRow[];
  readonly stepSnap: ModelStepSnapshot;
  readonly request: ModelRequest;
  readonly estimate: UsageEstimate;
}

/** The pause a running run takes before any admission (user pause, attempt limit, deadline), or null. */
function preAdmissionPause(cur: RunRow, now: EpochMs): RunMachineEvent | null {
  if (cur.pauseRequested) return { type: 'USER_PAUSE' };
  if (cur.attemptCount >= cur.limits.maxAttempts) return { type: 'LIMIT_REACHED', reason: 'limit_attempts', error: errors.limitReached('attempts') };
  if (deadlineReached(cur, now)) return { type: 'LIMIT_REACHED', reason: 'deadline', error: errors.limitReached('deadline') };
  return null;
}

/** Inside the reserve tx, after admission: the `reserved` attempt row + `reserve +N` + counters + events. Returns its seq. */
function insertReservedAttempt(r: Repos, fx: PostCommitEffect[], i: ReserveInput, run: RunRow, step: StepRow, now: EpochMs): number {
  const N = i.estimate.upperAllowanceMicrousd;
  const seq = r.attempts.nextSeq(i.stepRunId);
  const pcv = i.estimate.priceCatalogVersion;
  r.attempts.insert({
    id: i.attemptId, runId: i.runId, stepRunId: i.stepRunId, seq, purpose: i.purpose, retryOfAttemptId: retryOfFor(i.purpose, i.prior),
    providerId: i.stepSnap.profile.providerId, modelId: i.stepSnap.profile.modelId, profileSnapshot: i.stepSnap.profile,
    requestFingerprint: fingerprintRequest(i.request), state: 'reserved', reservationMicrousd: N,
    // N1: the provider options this request is sent with (OpenAI `store`) decide F9b eligibility later.
    estimate: { ...i.estimate, providerOptions: i.request.providerOptions ?? null },
    priceCatalogVersion: pcv, createdAt: now,
  });
  r.ledger.append(reserveEntries({ N, attemptId: i.attemptId, runId: i.runId, projectId: run.projectId, priceCatalogVersion: pcv, createdAt: now }));
  r.runs.incrementAttemptCount(i.runId);
  applyStepEvent(r, fx, step, 'RESERVED');
  appendRunEvent(r, fx, i.runId, 'attempt.created', { attemptId: i.attemptId, stepRunId: i.stepRunId, purpose: i.purpose, seq });
  appendRunEvent(r, fx, i.runId, 'ledger.reserved', { attemptId: i.attemptId, stepRunId: i.stepRunId, N });
  return seq;
}

/**
 * 2. One tx: re-check the lease and the run INSIDE the tx, admit (§9.3), create the attempt + reservation. It runs
 * after `prepare`'s awaits (context, credential, the network token count), during which `stop()` or a takeover may
 * have released the lease: then nothing is written (B3). The `{ok:false}` outcomes other than `lease_lost` COMMIT
 * their pause (not a rolled-back txResult).
 */
function reserve(ctx: EngineCtx, fx: PostCommitEffect[], i: ReserveInput): Admitted {
  return ctx.db.tx('immediate', (r): Admitted => {
    if (!ownsLeaseInTx(ctx, r)) return { ok: false, why: 'lease_lost' }; // before any write
    const now = ctx.clock.now();
    const cur = r.runs.get(i.runId);
    if (cur.status !== 'running') return { ok: false, why: 'not_running' }; // cancel/pause won the race
    const pause = preAdmissionPause(cur, now);
    if (pause !== null) {
      applyRunEvent(r, cur, pause, now, fx);
      return { ok: false, why: 'paused' };
    }
    const step = r.steps.get(i.stepRunId);
    if (step.state !== 'ready') return { ok: false, why: 'conflict' };
    const N = i.estimate.upperAllowanceMicrousd;
    const decision = admitAgainstLedger(r.ledger, { run: r.ledger.runBalances(i.runId), project: r.projects.get(cur.projectId), N, now });
    if (!decision.ok) {
      appendRunEvent(r, fx, i.runId, 'ledger.blocked', { ...decision.breakdown, stepRunId: i.stepRunId });
      const scope = decision.breakdown.scope === 'project' ? 'project' : 'run';
      // The blocked step and its estimated input tokens: the inspector prices the choose-profile options from them.
      const error = errors.budgetBlocked(decision.breakdown, { details: { stepKey: step.stepKey, estimatedInputTokens: i.estimate.inputTokens } });
      applyRunEvent(r, cur, { type: 'BUDGET_BLOCKED', scope, error }, now, fx);
      return { ok: false, why: 'paused' };
    }
    return { ok: true, seq: insertReservedAttempt(r, fx, i, cur, step, now) };
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
  /** The run's snapshot-binding events, read once here and passed to every consumer (3). */
  readonly binding: SnapshotBinding;
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
  const events = snapshotBindingOf(db.repos, runId); // read once, passed to every consumer (3)
  const approvalBound = requiresApproval(snapshot, step.stepKey); // computed once (12)
  const bindingOf = (providerId: ProviderId): Promise<ApprovalBinding | null> =>
    approvalBound ? loadApprovalBinding(ctx, run, snapshot, step.stepKey, providerId, events) : Promise.resolve(null);
  const assembled = await ctx.context.assemble({ run, step, snapshot: stepSnap.profile, stepSpec: stepSnap,
    preservedSnapshot: isSnapshotPreserved(events), purpose, priorAttempts: prior });
  if (!assembled.ok) {
    // B4: the stale check (PROJECT_CHANGED) of an approval-bound step invalidates its approval: a new approval is
    // required unless the user chooses use_preserved_snapshot.
    const binding = await bindingOf(stepSnap.profile.providerId);
    return pauseRun(ctx, runId, eventForError(assembled.error), invalidateStale(runId, binding, assembled.error));
  }
  const attemptId = ctx.ids.next('attempt');
  const project = db.repos.projects.get(run.projectId);
  const request = buildModelRequest(ctx.templates, stepSnap, assembled.value, { attemptId, runId, stepKey: step.stepKey, purpose },
    project.providerPolicy.providerOptions); // per-project data handling (e.g. OpenAI storeResponses)
  const providerId = stepSnap.profile.providerId;
  // F2 (security): a provider the project no longer allows is refused BEFORE the key is resolved or the adapter
  // estimates (a provider-counted estimate sends the context) — the same check #2 the policy runs below.
  if (!project.providerPolicy.allowedProviderIds.includes(providerId)) {
    return pauseRun(ctx, runId, eventForError(errors.permissionDenied('provider_not_allowed', { details: { providerId } })));
  }
  const found = adapterOf(ctx, providerId);
  if (!found.ok) return pauseRun(ctx, runId, eventForError(found.error));
  const adapter = found.value;
  const credential = await ctx.credentials.resolve({ providerId, purpose: 'dispatch', attemptId: null });
  const estimate = await adapter.estimate(request, stepSnap.profile.prices, {
    ...(credential.ok ? { apiKey: credential.value } : {}),
    priceCatalogVersion: stepSnap.profile.priceCatalogVersion,
  });
  const binding = await bindingOf(providerId);
  const policy = checkDispatch({ run: db.repos.runs.get(runId), step: db.repos.steps.get(stepRunId), stepSnap, request, estimate,
    credentialOk: credential.ok, binding, project, now: ctx.clock.now(), purpose });
  if (!policy.ok) return pauseRun(ctx, runId, eventForError(policy.error), invalidateStale(runId, binding, policy.error));
  if (!credential.ok) return pauseRun(ctx, runId, eventForError(credential.error)); // unreachable: check #3
  return { run, step, stepSnap, purpose, prior, assembled: assembled.value, attemptId, request, adapter, apiKey: credential.value, estimate, hook,
    binding: events };
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
        onProgress: progressReporter(ctx, p.run.id, p.attemptId, p.step.id),
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
    // E1: a key rejected during a run marks the provider failing (Settings / shell), like a failed connection test.
    if (o.error?.code === 'AUTH_REQUIRED') r.credentials.recordTest(p.stepSnap.profile.providerId, false, 'AUTH_REQUIRED', now, 'run');
    for (const put of i.puts) {
      if (put.ok) {
        r.artifacts.insertIfAbsent({ ...put.meta, stepRunId: p.step.id, attemptId });
        appendRunEvent(r, fx, run.id, 'artifact.created', { artifactId: put.meta.id, kind: put.meta.kind, attemptId, stepRunId: p.step.id });
      } else {
        appendRunEvent(r, fx, run.id, 'artifact.write_failed', { kind: put.kind, attemptId, stepRunId: p.step.id });
      }
    }
    appendRunEvent(r, fx, run.id, 'attempt.settled', { attemptId, stepRunId: p.step.id, state: o.attemptState, cost: i.cost });
    if (o.attemptState === 'unknown') appendRunEvent(r, fx, run.id, 'attempt.unknown', { attemptId, stepRunId: p.step.id });
    // BH-6: the same post-validation function as the F9b reconcile path (step move, F10 scope rule, revision, overrun).
    const { plan, event } = applyPostValidation(r, fx, ctx, { source: 'live', stepRunId: p.step.id, runId: run.id, attemptId, outcome: o,
      policy: p.stepSnap.retryPolicy, purpose: p.purpose, output: i.output, cost: i.cost, N, now });
    const cur = r.runs.get(run.id);
    if (event !== null && cur.status === 'running') applyRunEvent(r, cur, event, now, fx);
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
  // 6. F8 against the input SNAPSHOT (R4-6): contents pre-loaded outside any tx, then the pure validator.
  const validated = result.kind === 'success'
    ? validateOutput(p.stepSnap, result.json, ctx.templates, await loadValidationInputs(ctx, p.run, p.binding)) : null;
  let output: { id: ArtifactId; value: unknown } | null = null;
  let canonicalOk = true;
  if (validated?.ok === true) {
    const put = await putArtifact(ctx, p.run, { kind: p.stepSnap.outputKind, schemaId: p.stepSnap.outputSchema,
      bytes: utf8(canonicalJson(validated.value)), mediaType: 'application/json' }); // canonical output, NEVER redacted
    puts.push(put);
    canonicalOk = put.ok;
    if (put.ok) output = { id: put.meta.id, value: validated.value };
  }
  const classified = classify(result, validated, canonicalOk, { aborted: signal.aborted, abortReason: isAbortReason(signal.reason) ? signal.reason : undefined, attemptId: p.attemptId });
  const rawPut = puts.find((x) => x.ok && x.meta.kind === 'raw_response');
  const outcome = withRepairDetails(classified, p, rawPut?.ok === true ? rawPut.meta.id : null);
  const cost = settleAmount(outcome, p.stepSnap.profile.prices, fallbackLookup(ctx, p), p.estimate.upperAllowanceMicrousd);
  return { puts, output, outcome, cost };
}

/** OUTPUT_INVALID details the run inspector reads: `{ schemaId, repairsUsed, repairsMax, rawResponseArtifactId }`. */
function withRepairDetails(o: ClassifiedOutcome, p: Prepared, rawResponseArtifactId: ArtifactId | null): ClassifiedOutcome {
  if (o.error?.code !== 'OUTPUT_INVALID') return o;
  return { ...o, error: { ...o.error, details: { ...o.error.details, schemaId: p.stepSnap.outputSchema,
    repairsUsed: p.step.schemaRepairsUsed, repairsMax: p.stepSnap.retryPolicy.schemaRepair, rawResponseArtifactId } } };
}

/** `attempt.stream_progress` (≤ 1 per 500 ms, never content, §5.7): persisted in its own tiny tx, then pushed. */
function progressReporter(ctx: EngineCtx, runId: RunId, attemptId: AttemptId, stepRunId: StepRunId): (pr: { outputTokensSoFar: number; elapsedMs: number }) => void {
  let last: number | null = null;
  return (pr) => {
    const now = ctx.clock.now();
    if (last !== null && now - last < STREAM_PROGRESS_THROTTLE_MS) return;
    last = now;
    try {
      const fx: PostCommitEffect[] = [];
      ctx.db.tx('immediate', (r) => {
        appendRunEvent(r, fx, runId, 'attempt.stream_progress', { attemptId, stepRunId, outputTokensSoFar: pr.outputTokensSoFar, elapsedMs: pr.elapsedMs });
      });
      for (const e of fx) if (e.kind === 'emit') ctx.emit(e.event);
    } catch (e) {
      ctx.logger.warn('attempt.progress_failed', { runId, attemptId, err: logSafe(e) });
    }
  };
}

/** B3: whether this process still owns the runner lease (re-read at every use; `stop()` flips it concurrently). */
function ownsLease(ctx: Pick<EngineCtx, 'lease'>): boolean {
  return ctx.lease.owned;
}

/**
 * Inside a write tx: the in-memory flag AND the lease row. The flag only flips on a heartbeat, so a process that stalled
 * past the stale window (and was taken over) must not trust it before its next heartbeat.
 */
function ownsLeaseInTx(ctx: Pick<EngineCtx, 'lease'>, r: Repos): boolean {
  if (!ctx.lease.owned) return false;
  const { ownerId } = ctx.lease;
  if (ownerId !== undefined && !r.lease.isHeldBy(ownerId)) {
    ctx.lease.owned = false;
    return false;
  }
  return true;
}

/**
 * 3. Durable dispatch intent, in one tx: `reserved → dispatching` (+ step DISPATCHING), or — when the run stopped
 * running or the call was already aborted — the reservation is released unsent. Returns the dispatch time, or null
 * when nothing will be sent. The caller runs `fx` (and marks the attempt dispatched) after it returns.
 * E1 #6: the lease is re-checked INSIDE the tx before any write (a runner that stalled past the stale window and was
 * taken over writes nothing: the new owner's recovery already released or reconciled this attempt), and every write
 * follows a won attempt CAS.
 */
function recordDispatchIntent(ctx: EngineCtx, fx: PostCommitEffect[], p: Prepared, controller: AbortController): EpochMs | null {
  const { run, attemptId, step } = p;
  return ctx.db.tx('immediate', (r): EpochMs | null => {
    if (!ownsLeaseInTx(ctx, r)) return null;
    const now = ctx.clock.now();
    if (r.runs.get(run.id).status !== 'running' || controller.signal.aborted) {
      releaseNotSent(r, fx, { run, attemptId, stepRunId: step.id, N: p.estimate.upperAllowanceMicrousd, priceCatalogVersion: p.estimate.priceCatalogVersion, now });
      return null;
    }
    if (!r.attempts.transition(attemptId, ['reserved'], 'dispatching', { dispatchedAt: now })) return null;
    applyStepEvent(r, fx, r.steps.get(step.id), 'DISPATCHING');
    appendRunEvent(r, fx, run.id, 'attempt.dispatching', { attemptId, stepRunId: step.id });
    return now;
  });
}

/**
 * 5–8 after the provider answered: persist + classify (outside any tx), then — while this process still owns the
 * lease — the step-7 settle tx, its effects, the `afterStepCommit` crash hook, and the wake that makes dependent work
 * eligible. `onSettleReturned` fires as soon as the settle tx returned (committed or lost its CAS), so the caller's
 * finally block no longer forces `unknown`.
 */
async function settleAndFinish(
  ctx: EngineCtx,
  p: Prepared,
  i: { readonly result: ModelResult; readonly signal: AbortSignal; readonly dispatchedAt: EpochMs; readonly hook: CrashHookCtx },
  onSettleReturned: () => void,
): Promise<AttemptOutcome> {
  const { result } = i;
  const persisted = await persistAndClassify(ctx, p, result, i.signal);
  const firstByteAt = result.kind === 'success' && result.firstByteMs !== undefined ? ((i.dispatchedAt + result.firstByteMs) as EpochMs) : null;
  if (!ownsLease(ctx)) {
    // B3: the lease was released while the call was in flight; the next owner's recovery settles this attempt.
    ctx.logger.warn('attempt.settle_skipped', { runId: p.run.id, attemptId: p.attemptId, reason: 'lease_released' });
    return { kind: 'blocked', why: 'not_running' };
  }
  const fx7: PostCommitEffect[] = [];
  const final = settle(ctx, fx7, p, { ...persisted, firstByteAt });
  onSettleReturned();
  if (final === null) {
    ctx.logger.warn('attempt.settle_skipped', { runId: p.run.id, attemptId: p.attemptId, reason: 'attempt_already_moved' });
    return { kind: 'blocked', why: 'conflict' };
  }
  await runEffects(ctx, fx7);
  ctx.hooks?.afterStepCommit?.(i.hook);
  // 8. Only then make dependent work eligible.
  ctx.wake.signal();
  return { kind: 'settled', attemptId: p.attemptId, outcome: final.outcome.kind, plan: final.plan.kind };
}

/**
 * Executes one model step attempt (§7.4). After it returns or throws, no attempt it created is left `reserved` by a
 * cancel race or `dispatching` (the finally block forces `unknown`; recovery handles a crash).
 */
export async function executeModelAttempt(ctx: EngineCtx, runId: RunId, stepRunId: StepRunId): Promise<AttemptOutcome> {
  const p = await prepare(ctx, runId, stepRunId);
  if ('kind' in p) return p;
  ctx.hooks?.beforeReservationTx?.(p.hook);
  const fx: PostCommitEffect[] = [];
  const admitted = reserve(ctx, fx, { ...p, runId, stepRunId });
  await runEffects(ctx, fx);
  if (!admitted.ok) return { kind: 'blocked', why: admitted.why };
  const hook: CrashHookCtx = { ...p.hook, attemptId: p.attemptId, attemptSeq: admitted.seq };

  // The controller is registered BEFORE the dispatch-intent tx, so any later cancel aborts it.
  const controller = ctx.cancellation.register(runId, p.attemptId);
  const sent = { dispatched: false, settleReturned: false }; // read by the finally block
  try {
    if (!ownsLease(ctx)) return { kind: 'blocked', why: 'not_running' }; // stop() released the lease: recovery owns it now
    const fx3: PostCommitEffect[] = [];
    const dispatchedAt = recordDispatchIntent(ctx, fx3, p, controller);
    sent.dispatched = dispatchedAt !== null;
    await runEffects(ctx, fx3);
    if (dispatchedAt === null) return { kind: 'blocked', why: 'not_running' };
    ctx.hooks?.afterDispatchIntent?.(hook);

    const result = await dispatch(ctx, p, controller);
    ctx.hooks?.afterProviderResponse?.(hook);
    return await settleAndFinish(ctx, p, { result, signal: controller.signal, dispatchedAt, hook }, () => {
      sent.settleReturned = true;
    });
  } finally {
    ctx.cancellation.unregister(controller);
    if (sent.dispatched && !sent.settleReturned && ownsLease(ctx)) {
      const N = p.estimate.upperAllowanceMicrousd;
      await runEffects(ctx, forceUnknown(ctx, { run: p.run, attemptId: p.attemptId, stepRunId, N, priceCatalogVersion: p.estimate.priceCatalogVersion }));
    }
  }
}
