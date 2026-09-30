// 06 F10 "Opening an approval": insert the approval bound to the plan hash + context hash + file scope + the
// providers that will receive context (R3-11), move the step → awaiting_approval, and apply PLAN_READY.
// The approval step has NO model handler: only approvals.decide (IPC, renderer-only) advances it.
import { ARTIFACT_INLINE_MAX_BYTES, errors, planV1Schema, relPathSchema } from '@relay/contracts';
import type { ProviderId, RelPath, RunId, StepKey, StepRunId } from '@relay/contracts';
import { fromUtf8 } from '../hash.js';
import type { EngineCtx, RunSnapshot } from '../ports.js';
import { appendRunEvent, applyRunEvent } from '../run-machine.js';
import { ancestorsOf, effectiveStepSnapshot, snapshotOf } from '../snapshot.js';
import { applyStepEvent } from '../step-machine.js';
import { blockRun, commitIfReady } from './local.js';

/** The plan.v1 model step an approval step binds (its transitive dependency). */
export function planStepKeyOf(snapshot: RunSnapshot, approvalKey: StepKey): StepKey | undefined {
  return [...ancestorsOf(snapshot, approvalKey)].find((k) => {
    const s = snapshot.steps[k];
    return s?.kind === 'model' && s.outputSchema === 'plan.v1';
  });
}

/** Model steps that depend on the approval step (they receive context after approval). */
export function stepsAfterApproval(snapshot: RunSnapshot, approvalKey: StepKey): StepKey[] {
  return Object.keys(snapshot.steps).filter((k) => {
    const s = snapshot.steps[k];
    return s?.kind === 'model' && ancestorsOf(snapshot, k as StepKey).has(approvalKey);
  }) as StepKey[];
}

/** Opens the approval for `stepRunId`. */
export async function openApproval(ctx: EngineCtx, runId: RunId, stepRunId: StepRunId): Promise<void> {
  const { db } = ctx;
  const run = db.repos.runs.get(runId);
  const step = db.repos.steps.get(stepRunId);
  const snapshot = snapshotOf(run);
  const planKey = planStepKeyOf(snapshot, step.stepKey);
  const planStep = planKey === undefined ? undefined : db.repos.steps.latestFor(runId, planKey);
  const planArtifact = planStep?.outputArtifactId == null ? undefined : db.repos.artifacts.get(planStep.outputArtifactId);
  if (planArtifact === undefined || run.contextHash === null) {
    return blockRun(ctx, runId, { type: 'UNRECOVERABLE', error: errors.internal(ctx.ids.next('correlation')) });
  }
  const bytes = await ctx.artifacts.read(planArtifact.relPath, ARTIFACT_INLINE_MAX_BYTES);
  const plan = bytes.ok ? planV1Schema.safeParse(JSON.parse(fromUtf8(bytes.value))) : null;
  if (plan?.success !== true) {
    return blockRun(ctx, runId, { type: 'UNRECOVERABLE', error: errors.internal(ctx.ids.next('correlation')) });
  }
  const fileScope: RelPath[] = plan.data.fileScope.flatMap((p) => {
    const r = relPathSchema.safeParse(p);
    return r.success ? [r.data] : [];
  });
  const providers: ProviderId[] = [...new Set(stepsAfterApproval(snapshot, step.stepKey)
    .map((k) => effectiveStepSnapshot(db.repos, run, k).profile.providerId))];
  const contextHash = run.contextHash;
  await commitIfReady(ctx, runId, stepRunId, (r, cur, s, fx) => {
    const now = ctx.clock.now();
    const approval = r.approvals.insert({
      id: ctx.ids.next('approval'), runId, stepRunId, planArtifactId: planArtifact.id, planHash: planArtifact.sha256,
      contextHash, fileScope, requestedPermissions: { providers, tools: [] }, createdAt: now,
    });
    applyStepEvent(r, fx, s, 'APPROVAL_OPENED');
    appendRunEvent(r, fx, runId, 'approval.requested', { approvalId: approval.id, stepRunId, planHash: approval.planHash, providers });
    applyRunEvent(r, cur, { type: 'PLAN_READY', approvalId: approval.id }, now, fx);
  });
}
