import { describe, expect, it } from 'vitest';
import { dateInputValue, formatDate, formatMonth, parseDateInput } from './date';

describe('date input helpers', () => {
  it('round-trips a calendar date through the input value', () => {
    const at = parseDateInput('2026-09-27');

    expect(typeof at).toBe('number');
    expect(dateInputValue(at ?? null)).toBe('2026-09-27');
  });

  it('maps empty to null and rejects malformed or impossible dates', () => {
    expect(parseDateInput('  ')).toBeNull();
    expect(parseDateInput('27/09/2026')).toBeUndefined();
    expect(parseDateInput('2026-02-30')).toBeUndefined();
    expect(dateInputValue(null)).toBe('');
  });
});

describe('formatDate / formatMonth', () => {
  const sept = new Date(2026, 8, 27, 12).getTime();

  it('formats in the requested locale', () => {
    expect(formatDate(sept, 'en-US')).toBe('Sep 27, 2026');
    expect(formatMonth(sept, 'en-US')).toBe('September');
    expect(formatMonth(sept, 'en-US', { withYear: true })).toBe('September 2026');
    expect(formatMonth(sept, 'de-DE')).toBe('September');
    expect(formatMonth(new Date(2026, 4, 1).getTime(), 'fr-FR')).toBe('mai');
  });

  it('uses the default locale when none is given (no hard-coded en-US)', () => {
    const expected = new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date(sept));

    expect(formatMonth(sept)).toBe(expected);
  });
});
