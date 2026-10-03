// 08 H7 maintenance mode: when main forks the runner with `RELAY_RUNNER_TASK`, the runner runs that one task INSTEAD
// of booting the engine (it never opens the live database, so it works when that file is corrupt, locked, or from a
// newer schema), posts `maintenance.result`, and exits. Main only does this while no other runner is alive.
import { RUNNER_MAINTENANCE_TASKS, epochMs, errors, isRelayError, systemClock, toDisplayPath } from '@relay/contracts';
import type { Clock, RunnerMaintenanceTask, RunnerMessage } from '@relay/contracts';
import { restoreLatestBackup } from '@relay/storage';
import type { RestoreOptions, RestoreResult } from '@relay/storage';

/** The `result` of a `maintenance.result` message. */
export type MaintenanceResult = Extract<RunnerMessage, { kind: 'maintenance.result' }>['result'];

/**
 * The maintenance task named by `RELAY_RUNNER_TASK`, or undefined when unset.
 * @throws Error for an unknown task: the runner must never fall back to booting the engine when main asked for a task.
 */
export function readMaintenanceTask(env: NodeJS.ProcessEnv): RunnerMaintenanceTask | undefined {
  const raw = env['RELAY_RUNNER_TASK'];
  if (raw === undefined || raw === '') return undefined;
  if ((RUNNER_MAINTENANCE_TASKS as readonly string[]).includes(raw)) return raw as RunnerMaintenanceTask;
  throw new Error(`unknown RELAY_RUNNER_TASK: ${raw.slice(0, 40)}`);
}

/** Dependencies of {@link runMaintenanceTask}. */
export interface MaintenanceDeps {
  readonly userDataDir: string;
  readonly homeDir: string;
  readonly clock?: Clock;
  readonly restore?: (opts: RestoreOptions) => Promise<RestoreResult | null>;
}

async function restoreTask(d: MaintenanceDeps): Promise<MaintenanceResult> {
  const display = (p: string): string => toDisplayPath(p, d.homeDir);
  try {
    const r = await (d.restore ?? restoreLatestBackup)({ userDataDir: d.userDataDir, clock: d.clock ?? systemClock });
    if (r === null) return { ok: true, restored: false, restoredFromDisplayPath: null, backupCreatedAt: null, previousMovedToDisplayPath: null };
    return {
      ok: true, restored: true, restoredFromDisplayPath: display(r.restoredFrom),
      backupCreatedAt: epochMs(r.backupCreatedAt), previousMovedToDisplayPath: r.previousMovedTo === null ? null : display(r.previousMovedTo),
    };
  } catch (e) {
    return { ok: false, error: isRelayError(e) ? e.appError : errors.artifactWriteFailed() };
  }
}

const TASKS: Readonly<Record<RunnerMaintenanceTask, (d: MaintenanceDeps) => Promise<MaintenanceResult>>> = {
  restore_latest_backup: restoreTask,
};

/** Runs `task`; never throws (a failure becomes `{ ok: false, error }`). Paths in the result are display paths. */
export function runMaintenanceTask(task: RunnerMaintenanceTask, d: MaintenanceDeps): Promise<MaintenanceResult> {
  return TASKS[task](d);
}
