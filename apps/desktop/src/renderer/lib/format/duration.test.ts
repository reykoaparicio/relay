import { describe, expect, it } from 'vitest';
import { formatDuration } from './duration';

describe('formatDuration', () => {
  it('formats sub-second, seconds, minutes, and hours', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(12_900)).toBe('12s');
    expect(formatDuration(72_000)).toBe('1m 12s');
    expect(formatDuration(3_900_000)).toBe('1h 05m');
  });

  it('renders invalid input as a dash', () => {
    expect(formatDuration(-5)).toBe('–');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('–');
  });
});
