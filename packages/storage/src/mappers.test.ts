import { sha256Schema } from '@relay/contracts';
import { describe, expect, it } from 'vitest';
import { DataCorruptionError, isSqliteBusy, isSqliteConstraint, mapSqliteError } from './errors.js';
import { mapArtifact, mapRunEvent, RowReader } from './mappers.js';
import type { SqlDriver } from './driver.js';
import { quickCheck } from './pragmas.js';
import { backupStamp } from './stamp.js';

describe('RowReader and mappers', () => {
  it('throws DataCorruptionError with table, id, and column (no content) on bad data', () => {
    const bad = () => mapArtifact({ id: 'art_bad', kind: 'nope' });

    expect(bad).toThrow(DataCorruptionError);
    try {
      bad();
    } catch (e) {
      expect(e).toMatchObject({ table: 'artifacts', id: 'art_bad' });
    }
    expect(() => new RowReader('t', null)).toThrow(DataCorruptionError);
    expect(() => new RowReader('t', [1])).toThrow(DataCorruptionError);
  });

  it('validates each scalar and JSON column kind', () => {
    const r = new RowReader('t', { id: 1, s: 'x', n: 1.5, b: 2, j: '{bad', h: 'zz', e: 'q', nul: null, arr: '[1]' });

    expect(() => r.text('n')).toThrow(DataCorruptionError);
    expect(() => r.int('n')).toThrow(DataCorruptionError);
    expect(() => r.bool('b')).toThrow(DataCorruptionError);
    expect(() => r.jsonAny('j')).toThrow(DataCorruptionError);
    expect(() => r.as('h', sha256Schema)).toThrow(DataCorruptionError);
    expect(() => r.oneOf('e', ['a', 'b'])).toThrow(DataCorruptionError);
    expect(() => r.json('arr', sha256Schema)).toThrow(DataCorruptionError);
    expect(() => r.text('absent')).toThrow(DataCorruptionError);
    expect(r.textN('nul')).toBeNull();
    expect(r.boolN('nul')).toBeNull();
    expect(r.oneOfN('nul', ['a'])).toBeNull();
    expect(r.jsonN('nul', sha256Schema)).toBeNull();
    expect(r.jsonAnyN('nul')).toBeNull();
    expect(() => mapRunEvent({ id: 'evt_x', payload_json: '[1]' })).toThrow(DataCorruptionError);
  });
});

describe('error helpers', () => {
  it('classifies SQLite result codes and passes non-busy errors through', () => {
    const busy = Object.assign(new Error('locked'), { errcode: 5 | (1 << 8) });
    const constraint = Object.assign(new Error('c'), { errcode: 2067 });
    const plain = new Error('plain');

    expect(isSqliteBusy(busy)).toBe(true);
    expect(isSqliteConstraint(constraint)).toBe(true);
    expect(isSqliteBusy(plain)).toBe(false);
    expect(isSqliteBusy({ errcode: 'x' })).toBe(false);
    expect(mapSqliteError(plain)).toBe(plain);
    expect(mapSqliteError(busy)).toMatchObject({ appError: { code: 'DATABASE_UNAVAILABLE', details: { reason: 'database_busy' } } });
  });

  it('quickCheck raises a fatal INTERNAL error with a restore hint when the check fails', () => {
    const fake = { prepare: () => ({ all: () => [{ quick_check: 'row 3 missing' }] }) } as unknown as SqlDriver;

    expect(() => {
      quickCheck(fake);
    }).toThrow(/backup/);
  });

  it('formats backup stamps in UTC', () => {
    expect(backupStamp(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405');
  });
});
