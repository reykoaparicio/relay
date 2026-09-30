import { errors } from '@relay/contracts';
import type { Result } from '@relay/contracts';
import { err, ok } from '@relay/contracts';
import type { ListSort } from './types.js';

/** Decoded keyset position. */
export interface CursorPosition {
  readonly createdAt: number;
  readonly id: string;
}

/** Opaque base64url of `{ c: created_at, i: id, s: sort }` (03 §C6). */
export function encodeCursor(pos: CursorPosition, sort: ListSort): string {
  return Buffer.from(JSON.stringify({ c: pos.createdAt, i: pos.id, s: sort }), 'utf8').toString('base64url');
}

function invalid(message: string): Result<never> {
  return err(errors.validationFailed([{ path: 'cursor', message, code: 'invalid_cursor' }]));
}

/** Decodes a cursor. A malformed cursor, or one issued for another sort, is `VALIDATION_FAILED`. */
export function decodeCursor(cursor: string, sort: ListSort): Result<CursorPosition> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return invalid('malformed cursor');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return invalid('malformed cursor');
  }
  const { c, i, s } = parsed as { c?: unknown; i?: unknown; s?: unknown };
  if (typeof c !== 'number' || !Number.isSafeInteger(c) || typeof i !== 'string') {
    return invalid('malformed cursor');
  }
  if (s !== sort) {
    return invalid('cursor was issued for a different sort');
  }
  return ok({ createdAt: c, id: i });
}
