import type { AttemptId } from '@relay/contracts';
import { RelayError, errors, invariant } from '@relay/contracts';
import type { SqlDriver } from '../driver.js';
import { mapAttempt, readInt } from '../mappers.js';
import { jsonParam, optionalParams, optionalSetClause, toJson } from '../sql.js';
import type { AttemptRepo, AttemptRow } from '../types.js';

const UNRESOLVED = "('created', 'reserved', 'dispatching', 'unknown')";

/** An optional boolean column value (undefined = keep the current value). */
const boolParam = (v: boolean | undefined): number | undefined => (v === undefined ? undefined : v ? 1 : 0);

// Provider ids are write-once per column (COALESCE keeps an existing id), everything else is set when provided.
const TRANSITION_SQL = `UPDATE attempts SET state = ?, ${optionalSetClause([
  'dispatched_at',
  'first_byte_at',
  'finished_at',
  'usage_json',
  'raw_usage_json',
  'stop_reason',
  'error_json',
  'outcome_uncertain',
  'may_not_have_been_charged',
])},
  provider_request_id = COALESCE(provider_request_id, ?),
  provider_response_id = COALESCE(provider_response_id, ?)
  WHERE id = ? AND state IN (SELECT value FROM json_each(?))`;

export function createAttemptRepo(driver: SqlDriver): AttemptRepo {
  const find = (id: AttemptId): AttemptRow | undefined => {
    const row = driver.prepare('SELECT * FROM attempts WHERE id = ?').get(id);
    return row === undefined ? undefined : mapAttempt(row);
  };
  const get = (id: AttemptId): AttemptRow => {
    const a = find(id);
    if (a === undefined) {
      throw new RelayError(errors.notFound('attempt'));
    }
    return a;
  };
  return {
    insert(a) {
      invariant(Number.isSafeInteger(a.reservationMicrousd), 'reservation must be a safe-integer µUSD amount');
      driver
        .prepare(
          `INSERT INTO attempts (id, run_id, step_run_id, seq, purpose, retry_of_attempt_id, provider_id, model_id,
             profile_snapshot_json, request_fingerprint, state, reservation_microusd, estimate_json, price_catalog_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          a.id,
          a.runId,
          a.stepRunId,
          a.seq,
          a.purpose,
          a.retryOfAttemptId ?? null,
          a.providerId,
          a.modelId,
          toJson(a.profileSnapshot),
          a.requestFingerprint,
          a.state,
          a.reservationMicrousd,
          jsonParam(a.estimate) ?? null,
          a.priceCatalogVersion,
          a.createdAt,
        );
      return get(a.id);
    },
    get,
    find,
    transition(id, from, to, fields) {
      invariant(from.length > 0, 'transition requires at least one from-state');
      const changes = driver
        .prepare(TRANSITION_SQL)
        .run(
          to,
          ...optionalParams([
            fields.dispatchedAt,
            fields.firstByteAt,
            fields.finishedAt,
            jsonParam(fields.usage),
            jsonParam(fields.rawUsage),
            fields.stopReason,
            jsonParam(fields.error),
            boolParam(fields.outcomeUncertain),
            boolParam(fields.mayNotHaveBeenCharged),
          ]),
          fields.providerRequestId ?? null,
          fields.providerResponseId ?? null,
          id,
          JSON.stringify(from),
        ).changes;
      return changes > 0;
    },
    listForStep(stepRunId) {
      return driver.prepare('SELECT * FROM attempts WHERE step_run_id = ? ORDER BY seq').all(stepRunId).map(mapAttempt);
    },
    listForRun(runId) {
      return driver.prepare('SELECT * FROM attempts WHERE run_id = ? ORDER BY created_at, seq').all(runId).map(mapAttempt);
    },
    countInState(runId, state) {
      return readInt('attempts', driver.prepare('SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND state = ?').get(runId, state), 'n');
    },
    listUnresolved(runId) {
      return driver
        .prepare(`SELECT * FROM attempts WHERE (?1 IS NULL OR run_id = ?1) AND state IN ${UNRESOLVED} ORDER BY created_at, id`)
        .all(runId ?? null)
        .map(mapAttempt);
    },
    setProviderIds(id, ids) {
      driver
        .prepare(
          `UPDATE attempts SET provider_request_id = COALESCE(provider_request_id, ?),
             provider_response_id = COALESCE(provider_response_id, ?) WHERE id = ?`,
        )
        .run(ids.requestId ?? null, ids.responseId ?? null, id);
    },
    markUncertain(id, mayNotHaveBeenCharged) {
      return driver.prepare('UPDATE attempts SET outcome_uncertain = 1, may_not_have_been_charged = ? WHERE id = ?').run(mayNotHaveBeenCharged ? 1 : 0, id).changes > 0;
    },
    listUncertain(runId) {
      return driver.prepare('SELECT * FROM attempts WHERE run_id = ? AND outcome_uncertain = 1 ORDER BY created_at, seq').all(runId).map(mapAttempt);
    },
    listReconcileCandidates() {
      return driver
        .prepare(
          `SELECT * FROM attempts WHERE state = 'unknown'
             OR (state = 'abandoned' AND outcome_uncertain = 1 AND lookup_done = 0 AND provider_response_id IS NOT NULL)
             ORDER BY created_at, id`,
        )
        .all()
        .map(mapAttempt);
    },
    markLookupDone(id) {
      return driver.prepare('UPDATE attempts SET lookup_done = 1 WHERE id = ? AND lookup_done = 0').run(id).changes > 0;
    },
    nextSeq(stepRunId) {
      const row = driver.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM attempts WHERE step_run_id = ?').get(stepRunId);
      return readInt('attempts', row, 'n');
    },
  };
}
