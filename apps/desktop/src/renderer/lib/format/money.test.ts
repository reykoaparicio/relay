import { describe, expect, it } from 'vitest';
import { usd } from '@relay/contracts';
import type { Microusd } from '@relay/contracts';
import { costHasEstimates, estimatedPart, formatMoney, formatMoneyApprox, formatMoneyPair, formatSumPart, formatUsdAtPrecision, isEstimate, moneyColumnPrecision, sumConsistentPrecision, trackedTotal } from './money';

const m = (n: number) => n as Microusd;

describe('formatMoney', () => {
  it('formats zero as $0.00', () => {
    expect(formatMoney(m(0))).toBe('$0.00');
  });

  it('never shows a non-zero amount as $0.00 (1 µUSD reads "< $0.0001")', () => {
    expect(formatMoney(m(1))).toBe('< $0.0001');
    expect(formatMoney(m(99))).toBe('< $0.0001');
  });

  it('uses 4 decimals below one cent', () => {
    expect(formatMoney(m(4_200))).toBe('$0.0042');
    expect(formatMoney(m(100))).toBe('$0.0001');
  });

  it('uses 2 decimals from one cent up (480000 µUSD → $0.48)', () => {
    expect(formatMoney(m(480_000))).toBe('$0.48');
    expect(formatMoney(usd('3.00'))).toBe('$3.00');
    expect(formatMoney(usd('1234.5'))).toBe('$1,234.50');
  });

  it('formats a negative overrun with a leading minus', () => {
    expect(formatMoney(m(-120_000))).toBe('-$0.12');
    expect(formatMoney(m(-4_200))).toBe('-$0.0042');
  });

  it('keeps the inequality true for tiny negative amounts (-50 µUSD reads "> -$0.0001")', () => {
    expect(formatMoney(m(-50))).toBe('> -$0.0001');
    expect(formatMoney(m(-1))).toBe('> -$0.0001');
    expect(formatMoney(m(-100))).toBe('-$0.0001');
  });

  it('switches to 2 decimals when 4-dp rounding reaches one cent (9_999 µUSD → $0.01)', () => {
    expect(formatMoney(m(9_999))).toBe('$0.01');
    expect(formatMoney(m(9_950))).toBe('$0.01');
    expect(formatMoney(m(9_949))).toBe('$0.0099');
    expect(formatMoney(m(-9_999))).toBe('-$0.01');
  });

  it('labels estimated amounts "~$0.48 (estimated)" and never shows "unknown" (decision 1)', () => {
    expect(formatMoney(m(480_000), 'estimated')).toBe('~$0.48 (estimated)');
    // A legacy not-confirmed amount is an estimate too.
    expect(formatMoney(m(480_000), 'unknown')).toBe('~$0.48 (estimated)');
    expect(formatMoney(m(30_000), 'estimated')).toBe('~$0.03 (estimated)');
    expect(formatMoney(m(480_000), 'reported')).toBe('$0.48');
    expect(formatMoney(m(480_000), 'calculated')).toBe('$0.48');
  });
});

describe('formatMoneyPair', () => {
  it('uses the normal display when the two amounts already read differently', () => {
    expect(formatMoneyPair(m(3_100_000), m(3_000_000))).toEqual(['$3.10', '$3.00']);
  });

  it('adds decimals until different amounts read differently (3_004_000 vs 3_000_000)', () => {
    expect(formatMoneyPair(m(3_004_000), m(3_000_000))).toEqual(['$3.004', '$3.000']);
    expect(formatMoneyPair(m(3_000_001), m(3_000_000))).toEqual(['$3.000001', '$3.000000']);
  });

  it('keeps equal amounts at the normal display', () => {
    expect(formatMoneyPair(m(3_000_000), m(3_000_000))).toEqual(['$3.00', '$3.00']);
  });
});

describe('formatUsdAtPrecision', () => {
  it('rounds half away from zero with thousands grouping and a sign', () => {
    expect(formatUsdAtPrecision(m(1_234_567_891), 3)).toBe('$1,234.568');
    expect(formatUsdAtPrecision(m(-4_200), 6)).toBe('-$0.004200');
    expect(formatUsdAtPrecision(m(-1), 2)).toBe('$0.00');
  });
});

