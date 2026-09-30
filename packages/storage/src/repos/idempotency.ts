import { RelayError, err, errors, ok } from '@relay/contracts';
import type { SqlDriver } from '../driver.js';
import { RowReader } from '../mappers.js';
import type { IdempotencyRecord, IdempotencyRepo, IdempotentResult } from '../types.js';
import type { RepoDeps } from './deps.js';

/** CHECK cap on `idempotency_keys.result_json` (R4-30): ids + status only, never a DTO. */
export const IDEMPOTENT_RESULT_MAX_BYTES = 2048;

function isIdempotentResult(v: unknown): v is IdempotentResult {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const { ids, status } = v as { ids?: unknown; status?: unknown };
  const idsOk =
    typeof ids === 'object' && ids !== null && !Array.isArray(ids) && Object.values(ids).every((x) => typeof x === 'string');
  return idsOk && (status === undefined || typeof status === 'string');
}

export function createIdempotencyRepo(driver: SqlDriver, deps: RepoDeps): IdempotencyRepo {
  const get = (op: string, key: string): IdempotencyRecord | undefined => {
    const row = driver.prepare('SELECT * FROM idempotency_keys WHERE op = ? AND key = ?').get(op, key);
    if (row === undefined) {
      return undefined;
    }
    const r = new RowReader('idempotency_keys', row, 'key');
    return Object.freeze({
      requestHash: r.text('request_hash'),
      result: r.jsonGuard('result_json', isIdempotentResult),
      createdAt: r.ms('created_at'),
    });
  };
  return {
    get,
    put(op, key, requestHash, result) {
      const existing = get(op, key);
      if (existing !== undefined) {
        return existing.requestHash === requestHash
          ? ok(existing.result)
          : err(errors.conflict({ reason: 'idempotency_key_reused', op }));
      }
      const json = JSON.stringify(result);
      if (Buffer.byteLength(json, 'utf8') > IDEMPOTENT_RESULT_MAX_BYTES) {
        throw new RelayError(
          errors.validationFailed([{ path: 'result', message: 'idempotent result exceeds 2048 bytes', code: 'too_big' }]),
        );
      }
      driver
        .prepare('INSERT INTO idempotency_keys (op, key, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(op, key, requestHash, json, deps.clock.now());
      return ok(result);
    },
    sweep(olderThan) {
      return driver.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(olderThan).changes;
    },
  };
}
