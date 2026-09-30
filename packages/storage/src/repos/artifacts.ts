import type { ArtifactId } from '@relay/contracts';
import { RelayError, errors } from '@relay/contracts';
import type { SqlDriver } from '../driver.js';
import { mapArtifact } from '../mappers.js';
import { bit } from '../sql.js';
import type { ArtifactInsert, ArtifactRepo, ArtifactRow } from '../types.js';

const WHERE_SQL = `SELECT a.* FROM artifacts a
  WHERE (?1 IS NULL OR a.kind IN (SELECT value FROM json_each(?1)))
    AND (?2 IS NULL OR a.project_id = ?2)
    AND (?3 IS NULL OR a.created_at < ?3)
    AND (?4 = 0 OR a.purged_at IS NULL)
  ORDER BY a.created_at, a.id`;

export function createArtifactRepo(driver: SqlDriver): ArtifactRepo {
  const get = (id: ArtifactId): ArtifactRow | undefined => {
    const row = driver.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
    return row === undefined ? undefined : mapArtifact(row);
  };
  const one = (sql: string, ...params: string[]): ArtifactRow | undefined => {
    const row = driver.prepare(sql).get(...params);
    return row === undefined ? undefined : mapArtifact(row);
  };
  const findExisting = (m: ArtifactInsert): ArtifactRow | undefined => {
    if (m.attemptId !== undefined && m.attemptId !== null) {
      const hit = one('SELECT * FROM artifacts WHERE attempt_id = ? AND kind = ? AND sha256 = ?', m.attemptId, m.kind, m.sha256);
      if (hit !== undefined) {
        return hit;
      }
    }
    if (m.kind === 'input_file' && m.runId !== undefined && m.runId !== null) {
      const hit = one("SELECT * FROM artifacts WHERE run_id = ? AND sha256 = ? AND kind = 'input_file'", m.runId, m.sha256);
      if (hit !== undefined) {
        return hit;
      }
    }
    return get(m.id);
  };

  return {
    insertIfAbsent(m) {
      const changes = driver
        .prepare(
          `INSERT INTO artifacts (id, run_id, project_id, step_run_id, attempt_id, kind, rel_path, sha256, size_bytes,
             media_type, schema_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(
          m.id,
          m.runId ?? null,
          m.projectId,
          m.stepRunId ?? null,
          m.attemptId ?? null,
          m.kind,
          m.relPath,
          m.sha256,
          m.sizeBytes,
          m.mediaType,
          m.schemaId ?? null,
          m.createdAt,
        ).changes;
      const row = changes > 0 ? get(m.id) : findExisting(m);
      if (row === undefined) {
        // e.g. the same rel_path already holds different content: never silently alias it.
        throw new RelayError(errors.conflict({ entity: 'artifact', reason: 'rel_path_taken' }));
      }
      return row;
    },
    findInputFile(runId, sha256) {
      return one("SELECT * FROM artifacts WHERE run_id = ? AND sha256 = ? AND kind = 'input_file'", runId, sha256);
    },
    get,
    listForRun(runId, kinds) {
      return driver
        .prepare(
          `SELECT * FROM artifacts WHERE run_id = ? AND (?2 IS NULL OR kind IN (SELECT value FROM json_each(?2)))
           ORDER BY created_at, id`,
        )
        .all(runId, kinds === undefined ? null : JSON.stringify(kinds))
        .map(mapArtifact);
    },
    listWhere(f) {
      return driver
        .prepare(WHERE_SQL)
        .all(
          f.kinds === undefined ? null : JSON.stringify(f.kinds),
          f.projectId ?? null,
          f.createdBefore ?? null,
          bit(f.unpurgedOnly ?? false),
        )
        .map(mapArtifact);
    },
    markPurged(id, at) {
      return driver.prepare('UPDATE artifacts SET purged_at = ? WHERE id = ? AND purged_at IS NULL').run(at, id).changes > 0;
    },
  };
}
