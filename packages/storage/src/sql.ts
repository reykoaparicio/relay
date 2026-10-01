// Small helpers for static, parameterized SQL (00b §4). Column names passed here are compile-time constants of the
// repositories, never user or model text.
import { ACTIVE_RUN_STATUSES, invariant } from '@relay/contracts';
import type { SqlParam } from './driver.js';
import type { ListSort } from './types.js';

/**
 * `col = CASE WHEN ? THEN ? ELSE col END` for each column, so one prepared statement can update any subset of
 * columns: bind a `[flag, value]` pair per column with {@link optionalParams}.
 */
export function optionalSetClause(columns: readonly string[]): string {
  return columns.map((c) => `${c} = CASE WHEN ? THEN ? ELSE ${c} END`).join(', ');
}

/** Binds `[1, value]` for provided values and `[0, null]` for `undefined` (keep the current value). */
export function optionalParams(values: readonly (SqlParam | undefined)[]): SqlParam[] {
  return values.flatMap((v): SqlParam[] => (v === undefined ? [0, null] : [1, v]));
}

/** JSON-encodes a value for a JSON column; `undefined` stays `undefined` (absent), `null` stays SQL NULL. */
export function jsonParam(v: unknown): string | null | undefined {
  if (v === undefined) {
    return undefined;
  }
  return v === null ? null : JSON.stringify(v);
}

/** JSON-encodes a required value. */
export function toJson(v: unknown): string {
  return JSON.stringify(v ?? null);
}

/** SQLite boolean. */
export const bit = (b: boolean): number => (b ? 1 : 0);

/** Keyset fragments on (created_at, id) for the whitelisted sorts (03 §C6). */
export const KEYSET: Record<ListSort, { readonly after: string; readonly order: string }> = {
  created_desc: { after: '(created_at, id) < (?, ?)', order: 'ORDER BY created_at DESC, id DESC' },
  created_asc: { after: '(created_at, id) > (?, ?)', order: 'ORDER BY created_at ASC, id ASC' },
};

/**
 * A SQL literal list (`'a', 'b'`) of compile-time enum constants (never user or model text; each value is asserted to
 * be a lowercase identifier). Used where a literal `IN (…)` is needed so the planner can match a partial index, which
 * a bound `json_each(?)` list cannot do.
 */
function sqlLiteralList(values: readonly string[]): string {
  for (const v of values) invariant(/^[a-z_]+$/.test(v), `not an enum constant: ${v}`);
  return values.map((v) => `'${v}'`).join(', ');
}

/** `status IN (…active…)`, term-for-term the `runs_active_idx` partial index WHERE (03 C3), so that index is used. */
export const ACTIVE_STATUS_IN = `status IN (${sqlLiteralList(ACTIVE_RUN_STATUSES)})`;
