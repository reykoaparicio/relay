// 06 F10 `approvals.decide` (§11.3). Wave-1 scope: idempotency lookup first, hash binding against the stored and
// the current plan/context hashes, live input re-hash for approvals (PROJECT_CHANGED), then ONE decide tx
// (CAS decide + run transition + approval.decided + idempotency store). Approval reuse across quality revisions
// (the full F10 revision loop) lands in Wave 2.
import { errors, err, ok } from '@relay/contracts';
import type { AppError, ApprovalDecision, ApprovalId, ApprovalView, ProviderId, Result, RunStatus, Sha256 } from '@relay/contracts';
import type { ApprovalRow, Repos } from '@relay/storage';
import { requestHash } from './hash.js';
import type { EngineCtx } from './ports.js';
import type { PostCommitEffect } from './run-machine.js';
import { appendRunEvent, applyRunEvent, runEffects } from './run-machine.js';
import { snapshotOf } from './snapshot.js';
import { applyStepEvent, skipOpenSteps } from './step-machine.js';
import { planStepKeyOf } from './steps/approval.js';

/** Parsed `approvals.decide` input. */
export interface DecideInput {
  readonly idempotencyKey: string;
  readonly approvalId: ApprovalId;
  readonly planHash: Sha256;
  readonly contextHash: Sha256;
  readonly decision: ApprovalDecision;
  readonly note?: string | undefined;
}

/** `approvals.decide` output. */
export interface DecideOutput {
  readonly approval: ApprovalView;
  readonly runStatus: RunStatus;
}

const OP = 'approvals.decide';

/** ApprovalRow → ApprovalView. */
export function toApprovalView(a: ApprovalRow): ApprovalView {
  const providers = (a.requestedPermissions as { providers?: unknown } | null)?.providers;
  return {
    id: a.id,
    planHash: a.planHash,
    contextHash: a.contextHash,
    fileScope: [...a.fileScope],
    providers: Array.isArray(providers) ? (providers.filter((p) => typeof p === 'string') as ProviderId[]) : [],
    planArtifactId: a.planArtifactId,
    decision: a.decision,
    createdAt: a.createdAt,
  };
}

function currentPlanHash(r: Repos, a: ApprovalRow): Sha256 | null {
  const run = r.runs.get(a.runId);
  const approvalStep = r.steps.get(a.stepRunId);
  const planKey = planStepKeyOf(snapshotOf(run), approvalStep.stepKey);
  const planStep = planKey === undefined ? undefined : r.steps.latestFor(run.id, planKey);
  const art = planStep?.outputArtifactId == null ? undefined : r.artifacts.get(planStep.outputArtifactId);
  return art?.sha256 ?? null;
}

/** Invalidates the approval and pauses an awaiting run as approval_stale (own tx). */
async function markStale(ctx: EngineCtx, a: ApprovalRow, reason: 'plan_changed' | 'project_changed', error: AppError): Promise<void> {
  const fx: PostCommitEffect[] = [];
  ctx.db.tx('immediate', (r) => {
    const now = ctx.clock.now();
    r.approvals.invalidate(a.id, reason, now);
    const run = r.runs.get(a.runId);
    if (run.status === 'awaiting_approval') applyRunEvent(r, run, { type: 'APPROVAL_STALE', error }, now, fx);
  });
  await runEffects(ctx, fx);
}

async function checkInputsUnchanged(ctx: EngineCtx, a: ApprovalRow): Promise<AppError | null> {
  const run = ctx.db.repos.runs.get(a.runId);
  const files = ctx.db.repos.runs.inputFiles(run.id);
  if (files.length === 0) return null;
  const project = ctx.db.repos.projects.getWithRoot(run.projectId);
  const root = await ctx.projectFs.openRoot(project.rootRealpath);
  if (!root.ok) return errors.projectChanged([]);
  const live = await ctx.projectFs.hashFiles(root.value, files.map((f) => f.relPath));
  if (!live.ok) return errors.projectChanged([]);
  const byPath = new Map(live.value.map((h) => [h.relPath as string, h.sha256]));
  const changed = files.filter((f) => byPath.get(f.relPath) !== f.sha256).map((f) => f.relPath);
  return changed.length === 0 ? null : errors.projectChanged(changed);
}

function replay(ctx: EngineCtx, input: DecideInput): Result<DecideOutput> | null {
  const stored = ctx.db.repos.idempotency.get(OP, input.idempotencyKey);
  if (stored === undefined) return null;
  if (stored.requestHash !== requestHash({ ...input })) return err(errors.conflict({ reason: 'idempotency_key_reused', op: OP }));
  const a = ctx.db.repos.approvals.get(input.approvalId);
  if (a === undefined) return err(errors.notFound('approval'));
  return ok({ approval: toApprovalView(a), runStatus: ctx.db.repos.runs.get(a.runId).status });
}

