// Calendar-date helpers for `<input type="date">` and date-only labels (00b §4: stored as UTC epoch ms, shown in the
// user's locale and timezone).

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date `YYYY-MM-DD` (the `<input type="date">` value); null → ''. */
export function dateInputValue(epochMs: number | null): string {
  if (epochMs === null) return '';
  const d = new Date(epochMs);
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYY-MM-DD` → local noon of that day (epoch ms), '' → null, anything else → undefined (invalid). */
export function parseDateInput(text: string): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m === null) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  return Number.isNaN(d.getTime()) || d.getDate() !== Number(m[3]) ? undefined : d.getTime();
}

// Intl formatters are costly to build; cache one per (kind, locale). '' = the user's default locale.
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(kind: 'date' | 'month' | 'monthYear', locale: string | undefined): Intl.DateTimeFormat {
  const key = `${kind}|${locale ?? ''}`;
  let f = FORMATTERS.get(key);
  if (f === undefined) {
    const options: Intl.DateTimeFormatOptions =
      kind === 'date' ? { dateStyle: 'medium' } : kind === 'month' ? { month: 'long' } : { month: 'long', year: 'numeric' };
    f = new Intl.DateTimeFormat(locale, options);
    FORMATTERS.set(key, f);
  }
  return f;
}

/** "Sep 27, 2026" (locale date only). */
export function formatDate(epochMs: number, locale?: string): string {
  return formatter('date', locale).format(new Date(epochMs));
}

export interface FormatMonthOptions {
  /** "September 2026" instead of "September". */
  readonly withYear?: boolean;
}

/** The month of `epochMs` in the user's locale: "September" (or "September 2026" with `withYear`). */
export function formatMonth(epochMs: number, locale?: string, { withYear = false }: FormatMonthOptions = {}): string {
  return formatter(withYear ? 'monthYear' : 'month', locale).format(new Date(epochMs));
}
