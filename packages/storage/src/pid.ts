/** `process.kill`-shaped signal function (injectable for tests). */
export type KillFn = (pid: number, signal: number) => unknown;

function errorCode(e: unknown): unknown {
  return typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined;
}

/**
 * Default PID liveness probe (03 §C4): `process.kill(pid, 0)`. `ESRCH` means dead; `EPERM` means **alive** (the
 * process exists but belongs to someone else). Any other failure is treated as alive (fail closed: the lease is kept).
 */
export function defaultIsPidAlive(pid: number, kill: KillFn = (p, s) => process.kill(p, s)): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) !== 'ESRCH';
  }
}