/** Applies the decision inside the decide tx. */
function applyDecision(r: Repos, fx: PostCommitEffect[], ctx: EngineCtx, a: ApprovalRow, input: DecideInput): void {
  const now = ctx.clock.now();
  const step = r.steps.get(a.stepRunId);
  const run = r.runs.get(a.runId);
  switch (input.decision) {
    case 'approved':
      applyStepEvent(r, fx, step, 'DECIDED_APPROVED');
      applyRunEvent(r, run, { type: 'APPROVED_MATCHING' }, now, fx);
      return;
    case 'rejected':
      applyStepEvent(r, fx, step, 'DECIDED_REJECTED');
      skipOpenSteps(r, fx, run.id);
      applyRunEvent(r, run, { type: 'REJECTED' }, now, fx);
      return;
    case 'revision_requested': {
      // The planner re-runs (consumes a planner attempt, counts against maxAttempts); the approval re-opens after it.
      applyStepEvent(r, fx, step, 'DECIDED_REVISION');
      const planKey = planStepKeyOf(snapshotOf(run), step.stepKey);
      const planStep = planKey === undefined ? undefined : r.steps.latestFor(run.id, planKey);
      const rows = [];
      if (planStep !== undefined) {
        rows.push({ id: ctx.ids.next('stepRun'), runId: run.id, stepKey: planStep.stepKey, ordinal: planStep.ordinal,
          revisionIndex: planStep.revisionIndex + 1, state: 'ready' as const, profileName: planStep.profileName, createdAt: now });
      }
      rows.push({ id: ctx.ids.next('stepRun'), runId: run.id, stepKey: step.stepKey, ordinal: step.ordinal,
        revisionIndex: step.revisionIndex + 1, state: 'pending' as const, profileName: null, createdAt: now });
      r.steps.insertMany(rows);
      applyRunEvent(r, run, { type: 'REVISION_REQUESTED' }, now, fx);
    }
  }
}

/** `approvals.decide`. */
export async function decideApproval(ctx: EngineCtx, input: DecideInput): Promise<Result<DecideOutput>> {
  const replayed = replay(ctx, input);
  if (replayed !== null) return replayed; // 1. idempotency lookup first, before any hashing
  const a = ctx.db.repos.approvals.get(input.approvalId);
  if (a === undefined) return err(errors.notFound('approval'));
  if (a.decision !== null) return err(errors.conflict({ reason: 'already_decided' }));
  if (a.invalidatedAt !== null) return err(errors.approvalStale(a.invalidatedReason ?? 'plan_changed'));
  if (input.planHash !== a.planHash || input.contextHash !== a.contextHash) return err(errors.approvalStale('plan_changed'));
  const run = ctx.db.repos.runs.get(a.runId);
  if (currentPlanHash(ctx.db.repos, a) !== a.planHash || run.contextHash !== a.contextHash) {
    const e = errors.approvalStale('plan_changed');
    await markStale(ctx, a, 'plan_changed', e);
    return err(e);
  }
  if (input.decision === 'approved') {
    const changed = await checkInputsUnchanged(ctx, a); // outside any tx
    if (changed !== null) {
      await markStale(ctx, a, 'project_changed', changed);
      return err(changed);
    }
  }
  const fx: PostCommitEffect[] = [];
  const decided = ctx.db.tx('immediate', (r): Result<DecideOutput> => {
    const now = ctx.clock.now();
    const fresh = r.approvals.get(a.id);
    if (fresh?.decision !== null || fresh.invalidatedAt !== null) return err(errors.conflict({ reason: 'duplicate_in_flight' }));
    if (r.runs.get(a.runId).status !== 'awaiting_approval') return err(errors.conflict({ reason: 'run_not_awaiting_approval' }));
    r.approvals.decide(a.id, input.decision, input.note ?? null, now); // CAS; cannot lose inside this tx (checked above)
    applyDecision(r, fx, ctx, a, input);
    appendRunEvent(r, fx, a.runId, 'approval.decided', { approvalId: a.id, decision: input.decision });
    const status = r.runs.get(a.runId).status;
    const stored = r.idempotency.put(OP, input.idempotencyKey, requestHash({ ...input }), { ids: { approvalId: a.id }, status });
    if (!stored.ok) throw new Error('idempotency put failed after a fresh lookup'); // unreachable within one writer
    const row = r.approvals.get(a.id);
    return ok({ approval: toApprovalView(row ?? a), runStatus: status });
  });
  if (!decided.ok) return decided;
  await runEffects(ctx, fx);
  const step = ctx.db.repos.steps.get(a.stepRunId);
  ctx.hooks?.afterApprovalCommit?.({ stepKey: step.stepKey, purpose: null, attemptSeq: 0 });
  ctx.wake.signal();
  return decided;
}
