import { errnoOf } from '@relay/contracts';

/** `process.kill`-shaped signal function (injectable for tests). */
type KillFn = (pid: number, signal: number) => unknown;

/**
 * Default PID liveness probe (03 §C4): `process.kill(pid, 0)`. `ESRCH` means dead; `EPERM` means **alive** (the
 * process exists but belongs to someone else). Any other failure is treated as alive (fail closed: the lease is kept).
 */
export function defaultIsPidAlive(pid: number, kill: KillFn = (p, s) => process.kill(p, s)): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return errnoOf(e) !== 'ESRCH';
  }
}
