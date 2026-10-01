// 06 F13 finalize: memory suggestions + the run summary (G, through the port), then ACCEPTED or REVISION_LIMIT.
// A `revise` verdict reaching finalize means the F10 loop (revision.ts) hit maxRevisionCycles.
import type { RunId, StepKey, StepRunId } from '@relay/contracts';
import type { Repos, RunRow } from '@relay/storage';
import type { EngineCtx } from '../ports.js';
import type { RunMachineEvent } from '../run-machine.js';
import { applyRunEvent } from '../run-machine.js';
import { snapshotOf } from '../snapshot.js';
import { applyStepEvent } from '../step-machine.js';
import { commitIfReady } from './local.js';

/** The terminal event implied by the latest review.v1 verdict (ACCEPTED when no verify step exists). */
export function finalEventFor(r: Repos, run: RunRow): RunMachineEvent {
  const snapshot = snapshotOf(run);
  const verifyKey = Object.keys(snapshot.steps).find((k) => {
    const s = snapshot.steps[k];
    return s?.kind === 'model' && s.outputSchema === 'review.v1';
  });
  const verdict = verifyKey === undefined ? null : (r.steps.latestFor(run.id, verifyKey as StepKey)?.outcome ?? null);
  if (verdict === 'incomplete') return { type: 'REVISION_LIMIT', cause: 'verifier_incomplete' };
  if (verdict === 'revise') return { type: 'REVISION_LIMIT', cause: 'revision_limit', revisionCycle: run.revisionCycle, maxRevisionCycles: run.limits.maxRevisionCycles };
  return { type: 'ACCEPTED' };
}

/** Runs the finalize step. Memory writes are best-effort: a failure is logged and never blocks completion. */
export async function runFinalize(ctx: EngineCtx, runId: RunId, stepRunId: StepRunId): Promise<void> {
  const proposed = await ctx.memory.proposeFromRun(runId);
  const summary = await ctx.memory.recordRunSummary(runId);
  for (const [name, r] of [['proposeFromRun', proposed], ['recordRunSummary', summary]] as const) {
    if (!r.ok) ctx.logger.warn('finalize.memory_failed', { runId, op: name, code: r.error.code });
  }
  await commitIfReady(ctx, runId, stepRunId, (r, cur, step, fx) => {
    applyStepEvent(r, fx, step, 'LOCAL_STEP_DONE');
    applyRunEvent(r, cur, finalEventFor(r, cur), ctx.clock.now(), fx);
  });
}
