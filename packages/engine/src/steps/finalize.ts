// 06 F13 finalize: memory suggestions + the run summary (G, through the port), then ACCEPTED or REVISION_LIMIT.
// Wave 1: a verifier `revise` verdict ends the run as incomplete (revision_limit); the F10 revision loop that
// re-runs implement/verify within maxRevisionCycles lands in Wave 2.
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
  if (verdict === 'revise') return { type: 'REVISION_LIMIT', cause: 'revision_limit' };
  return { type: 'ACCEPTED' };
}

/** Runs the finalize step. Memory writes are best-effort: a failure is logged and never blocks completion. */
export async function runFinalize(ctx: EngineCtx, runId: RunId, stepRunId: StepRunId): Promise<void> {
  for (const [name, r] of [['proposeFromRun', ctx.memory.proposeFromRun(runId)], ['recordRunSummary', ctx.memory.recordRunSummary(runId)]] as const) {
    if (!r.ok) ctx.logger.warn('finalize.memory_failed', { runId, op: name, code: r.error.code });
  }
  await commitIfReady(ctx, runId, stepRunId, (r, cur, step, fx) => {
    applyStepEvent(r, fx, step, 'LOCAL_STEP_DONE');
    applyRunEvent(r, cur, finalEventFor(r, cur), ctx.clock.now(), fx);
  });
}
