import type { EpochMs, RunId, StepRunId } from '@relay/contracts';
import { RelayError, epochMsSchema, errors, invariant } from '@relay/contracts';
import type { SqlDriver } from '../driver.js';
import { mapStep, RowReader } from '../mappers.js';
import { jsonParam, optionalParams, optionalSetClause, toJson } from '../sql.js';
import type { StepRepo, StepRow } from '../types.js';
import type { RepoDeps } from './deps.js';

const INSERT_SQL = `INSERT INTO step_runs (id, run_id, step_key, ordinal, revision_index, retry_index, state, profile_name,
    input_artifact_ids_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** The latest row per step key: no other row of the same key has a larger (revision_index, retry_index). */
const LATEST_ROWS = `SELECT s.* FROM step_runs s WHERE s.run_id = ?1 AND NOT EXISTS (
  SELECT 1 FROM step_runs o WHERE o.run_id = s.run_id AND o.step_key = s.step_key
    AND (o.revision_index, o.retry_index) > (s.revision_index, s.retry_index))`;

const TRANSITION_SQL = `UPDATE step_runs SET state = ?, ${optionalSetClause([
  'profile_name',
  'input_artifact_ids_json',
  'output_artifact_id',
  'outcome',
  'schema_repairs_used',
  'transport_retries_used',
  'rate_limit_waits_used',
  'not_before_at',
  'error_json',
])}, updated_at = ?
  WHERE id = ? AND state IN (SELECT value FROM json_each(?))`;

export function createStepRepo(driver: SqlDriver, deps: RepoDeps): StepRepo {
  const find = (id: StepRunId): StepRow | undefined => {
    const row = driver.prepare('SELECT * FROM step_runs WHERE id = ?').get(id);
    return row === undefined ? undefined : mapStep(row);
  };
  const get = (id: StepRunId): StepRow => {
    const s = find(id);
    if (s === undefined) {
      throw new RelayError(errors.notFound('step'));
    }
    return s;
  };
  const latest = (runId: RunId): StepRow[] =>
    driver.prepare(`${LATEST_ROWS} ORDER BY s.ordinal, s.step_key`).all(runId).map(mapStep);

  return {
    insertMany(steps) {
      // All-or-nothing (joins an open tx): a failing row never leaves a partial step graph.
      return deps.inTx(() => {
        const stmt = driver.prepare(INSERT_SQL);
        for (const s of steps) {
          stmt.run(
            s.id,
            s.runId,
            s.stepKey,
            s.ordinal,
            s.revisionIndex ?? 0,
            0,
            s.state,
            s.profileName ?? null,
            toJson(s.inputArtifactIds ?? []),
            s.createdAt,
            s.createdAt,
          );
        }
        return steps.map((s) => get(s.id));
      });
    },
    insertRetry(prev, fields) {
      driver
        .prepare(INSERT_SQL)
        .run(
          fields.id,
          prev.runId,
          prev.stepKey,
          prev.ordinal,
          prev.revisionIndex,
          prev.retryIndex + 1,
          fields.state,
          fields.profileName === undefined ? prev.profileName : fields.profileName,
          toJson(fields.inputArtifactIds ?? prev.inputArtifactIds),
          fields.createdAt,
          fields.createdAt,
        );
      return get(fields.id);
    },
    get,
    find,
    listForRun(runId) {
      return driver
        .prepare('SELECT * FROM step_runs WHERE run_id = ? ORDER BY ordinal, revision_index, retry_index')
        .all(runId)
        .map(mapStep);
    },
    latestPerStepKey: latest,
    latestFor(runId, stepKey) {
      const row = driver
        .prepare(
          'SELECT * FROM step_runs WHERE run_id = ? AND step_key = ? ORDER BY revision_index DESC, retry_index DESC LIMIT 1',
        )
        .get(runId, stepKey);
      return row === undefined ? undefined : mapStep(row);
    },
    listEligible(runId, now) {
      return driver
        .prepare(
          `${LATEST_ROWS} AND s.state IN ('ready', 'reserved') AND (s.not_before_at IS NULL OR s.not_before_at <= ?2)
           ORDER BY s.ordinal, s.step_key`,
        )
        .all(runId, now)
        .map(mapStep);
    },
    earliestNotBefore(runId, now): EpochMs | null {
      const row = driver
        .prepare(
          `SELECT MIN(s.not_before_at) AS t FROM (${LATEST_ROWS}) s
           WHERE s.state IN ('ready', 'reserved') AND s.not_before_at > ?2`,
        )
        .get(runId, now);
      return new RowReader('step_runs', row, 't').asN('t', epochMsSchema);
    },
    setNotBefore(id, at) {
      driver.prepare('UPDATE step_runs SET not_before_at = ?, updated_at = ? WHERE id = ?').run(at, deps.clock.now(), id);
    },
    transition(id, from, to, fields) {
      invariant(from.length > 0, 'transition requires at least one from-state');
      const changes = driver
        .prepare(TRANSITION_SQL)
        .run(
          to,
          ...optionalParams([
            fields.profileName,
            jsonParam(fields.inputArtifactIds),
            fields.outputArtifactId,
            fields.outcome,
            fields.schemaRepairsUsed,
            fields.transportRetriesUsed,
            fields.rateLimitWaitsUsed,
            fields.notBeforeAt,
            jsonParam(fields.error),
          ]),
          deps.clock.now(),
          id,
          JSON.stringify(from),
        ).changes;
      return changes > 0;
    },
  };
}
