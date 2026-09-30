import { describe, expect, it } from 'vitest';
import { createIdGen, ID_PREFIX, idPattern, idSchema, isIdOf, ULID_PATTERN } from './ids.js';
import type { EpochMs } from './time.js';

const fixedRandom = (byte: number) => (n: number) => new Uint8Array(n).fill(byte);

function clockAt(...times: number[]) {
  let i = 0;
  return { now: () => (times[Math.min(i++, times.length - 1)] ?? 0) as EpochMs };
}

describe('ID_PREFIX', () => {
  it('has unique 3-char values', () => {
    const values = Object.values(ID_PREFIX);

    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v).toMatch(/^[a-z]{3}$/);
  });
});

describe('idSchema', () => {
  it('round-trips a generated id for every prefix', () => {
    const gen = createIdGen(clockAt(1_700_000_000_000), fixedRandom(7));

    for (const key of Object.keys(ID_PREFIX) as (keyof typeof ID_PREFIX)[]) {
      const id = gen.next(key);

      expect(id.startsWith(`${ID_PREFIX[key]}_`)).toBe(true);
      expect(idSchema(key).parse(id)).toBe(id);
      expect(isIdOf(key, id)).toBe(true);
    }
  });

  it("rejects a prj_ id for idSchema('run') and accepts stp_ for stepRun", () => {
    const body = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';

    expect(idSchema('run').safeParse(`prj_${body}`).success).toBe(false);
    expect(idSchema('stepRun').safeParse(`stp_${body}`).success).toBe(true);
    expect(idSchema('run').safeParse(`run_${body.toLowerCase()}`).success).toBe(false);
    expect(idSchema('run').safeParse(`run_${body}I`).success).toBe(false);
    expect(isIdOf('run', 42)).toBe(false);
  });

  it('rejects a ULID whose first char exceeds 7 (timestamp above 2^48 - 1) (B14)', () => {
    const tail = '1J9ZZZZZZZZZZZZZZZZZZZZZZ';

    expect(idSchema('run').safeParse(`run_7${tail}`).success).toBe(true);
    for (const first of ['8', '9', 'A', 'Z']) {
      expect(idSchema('run').safeParse(`run_${first}${tail}`).success).toBe(false);
    }
  });

  it('exposes the ULID body pattern', () => {
    expect(idPattern('run').source).toContain(ULID_PATTERN);
  });
});

describe('createIdGen', () => {
  it('encodes the timestamp in the first 10 chars (sortable across ms)', () => {
    const gen = createIdGen(clockAt(1, 2), fixedRandom(255));

    const a = gen.next('run');
    const b = gen.next('run');

    expect(a.slice(4, 14)).toBe('0000000001');
    expect(b.slice(4, 14)).toBe('0000000002');
    expect(a < b).toBe(true);
  });

  it('is monotonic within the same millisecond and when the clock goes backwards', () => {
    const gen = createIdGen(clockAt(1000, 1000, 1000, 999), fixedRandom(0));

    const ids = [gen.next('event'), gen.next('event'), gen.next('event'), gen.next('event')];

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(4);
    expect(ids[1]?.endsWith('0000000000000001')).toBe(true);
  });

  it('throws when the random part overflows within one millisecond', () => {
    const gen = createIdGen(clockAt(5, 5), fixedRandom(255));

    gen.next('run');

    expect(() => gen.next('run')).toThrow(RangeError);
  });

  it('rejects an out-of-range clock and a wrong-length random source', () => {
    expect(() => createIdGen(clockAt(-1), fixedRandom(0)).next('run')).toThrow(RangeError);
    expect(() => createIdGen(clockAt(2 ** 48), fixedRandom(0)).next('run')).toThrow(RangeError);
    expect(() => createIdGen(clockAt(1), () => new Uint8Array(3)).next('run')).toThrow(RangeError);
  });
});
