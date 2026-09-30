// 06 F11: cancellation registry (runId → in-flight AbortControllers) and the WORK_STOPPED handler.
import type { RunId } from '@relay/contracts';
import type { AbortReason, CancellationRegistry, EngineCtx } from './ports.js';
import { applyRunEvent, runEffects } from './run-machine.js';
import type { PostCommitEffect } from './run-machine.js';
import { skipOpenSteps } from './step-machine.js';

/** Creates the registry. Controllers are registered BEFORE the step-3 tx, so any later cancel aborts them (F4). */
export function createCancellationRegistry(): CancellationRegistry {
  const byRun = new Map<RunId, Set<AbortController>>();
  const runOf = new Map<AbortController, RunId>();
  return {
    register(runId: RunId) {
      const c = new AbortController();
      const set = byRun.get(runId) ?? new Set<AbortController>();
      set.add(c);
      byRun.set(runId, set);
      runOf.set(c, runId);
      return c;
    },
    unregister(c) {
      const runId = runOf.get(c);
      if (runId === undefined) return;
      runOf.delete(c);
      const set = byRun.get(runId);
      set?.delete(c);
      if (set?.size === 0) byRun.delete(runId);
    },
    abortRun(runId: RunId, reason: AbortReason) {
      const set = byRun.get(runId);
      if (set === undefined) return 0;
      for (const c of set) c.abort(reason);
      return set.size;
    },
    hasInFlight(runId) {
      return (byRun.get(runId)?.size ?? 0) > 0;
    },
  };
}

/**
 * F11 WORK_STOPPED handler: runs once nothing is in flight, AFTER settlement. In one tx every non-terminal step →
 * skipped (unknown steps too; their attempts keep the liability) and the run cancelling → cancelled.
 */
export async function onWorkStopped(ctx: EngineCtx, runId: RunId): Promise<boolean> {
  const fx: PostCommitEffect[] = [];
  const done = ctx.db.tx('immediate', (r) => {
    const run = r.runs.get(runId);
    if (run.status !== 'cancelling') return false;
    skipOpenSteps(r, fx, runId);
    return applyRunEvent(r, run, { type: 'WORK_STOPPED' }, ctx.clock.now(), fx);
  });
  await runEffects(ctx, fx);
  return done;
}
