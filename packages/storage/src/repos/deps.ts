import type { Clock, IdGen } from '@relay/contracts';

/** Dependencies shared by every repository factory (00b §2.4: clock and ids are injected). */
export interface RepoDeps {
  readonly clock: Clock;
  readonly ids: IdGen;
  /** PID liveness probe for the lease (03 §C4 `isPidAlive`). */
  readonly isPidAlive: (pid: number) => boolean;
  /** Runs `fn` in a BEGIN IMMEDIATE tx, or directly when one is already open on this connection. */
  readonly inTx: <T>(fn: () => T) => T;
}
