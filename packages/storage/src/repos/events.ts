import type { SqlDriver } from '../driver.js';
import { mapRunEvent, readInt, RowReader } from '../mappers.js';
import { toJson } from '../sql.js';
import type { EventRepo } from '../types.js';
import type { RepoDeps } from './deps.js';

/** `?1` run id, `?2` re-snapshot kind, `?3` approval-invalidation kind. Each subquery seeks `run_events_type_idx`. */
const SNAPSHOT_BINDING_SQL = `SELECT
  (SELECT COALESCE(MAX(seq), 0) FROM run_events
    WHERE run_id = ?1 AND type = 'context.assembled' AND json_extract(payload_json, '$.kind') = ?2) AS resnapshot_seq,
  (SELECT COALESCE(MAX(seq), 0) FROM run_events WHERE run_id = ?1 AND type = 'run.snapshot_preserved') AS preserved_seq,
  (SELECT seq FROM run_events
    WHERE run_id = ?1 AND type = 'error.recorded' AND json_extract(payload_json, '$.kind') = ?3
    ORDER BY seq DESC LIMIT 1) AS mark_seq,
  (SELECT CASE WHEN json_type(payload_json, '$.approvalId') = 'text' THEN json_extract(payload_json, '$.approvalId') END
    FROM run_events WHERE run_id = ?1 AND type = 'error.recorded' AND json_extract(payload_json, '$.kind') = ?3
    ORDER BY seq DESC LIMIT 1) AS mark_approval_id`;

const LIST_FOR_STEP_SQL = `SELECT * FROM run_events WHERE run_id = ?1
    AND (json_extract(payload_json, '$.stepRunId') = ?2
      OR (json_type(payload_json, '$.attemptId') = 'text'
        AND json_extract(payload_json, '$.attemptId') IN (SELECT value FROM json_each(?3))))
  ORDER BY seq`;

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
    snapshotBinding(runId, kinds) {
      const r = new RowReader('run_events', driver.prepare(SNAPSHOT_BINDING_SQL).get(runId, kinds.resnapshot, kinds.approvalInvalidated), 'mark_approval_id');
      const markSeq = r.intN('mark_seq');
      return {
        resnapshotSeq: r.int('resnapshot_seq'),
        preservedSeq: r.int('preserved_seq'),
        invalidation: markSeq === null ? null : { seq: markSeq, approvalId: r.textN('mark_approval_id') },
      };
    },
    listForStep(runId, stepRunId, attemptIds) {
      return driver.prepare(LIST_FOR_STEP_SQL).all(runId, stepRunId, JSON.stringify(attemptIds)).map(mapRunEvent);
    },
  };
}
