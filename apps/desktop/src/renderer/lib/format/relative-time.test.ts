import { describe, expect, it } from 'vitest';
import { formatRelativeTime, toIsoString } from './relative-time';

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);

describe('formatRelativeTime', () => {
  it('describes past times', () => {
    expect(formatRelativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 3 * 60_000, NOW)).toBe('3 min ago');
    expect(formatRelativeTime(NOW - 60 * 60_000, NOW)).toBe('1 hour ago');
    expect(formatRelativeTime(NOW - 5 * 3_600_000, NOW)).toBe('5 hours ago');
    expect(formatRelativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2 days ago');
  });

  it('describes future times', () => {
    expect(formatRelativeTime(NOW + 5 * 60_000, NOW)).toBe('in 5 min');
  });

  it('falls back to an absolute date after 30 days', () => {
    expect(formatRelativeTime(NOW - 40 * 86_400_000, NOW)).not.toMatch(/ago$/);
  });

  it('produces an ISO string for <time dateTime>', () => {
    expect(toIsoString(NOW)).toBe('2026-09-30T12:00:00.000Z');
  });
});
