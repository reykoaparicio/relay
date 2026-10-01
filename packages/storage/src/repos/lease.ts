import type { SqlDriver } from '../driver.js';
import { RowReader } from '../mappers.js';
import type { LeaseAcquireResult, LeaseRepo } from '../types.js';
import type { RepoDeps } from './deps.js';

export function createLeaseRepo(driver: SqlDriver, deps: RepoDeps): LeaseRepo {
  const take = (ownerId: string, pid: number, now: number): void => {
    driver
      .prepare(
        `INSERT INTO runner_lease (id, owner_id, pid, acquired_at, heartbeat_at) VALUES (1, ?1, ?2, ?3, ?3)
         ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, pid = excluded.pid,
           acquired_at = CASE WHEN runner_lease.owner_id = excluded.owner_id THEN runner_lease.acquired_at ELSE excluded.acquired_at END,
           heartbeat_at = excluded.heartbeat_at`,
      )
      .run(ownerId, pid, now);
  };
  return {
    acquire(ownerId, pid, now, staleAfterMs): LeaseAcquireResult {
      return deps.inTx(() => {
        const row = driver.prepare('SELECT owner_id, pid, heartbeat_at FROM runner_lease WHERE id = 1').get();
        if (row !== undefined) {
          const r = new RowReader('runner_lease', row, 'owner_id');
          const sameOwner = r.text('owner_id') === ownerId;
          const stale = r.int('heartbeat_at') < now - staleAfterMs; // §6.4: stale regardless of PID (PID reuse)
          if (!sameOwner && !stale && deps.isPidAlive(r.int('pid'))) {
            return 'held_by_other';
          }
        }
        take(ownerId, pid, now);
        return 'acquired';
      });
    },
    heartbeat(ownerId, now) {
      return driver.prepare('UPDATE runner_lease SET heartbeat_at = ? WHERE id = 1 AND owner_id = ?').run(now, ownerId).changes > 0;
    },
    isHeldBy(ownerId) {
      return driver.prepare('SELECT 1 FROM runner_lease WHERE id = 1 AND owner_id = ?').get(ownerId) !== undefined;
    },
    release(ownerId) {
      return driver.prepare('DELETE FROM runner_lease WHERE id = 1 AND owner_id = ?').run(ownerId).changes > 0;
    },
  };
}
