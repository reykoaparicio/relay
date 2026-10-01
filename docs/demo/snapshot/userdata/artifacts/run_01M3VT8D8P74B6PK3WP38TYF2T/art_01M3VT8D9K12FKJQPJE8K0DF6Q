import leftPad from 'left-pad';

/**
 * Elapsed time between two epoch-millisecond timestamps.
 *
 * @returns the elapsed time in milliseconds
 */
export function elapsed(startMs: number, endMs: number): number {
  return Math.floor((endMs - startMs) / 1000);
}

/** Formats integer cents as a fixed two-decimal string, e.g. 1999 -> "19.99". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = leftPad(String(abs % 100), 2, '0');
  return `${sign}${whole}.${fraction}`;
}

/** ISO-8601 timestamp in UTC for API payloads. */
export function isoTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
