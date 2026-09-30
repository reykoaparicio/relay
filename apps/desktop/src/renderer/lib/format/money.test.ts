import { describe, expect, it } from 'vitest';
import { usd } from '@relay/contracts';
import type { Microusd } from '@relay/contracts';
import { formatMoney } from './money';

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

  it('labels estimated and unknown amounts in the visible text', () => {
    expect(formatMoney(m(480_000), 'estimated')).toBe('≈ $0.48 est.');
    expect(formatMoney(m(480_000), 'unknown')).toBe('$0.48 unknown');
    expect(formatMoney(m(480_000), 'reported')).toBe('$0.48');
    expect(formatMoney(m(480_000), 'calculated')).toBe('$0.48');
  });
});
