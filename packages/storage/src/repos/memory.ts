import type { MemoryId, Result } from '@relay/contracts';
import { err, errors, idSchema, invariant, ok } from '@relay/contracts';
import type { SqlDriver } from '../driver.js';
import { mapMemoryEvent, mapMemoryItem, mapMemoryRevision, mapRunMemorySnapshot, RowReader } from '../mappers.js';
import { bit, jsonParam, toJson } from '../sql.js';
import type { MemoryItem, MemoryRecordInsert, MemoryRepo, MemoryRevisionInsert, MemoryRevisionRow } from '../types.js';
import type { RepoDeps } from './deps.js';

/** Records joined with their current revision (aliased `rev_*` for {@link mapMemoryItem}). */
const ITEM_SELECT = `SELECT m.*, v.id AS rev_id, v.record_id AS rev_record_id, v.revision AS rev_revision, v.title AS rev_title,
    v.content AS rev_content, v.source_refs_json AS rev_source_refs_json, v.author AS rev_author, v.created_at AS rev_created_at
  FROM memory_records m JOIN memory_revisions v ON v.record_id = m.id AND v.revision = m.current_revision`;

/** Escapes LIKE wildcards so the user query is matched literally. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function createMemoryRepo(driver: SqlDriver, deps: RepoDeps): MemoryRepo {
  const get = (id: MemoryId): MemoryItem | undefined => {
    const row = driver.prepare(`${ITEM_SELECT} WHERE m.id = ?`).get(id);
    return row === undefined ? undefined : mapMemoryItem(row);
  };
  const insertRevision = (recordId: MemoryId, revision: number, rev: MemoryRevisionInsert): MemoryRevisionRow => {
    const row = driver
      .prepare(
        `INSERT INTO memory_revisions (id, record_id, revision, title, content, source_refs_json, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(rev.id, recordId, revision, rev.title, rev.content, toJson(rev.sourceRefs), rev.author, rev.createdAt);
    return mapMemoryRevision(row);
  };

  const insertRecordAndRevision = (rec: MemoryRecordInsert, rev: MemoryRevisionInsert): MemoryItem => {
    driver
      .prepare(
        `INSERT INTO memory_records (id, project_id, type, status, current_revision, scope_json, pinned, expires_at,
           review_at, source_run_id, proposal_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.projectId,
        rec.type,
        rec.status,
        toJson(rec.scope),
        bit(rec.pinned ?? false),
        rec.expiresAt ?? null,
        rec.reviewAt ?? null,
        rec.sourceRunId ?? null,
        jsonParam(rec.proposal) ?? null,
        rec.createdAt,
        rec.createdAt,
      );
    insertRevision(rec.id, 1, rev);
    const item = get(rec.id);
    invariant(item !== undefined, 'memory record missing after insert');
    return item;
  };

  return {
    insertRecord(rec, rev) {
      // Record + first revision are one unit (joins an open tx): an invalid revision never leaves an orphan record.
      return deps.inTx(() => insertRecordAndRevision(rec, rev));
    },
    get,
    getWithRevisions(id) {
      const item = get(id);
      if (item === undefined) {
        return undefined;
      }
      const revisions = driver
        .prepare('SELECT * FROM memory_revisions WHERE record_id = ? ORDER BY revision')
        .all(id)
        .map((r) => mapMemoryRevision(r));
      const events = driver.prepare('SELECT * FROM memory_events WHERE record_id = ? ORDER BY created_at, id').all(id).map(mapMemoryEvent);
      return { item, revisions, events };
    },
    list(q) {
      return driver
        .prepare(
          `${ITEM_SELECT} WHERE m.project_id = ?1
             AND (?2 IS NULL OR m.status IN (SELECT value FROM json_each(?2)))
             AND (?3 IS NULL OR m.type IN (SELECT value FROM json_each(?3)))
             AND (?4 IS NULL OR v.title LIKE ?4 ESCAPE '\\' OR v.content LIKE ?4 ESCAPE '\\')
           ORDER BY m.pinned DESC, m.updated_at DESC, m.id`,
        )
        .all(
          q.projectId,
          q.statuses === undefined ? null : JSON.stringify(q.statuses),
          q.types === undefined ? null : JSON.stringify(q.types),
          q.query === undefined || q.query === '' ? null : likePattern(q.query),
        )
        .map(mapMemoryItem);
    },
    retrievable(projectId, role, now) {
      // §10.5: always filtered by project; approved, unexpired, not deleted, and in scope for the role.
      return driver
        .prepare(
          `${ITEM_SELECT} WHERE m.project_id = ?1 AND m.status = 'approved' AND m.deleted_at IS NULL
             AND (m.expires_at IS NULL OR m.expires_at > ?3)
             AND (json_extract(m.scope_json, '$.roles') = 'all'
                  OR EXISTS (SELECT 1 FROM json_each(m.scope_json, '$.roles') WHERE value = ?2))
           ORDER BY m.pinned DESC, m.updated_at DESC, m.id`,
        )
        .all(projectId, role, now)
        .map(mapMemoryItem);
    },
    addRevision(recordId, rev, expectedRevision): Result<MemoryRevisionRow> {
      const next = expectedRevision + 1;
      // CAS bump + revision insert are one unit (joins an open tx): a rejected revision never moves the pointer.
      return deps.inTx(() => {
        const changes = driver
          .prepare('UPDATE memory_records SET current_revision = ?, updated_at = ? WHERE id = ? AND current_revision = ?')
          .run(next, rev.createdAt, recordId, expectedRevision).changes;
        if (changes === 0) {
          return err(errors.conflict({ entity: 'memory', expectedRevision }));
        }
        return ok(insertRevision(recordId, next, rev));
      });
    },
    setStatus(id, from, to, at) {
      invariant(from.length > 0, 'setStatus requires at least one from-status');
      return (
        driver
          .prepare(
            `UPDATE memory_records SET status = ?1, updated_at = ?2,
               deleted_at = CASE WHEN ?1 = 'deleted' THEN ?2 ELSE deleted_at END
             WHERE id = ?3 AND status IN (SELECT value FROM json_each(?4))`,
          )
          .run(to, at, id, JSON.stringify(from)).changes > 0
      );
    },
    setSupersededBy(id, supersededById, at) {
      driver.prepare('UPDATE memory_records SET superseded_by_id = ?, updated_at = ? WHERE id = ?').run(supersededById, at, id);
    },
    setAttributes(id, patch, at) {
      // Each column is replaced only when its key is present (flag = 1), so `null` can clear expires/review dates.
      const has = (k: keyof typeof patch) => bit(patch[k] !== undefined);
      driver
        .prepare(
          `UPDATE memory_records SET
             scope_json = CASE WHEN ?1 THEN ?2 ELSE scope_json END,
             pinned = CASE WHEN ?3 THEN ?4 ELSE pinned END,
             expires_at = CASE WHEN ?5 THEN ?6 ELSE expires_at END,
             review_at = CASE WHEN ?7 THEN ?8 ELSE review_at END,
             updated_at = ?9
           WHERE id = ?10`,
        )
        .run(
          has('scope'), patch.scope === undefined ? null : toJson(patch.scope),
          has('pinned'), bit(patch.pinned ?? false),
          has('expiresAt'), patch.expiresAt ?? null,
          has('reviewAt'), patch.reviewAt ?? null,
          at, id,
        );
    },
    countRunSnapshots(recordId) {
      const row = driver.prepare('SELECT COUNT(*) AS n FROM run_memory_snapshot WHERE record_id = ?').get(recordId);
      return new RowReader('run_memory_snapshot', row).int('n');
    },
    recordEvent(e) {
      const row = driver
        .prepare(
          `INSERT INTO memory_events (id, record_id, event, revision, actor, detail_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(deps.ids.next('event'), e.recordId, e.event, e.revision, e.actor, jsonParam(e.detail) ?? null, e.createdAt);
      return mapMemoryEvent(row);
    },
    snapshotForRun(runId, rows) {
      deps.inTx(() => {
        const stmt = driver.prepare(
          `INSERT INTO run_memory_snapshot (run_id, record_id, revision, title, content, included) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const r of rows) {
          stmt.run(runId, r.recordId, r.revision, r.title, r.content, bit(r.included));
        }
      });
    },
    runSnapshot(runId) {
      return driver
        .prepare('SELECT * FROM run_memory_snapshot WHERE run_id = ? ORDER BY record_id')
        .all(runId)
        .map(mapRunMemorySnapshot);
    },
    purgeRunSnapshots(projectId) {
      const recordIds = driver
        .prepare(
          `DELETE FROM run_memory_snapshot WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)
           RETURNING record_id`,
        )
        .all(projectId)
        .map((r) => new RowReader('run_memory_snapshot', r, 'record_id').as('record_id', idSchema('memory')));
      return { deleted: recordIds.length, recordIds: [...new Set(recordIds)] };
    },
  };
}
