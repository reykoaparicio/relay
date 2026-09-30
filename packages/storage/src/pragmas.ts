import type { SqlDriver } from './driver.js';
import { integrityError } from './errors.js';

/** 03 §C1 connection pragmas, applied on open in this order. */
export const CONNECTION_PRAGMAS: readonly string[] = [
  'PRAGMA journal_mode = WAL', // readers never block the single writer
  'PRAGMA synchronous = FULL', // durability for ledger/checkpoints over speed (§3.3 no corruption)
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA trusted_schema = OFF',
  'PRAGMA temp_store = MEMORY',
];

/** Applies {@link CONNECTION_PRAGMAS} to a read-write connection. */
export function applyPragmas(driver: SqlDriver): void {
  for (const pragma of CONNECTION_PRAGMAS) {
    driver.exec(pragma);
  }
}

/**
 * Runs `PRAGMA quick_check` (03 §C1).
 * @throws RelayError `INTERNAL` with a restore-from-backups hint when the check does not return `ok`.
 */
export function quickCheck(driver: SqlDriver): void {
  const rows = driver.prepare('PRAGMA quick_check').all();
  const results = rows.map((r): unknown => (typeof r === 'object' && r !== null ? (Object.values(r) as unknown[])[0] : undefined));
  if (results.length !== 1 || results[0] !== 'ok') {
    throw integrityError(results.map(String).join('; '));
  }
}
