// 06 F10 revision loop (§12.4 revisionPolicy, §11.3). When the trigger step (verify) succeeds with `revise` and the
// run is below `maxRevisionCycles`, the SAME transaction bumps `runs.revision_cycle` and inserts new `pending` rows
// for the repeat steps (implement, verify) at `revision_index = cycle`. The implementer's new row carries the
// reviewer's output artifact as structured input (`input_artifact_ids`). At the limit nothing is inserted and the
// finalize step ends the run as `incomplete` (REVISION_LIMIT). Approval reuse: the implement revision is dispatched
// under the existing approval (F6 #8: plan hash, context hash, inputs, provider unchanged), and its patch must stay
// within the approved scope (F8 → APPROVAL_STALE scope_changed otherwise).
import type { EpochMs } from '@relay/contracts';
import type { Repos, StepInsert, StepRow } from '@relay/storage';
import type { EngineCtx } from './ports.js';
import type { PostCommitEffect } from './run-machine.js';
import { appendRunEvent } from './run-machine.js';

/** Whether `step` (just succeeded) triggers another revision cycle, and which rows it needs. Pure. */
export function revisionRows(
  i: {
    readonly step: Pick<StepRow, 'stepKey' | 'outcome' | 'outputArtifactId'>;
    readonly policy: { readonly triggerStep: string; readonly triggerOutcome: string; readonly repeatSteps: readonly string[] };
    readonly cycle: number;
    readonly maxCycles: number;
    readonly latest: readonly StepRow[];
  },
): { cycle: number; rows: Omit<StepInsert, 'id' | 'createdAt'>[] } | null {
  const { step, policy } = i;
  if (step.stepKey !== policy.triggerStep || step.outcome !== policy.triggerOutcome || i.cycle >= i.maxCycles) return null;
  const cycle = i.cycle + 1;
  const rows = policy.repeatSteps.flatMap((key) => {
    const prev = i.latest.find((s) => s.stepKey === key);
    if (prev === undefined) return [];
    const isTrigger = key === policy.triggerStep;
    return [{
      runId: prev.runId,
      stepKey: prev.stepKey,
      ordinal: prev.ordinal,
      revisionIndex: Math.max(cycle, prev.revisionIndex + 1),
      state: 'pending' as const,
      profileName: prev.profileName,
      // The reviewer's requested changes reach the implementer as structured input (its review.v1 artifact).
      inputArtifactIds: !isTrigger && step.outputArtifactId !== null ? [step.outputArtifactId] : [],
    }];
  });
  return { cycle, rows };
}

/**
 * F10: called inside the step-7 (or reconcile) transaction right after a step succeeded. Returns whether a new
 * revision cycle was opened.
 */
export function planRevision(r: Repos, fx: PostCommitEffect[], ctx: Pick<EngineCtx, 'ids'>, step: StepRow, now: EpochMs): boolean {
  if (step.state !== 'succeeded') return false;
  const run = r.runs.get(step.runId);
  const version = r.workflows.getVersionById(run.workflowVersionId);
  if (version === undefined) return false;
  const planned = revisionRows({
    step,
    policy: version.spec.revisionPolicy,
    cycle: run.revisionCycle,
    maxCycles: run.limits.maxRevisionCycles,
    latest: r.steps.latestPerStepKey(run.id),
  });
  if (planned === null) return false;
  r.runs.setRevisionCycle(run.id, planned.cycle);
  const inserted = r.steps.insertMany(planned.rows.map((row) => ({ ...row, id: ctx.ids.next('stepRun'), createdAt: now })));
  appendRunEvent(r, fx, run.id, 'step.state_changed', {
    kind: 'revision_opened',
    stepRunId: step.id,
    stepKey: step.stepKey,
    revisionCycle: planned.cycle,
    stepKeys: inserted.map((s) => s.stepKey),
    stepRunIds: inserted.map((s) => s.id),
    trigger: 'QUALITY_REVISION',
  });
  return true;
}
