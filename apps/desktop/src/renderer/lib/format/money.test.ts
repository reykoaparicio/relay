import { describe, expect, it } from 'vitest';
import { usd } from '@relay/contracts';
import type { Microusd } from '@relay/contracts';
import { formatMoney, formatMoneyPair, formatUsdAtPrecision } from './money';

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

  it('labels estimated and unknown amounts in the visible text', () => {
    expect(formatMoney(m(480_000), 'estimated')).toBe('≈ $0.48 est.');
    expect(formatMoney(m(480_000), 'unknown')).toBe('$0.48 unknown');
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
