// Small helpers for static, parameterized SQL (00b §4). Column names passed here are compile-time constants of the
// repositories, never user or model text.
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
