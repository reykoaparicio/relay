import type { SqlDriver } from '../driver.js';
import { mapRunEvent, readInt } from '../mappers.js';
import { toJson } from '../sql.js';
import type { EventRepo } from '../types.js';
import type { RepoDeps } from './deps.js';

export function createEventRepo(driver: SqlDriver, deps: RepoDeps): EventRepo {
  return {
    append(runId, type, payload) {
      // seq is computed in the same statement; the single writer holds the write lock, so it cannot race.
      const row = driver
        .prepare(
          `INSERT INTO run_events (id, run_id, seq, type, payload_json, created_at)
           VALUES (?1, ?2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM run_events WHERE run_id = ?2), ?3, ?4, ?5)
           RETURNING *`,
        )
        .get(deps.ids.next('event'), runId, type, toJson(payload), deps.clock.now());
      return mapRunEvent(row);
    },
    list(runId, afterSeq, limit) {
      return driver
        .prepare('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .all(runId, afterSeq, limit)
        .map(mapRunEvent);
    },
    lastSeq(runId) {
      return readInt('run_events', driver.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM run_events WHERE run_id = ?').get(runId), 'n');
    },
  };
}
