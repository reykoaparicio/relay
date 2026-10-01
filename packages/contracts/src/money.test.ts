import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addMicrousd,
  formatUsd,
  microusd,
  microusdSchema,
  mulDivCeil,
  nonNegativeMicrousdSchema,
  subMicrousd,
  usd,
} from './money.js';

describe('usd', () => {
  it('parses decimal strings exactly into integer micro-USD', () => {
    expect(usd('0.000001')).toBe(1);
    expect(usd('3.00')).toBe(3_000_000);
    expect(usd('3')).toBe(3_000_000);
    expect(usd('0.48')).toBe(480_000);
    expect(usd('-1.5')).toBe(-1_500_000);
  });

  it('rejects more than 6 decimals and non-numeric text', () => {
    expect(() => usd('1.0000001')).toThrow(RangeError);
    expect(() => usd('abc' as `${number}`)).toThrow(RangeError);
    expect(() => usd('1e3')).toThrow(RangeError);
  });

  it('rejects amounts outside the safe integer range', () => {
    expect(() => usd('9007199254.740992')).toThrow(RangeError);
  });
});

describe('money schemas', () => {
  it('accepts negative amounts in microusdSchema but not in the non-negative schema', () => {
    expect(microusdSchema.parse(-5)).toBe(-5);

    const result = nonNegativeMicrousdSchema.safeParse(-1);

    expect(result.success).toBe(false);
  });

  it('rejects floats and unsafe integers', () => {
    expect(microusdSchema.safeParse(1.5).success).toBe(false);
    expect(microusdSchema.safeParse(2 ** 53).success).toBe(false);
    expect(nonNegativeMicrousdSchema.parse(0)).toBe(0);
  });
});

describe('mulDivCeil', () => {
  it('charges 4 µUSD for 1 token at $4/MTok', () => {
    expect(mulDivCeil(1, 4_000_000)).toBe(4);
  });

  it('rounds up, never to nearest', () => {
    expect(mulDivCeil(1, 1)).toBe(1); // 0.000001 → 1
    expect(mulDivCeil(1_000_001, 1)).toBe(2); // 1.000001 → 2
    expect(mulDivCeil(0, 20_000_000)).toBe(0);
    expect(mulDivCeil(1_000_000, 3)).toBe(3);
  });

  it('rejects negative, fractional, or unsafe inputs', () => {
    expect(() => mulDivCeil(-1, 1)).toThrow(RangeError);
    expect(() => mulDivCeil(1.5, 1)).toThrow(RangeError);
    expect(() => mulDivCeil(1, -1)).toThrow(RangeError);
    expect(() => mulDivCeil(1, 0.5)).toThrow(RangeError);
    expect(() => mulDivCeil(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });

  it('matches an exact BigInt ceil model for 10k random cases', () => {
    const model = (t: bigint, p: bigint): bigint => {
      const q = (t * p) / 1_000_000n;
      return (t * p) % 1_000_000n === 0n ? q : q + 1n;
    };

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 200_000_000 }),
        (t, p) => {
          expect(BigInt(mulDivCeil(t, p))).toBe(model(BigInt(t), BigInt(p)));
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it('is never below the exact real-valued cost (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 100_000_000 }),
        (t, p) => {
          const cost = mulDivCeil(t, p);

          expect(cost * 1_000_000).toBeGreaterThanOrEqual(t * p);
          expect((cost - 1) * 1_000_000).toBeLessThan(t * p);
        },
      ),
    );
  });
});

describe('addMicrousd / subMicrousd', () => {
  it('adds and subtracts exactly', () => {
    expect(addMicrousd(microusd(1), microusd(2), microusd(3))).toBe(6);
    expect(addMicrousd()).toBe(microusd(0));
    expect(subMicrousd(microusd(1), microusd(3))).toBe(-2);
  });

  it('throws on an unsafe sum', () => {
    expect(() => addMicrousd(microusd(Number.MAX_SAFE_INTEGER), microusd(1))).toThrow(RangeError);
    expect(() => subMicrousd(microusd(Number.MIN_SAFE_INTEGER), microusd(1))).toThrow(RangeError);
  });

  it('microusd() rejects non-integers', () => {
    expect(() => microusd(0.1)).toThrow(RangeError);
  });

  it('sums are associative and commutative (property)', () => {
    const amt = fc.integer({ min: -1e12, max: 1e12 }).map(microusd);

    fc.assert(
      fc.property(amt, amt, amt, (a, b, c) => {
        expect(addMicrousd(a, addMicrousd(b, c))).toBe(addMicrousd(addMicrousd(a, b), c));
        expect(addMicrousd(a, b)).toBe(addMicrousd(b, a));
        expect(subMicrousd(addMicrousd(a, b), b)).toBe(a);
      }),
    );
  });
});

describe('formatUsd', () => {
  it('formats with 2 decimals by default and 4 on request', () => {
    expect(formatUsd(microusd(480_000))).toBe('$0.48');
    expect(formatUsd(microusd(1_234_560_000))).toBe('$1,234.56');
    expect(formatUsd(microusd(4), { precision: 4 })).toBe('$0.0000');
    expect(formatUsd(microusd(123_456), { precision: 4 })).toBe('$0.1235');
  });

  it('rounds half away from zero and signs negatives', () => {
    expect(formatUsd(microusd(5_000))).toBe('$0.01');
    expect(formatUsd(microusd(-1_500_000))).toBe('-$1.50');
    expect(formatUsd(microusd(-1))).toBe('$0.00');
  });
});
