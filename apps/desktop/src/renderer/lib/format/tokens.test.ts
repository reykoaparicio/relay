import { describe, expect, it } from 'vitest';
import { formatTokens, formatTokensExact } from './tokens';

describe('formatTokens', () => {
  it('keeps small counts exact', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(950)).toBe('950');
  });

  it('compacts thousands and millions with one decimal', () => {
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(4_000)).toBe('4k');
    expect(formatTokens(999_990)).toBe('1M');
    expect(formatTokens(1_250_000)).toBe('1.3M');
  });

  it('renders invalid input as a dash instead of NaN', () => {
    expect(formatTokens(-1)).toBe('–');
    expect(formatTokens(Number.NaN)).toBe('–');
  });

  it('formats exact counts with grouping', () => {
    expect(formatTokensExact(12_400)).toBe('12,400');
  });
});
