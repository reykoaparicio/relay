const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const JUST_NOW_MS = 45_000;
const MAX_RELATIVE_DAYS = 30;

function plural(n: number, unit: string): string {
  return `${String(n)} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * Relative time for lists: "just now", "3 min ago", "2 hours ago", "in 5 min".
 * Older than 30 days falls back to the absolute date. Callers render the absolute time in
 * `<time dateTime>` next to it (the `RelativeTime` component does this).
 */
export function formatRelativeTime(epochMs: number, now: number): string {
  const delta = now - epochMs;
  const abs = Math.abs(delta);
  if (abs < JUST_NOW_MS) return 'just now';
  let text: string;
  if (abs < HOUR) text = `${String(Math.max(1, Math.round(abs / MINUTE)))} min`;
  else if (abs < DAY) text = plural(Math.round(abs / HOUR), 'hour');
  else if (abs < MAX_RELATIVE_DAYS * DAY) text = plural(Math.round(abs / DAY), 'day');
  else return formatAbsoluteTime(epochMs);
  return delta >= 0 ? `${text} ago` : `in ${text}`;
}

/** Absolute local time with the user's locale and timezone (00b §4: stored as UTC epoch ms). */
export function formatAbsoluteTime(epochMs: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(epochMs));
}

/** ISO string for `<time dateTime>`. */
export function toIsoString(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
