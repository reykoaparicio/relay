// Shared helpers of the synthetic engine steps (intake / approval / finalize).
import type { AppError, RunId, StepRunId } from '@relay/contracts';
import type { Repos, RunRow, StepRow } from '@relay/storage';
import type { EngineCtx } from '../ports.js';
import { applyRunEvent, runEffects } from '../run-machine.js';
import type { PostCommitEffect, RunMachineEvent } from '../run-machine.js';

/** Applies a setup/policy block (CAS from running) in its own tx. */
export async function blockRun(ctx: EngineCtx, runId: RunId, ev: RunMachineEvent): Promise<void> {
  const fx: PostCommitEffect[] = [];
  ctx.db.tx('immediate', (r) => {
    const cur = r.runs.get(runId);
    if (cur.status === 'running') applyRunEvent(r, cur, ev, ctx.clock.now(), fx);
  });
  await runEffects(ctx, fx);
}

/** SETUP_BLOCKED(setup_blocked) for `error`. */
export function setupBlocked(error: AppError): RunMachineEvent {
  return { type: 'SETUP_BLOCKED', reason: 'setup_blocked', error };
}

/**
 * Runs `fn` in one tx only while the run is still `running` and the step still `ready` (a concurrent cancel/pause
 * may have won); then runs the post-commit effects. Returns whether `fn` ran.
 */
export async function commitIfReady(
  ctx: EngineCtx,
  runId: RunId,
  stepRunId: StepRunId,
  fn: (r: Repos, run: RunRow, step: StepRow, fx: PostCommitEffect[]) => void,
): Promise<boolean> {
  const fx: PostCommitEffect[] = [];
  const ran = ctx.db.tx('immediate', (r) => {
    const run = r.runs.get(runId);
    const step = r.steps.get(stepRunId);
    if (run.status !== 'running' || step.state !== 'ready') return false;
    fn(r, run, step, fx);
    return true;
  });
  await runEffects(ctx, fx);
  return ran;
}
