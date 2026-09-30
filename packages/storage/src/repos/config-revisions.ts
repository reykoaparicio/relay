import type { SqlDriver } from '../driver.js';
import { mapConfigRevision } from '../mappers.js';
import { toJson } from '../sql.js';
import type { ConfigRevisionRepo } from '../types.js';
import type { RepoDeps } from './deps.js';

export function createConfigRevisionRepo(driver: SqlDriver, deps: RepoDeps): ConfigRevisionRepo {
  return {
    append(runId, stepKey, prev, next, reason) {
      // revision = max + 1 computed in the same statement (the caller holds the write tx).
      const row = driver
        .prepare(
          `INSERT INTO run_config_revisions (run_id, revision, step_key, previous_profile_json, profile_snapshot_json, reason, created_at)
           VALUES (?1, (SELECT COALESCE(MAX(revision), 0) + 1 FROM run_config_revisions WHERE run_id = ?1), ?2, ?3, ?4, ?5, ?6)
           RETURNING *`,
        )
        .get(runId, stepKey, toJson(prev), toJson(next), reason, deps.clock.now());
      return mapConfigRevision(row);
    },
    effectiveProfile(runId, stepKey) {
      const row = driver
        .prepare('SELECT * FROM run_config_revisions WHERE run_id = ? AND step_key = ? ORDER BY revision DESC LIMIT 1')
        .get(runId, stepKey);
      return row === undefined ? null : mapConfigRevision(row).profileSnapshot;
    },
    list(runId) {
      return driver
        .prepare('SELECT * FROM run_config_revisions WHERE run_id = ? ORDER BY revision')
        .all(runId)
        .map(mapConfigRevision);
    },
  };
}
