// 06 F12: execution deadline (§9.1). Execution time accrues ONLY while `running` (R3-5); the timer arms per running
// segment (post-commit effect of applyRunEvent) and is cleared on leaving `running`.
import { errors } from '@relay/contracts';
import type { EpochMs, RunId } from '@relay/contracts';
import type { RunRow } from '@relay/storage';
import type { DeadlineWatcher, EngineCtx } from './ports.js';
import { applyRunEvent, runEffects } from './run-machine.js';
import type { PostCommitEffect } from './run-machine.js';

type DeadlineRun = Pick<RunRow, 'executionMsUsed' | 'runningSince' | 'limits'>;

/** Execution ms used including the open running segment. */
export function executionMsAt(run: DeadlineRun, now: EpochMs): number {
  return run.executionMsUsed + (run.runningSince === null ? 0 : Math.max(0, now - run.runningSince));
}

/** `execution_ms_used + (now − running_since) ≥ executionTimeoutSeconds × 1000`. */
export function deadlineReached(run: DeadlineRun, now: EpochMs): boolean {
  return executionMsAt(run, now) >= run.limits.executionTimeoutSeconds * 1000;
}

/** Remaining execution ms (never negative). */
export function remainingExecutionMs(run: DeadlineRun, now: EpochMs): number {
  return Math.max(0, run.limits.executionTimeoutSeconds * 1000 - executionMsAt(run, now));
}

/**
 * Creates the per-run segment timer. On fire: in-flight attempts are aborted with `{ kind: 'deadline' }` (they settle
 * through F4 step 7, which applies LIMIT_REACHED); with nothing in flight the watcher applies LIMIT_REACHED itself.
 */
export function createDeadlineWatcher(ctx: Pick<EngineCtx, 'db' | 'clock' | 'timers' | 'cancellation' | 'logger' | 'emit' | 'wake' | 'onTerminal'> & {
  readonly deadlines?: DeadlineWatcher;
}): DeadlineWatcher {
  const armed = new Map<RunId, unknown>();
  const fire = async (runId: RunId): Promise<void> => {
    armed.delete(runId);
    if (ctx.cancellation.hasInFlight(runId)) {
      ctx.cancellation.abortRun(runId, { kind: 'deadline' });
      return;
    }
    const fx: PostCommitEffect[] = [];
    ctx.db.tx('immediate', (r) => {
      const run = r.runs.get(runId);
      const now = ctx.clock.now();
      if (run.status !== 'running' || !deadlineReached(run, now)) return;
      applyRunEvent(r, run, { type: 'LIMIT_REACHED', reason: 'deadline', error: errors.limitReached('deadline') }, now, fx);
    });
    await runEffects({ ...ctx, deadlines: watcher }, fx);
  };
  const disarm = (runId: RunId): void => {
    const h = armed.get(runId);
    if (h !== undefined) ctx.timers.clearTimeout(h);
    armed.delete(runId);
  };
  const watcher: DeadlineWatcher = {
    arm(runId) {
      disarm(runId);
      const run = ctx.db.repos.runs.find(runId);
      if (run?.status !== 'running') return;
      const ms = remainingExecutionMs(run, ctx.clock.now());
      armed.set(runId, ctx.timers.setTimeout(() => {
        fire(runId).catch((e: unknown) => {
          ctx.logger.error('deadline.fire_failed', { runId, err: e instanceof Error ? e.message : String(e) });
        });
      }, ms));
    },
    disarm,
    disarmAll() {
      for (const runId of [...armed.keys()]) disarm(runId);
    },
  };
  return watcher;
}
