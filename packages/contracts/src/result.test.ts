import { describe, expect, it } from 'vitest';
import { appError } from './errors.js';
import { err, ipcResultSchema, ok, toIpc } from './result.js';

describe('toIpc', () => {
  it('maps ok(x) to { ok: true, data: x }', () => {
    expect(toIpc(ok(42))).toEqual({ ok: true, data: 42 });
  });

  it('maps err(e) to { ok: false, error: e }', () => {
    const e = appError('NOT_FOUND');

    expect(toIpc(err(e))).toEqual({ ok: false, error: e });
  });

  it('passes meta through on success', () => {
    expect(toIpc(ok([1]), { nextCursor: 'abc' })).toEqual({ ok: true, data: [1], meta: { nextCursor: 'abc' } });
  });
});

describe('ipcResultSchema', () => {
  it('parses both shapes and rejects a malformed error', () => {
    expect(ipcResultSchema.safeParse({ ok: true, data: { a: 1 }, meta: { nextCursor: null } }).success).toBe(true);
    expect(ipcResultSchema.safeParse({ ok: false, error: appError('CONFLICT') }).success).toBe(true);
    expect(ipcResultSchema.safeParse({ ok: false, error: { code: 'NOPE' } }).success).toBe(false);
  });
});