describe('moneyColumnPrecision (one rule per column)', () => {
  it('uses 4 dp for the whole column when any amount is sub-cent', () => {
    const values = [m(4_200), m(20_000), m(0)];
    const p = moneyColumnPrecision(values);
    expect(p).toBe(4);
    expect(values.map((v) => formatMoney(v, null, { precision: p }))).toEqual(['$0.0042', '$0.0200', '$0.0000']);
  });

  it('uses 2 dp when every amount is zero or at least a cent', () => {
    expect(moneyColumnPrecision([m(0), m(20_000), m(3_000_000)])).toBe(2);
    expect(moneyColumnPrecision([])).toBe(2);
    // 9_950 µUSD reads "$0.01" (it rounds to a cent), so it does not force 4 dp.
    expect(moneyColumnPrecision([m(9_950)])).toBe(2);
  });

  it('keeps the true inequality for amounts below $0.0001 and the certainty text at 4 dp', () => {
    expect(formatMoney(m(50), null, { precision: 4 })).toBe('< $0.0001');
    expect(formatMoney(m(4_200), 'estimated', { precision: 4 })).toBe('~$0.0042 (estimated)');
    expect(formatMoney(m(-20_000), null, { precision: 4 })).toBe('-$0.0200');
  });
});

describe('sumConsistentPrecision', () => {
  it('keeps 2 dp when the rounded parts add up', () => {
    expect(sumConsistentPrecision([60_000, 440_000], 500_000)).toBe(2);
  });

  it('adds decimals until reserved + over = actual on screen ($0.055 + $0.445 ≠ $0.50 at 2 dp)', () => {
    const digits = sumConsistentPrecision([55_000, 445_000], 500_000);
    expect(digits).toBe(3);
    expect([55_000, 445_000, 500_000].map((v) => formatUsdAtPrecision(m(v), digits))).toEqual(['$0.055', '$0.445', '$0.500']);
  });

  it('a tiny overrun never reads as $0.00 over, nor as actual equal to reserved (500,000 reserved, 500,030 actual)', () => {
    const digits = sumConsistentPrecision([500_000, 30], 500_030);
    expect(digits).toBe(5);
    expect([500_000, 30, 500_030].map((v) => formatSumPart(v, digits))).toEqual(['$0.50000', '$0.00003', '$0.50003']);
    // 1 µUSD over needs the 6 dp cap.
    const one = sumConsistentPrecision([500_000, 1], 500_001);
    expect(one).toBe(6);
    expect(formatSumPart(1, one)).toBe('$0.000001');
    // Below what 6 dp can show (a fractional µUSD): an inequality, never "$0.000000".
    expect(formatSumPart(0.4, 6)).toBe('< $0.000001');
    expect(formatSumPart(-0.4, 6)).toBe('> -$0.000001');
    expect(formatSumPart(0, 2)).toBe('$0.00');
  });
});

describe('estimates (decision 1: "~", never "unknown")', () => {
  const parts = { settledReported: 400_000, settledCalculated: 0, settledEstimated: 0, unknown: 0, hasEstimates: false };

  it('formatMoneyApprox prefixes "~" only for a total that includes an estimate', () => {
    expect(formatMoneyApprox(m(480_000), true)).toBe('~$0.48');
    expect(formatMoneyApprox(m(480_000), false)).toBe('$0.48');
    expect(formatMoneyApprox(m(4_200), true)).toBe('~$0.0042');
  });

  it('isEstimate covers estimated and the legacy not-confirmed certainty', () => {
    expect(isEstimate('estimated')).toBe(true);
    expect(isEstimate('unknown')).toBe(true);
    expect(isEstimate('reported')).toBe(false);
    expect(isEstimate(null)).toBe(false);
  });

  it('costHasEstimates follows hasEstimates, an estimated part, or a legacy amount', () => {
    expect(costHasEstimates(parts)).toBe(false);
    expect(costHasEstimates({ ...parts, hasEstimates: true })).toBe(true);
    expect(costHasEstimates({ ...parts, settledEstimated: 1 })).toBe(true);
    expect(costHasEstimates({ ...parts, unknown: 1 })).toBe(true);
  });

  it('trackedTotal and estimatedPart count a legacy not-confirmed amount as an estimate', () => {
    const legacy = { ...parts, settledEstimated: 100_000, unknown: 620_000 };
    expect(trackedTotal(legacy)).toBe(1_120_000);
    expect(estimatedPart(legacy)).toBe(720_000);
  });

  it('no formatter ever writes "unknown"', () => {
    for (const c of ['reported', 'calculated', 'estimated', 'unknown'] as const) {
      expect(formatMoney(m(620_000), c)).not.toMatch(/unknown/i);
    }
  });
});
