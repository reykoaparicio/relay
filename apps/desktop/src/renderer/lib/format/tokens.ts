const THOUSAND = 1_000;
const MILLION = 1_000_000;

function compact(value: number, unit: number, suffix: string): string {
  const scaled = Math.round((value / unit) * 10) / 10;
  const text = Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1);
  return `${text}${suffix}`;
}

/** Token counts: "950", "12.4k", "1.2M". Negative or non-finite input renders "–" (never NaN). */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '–';
  if (n < THOUSAND) return String(Math.round(n));
  if (n < MILLION) {
    const k = compact(n, THOUSAND, 'k');
    return k === '1000k' ? '1M' : k;
  }
  return compact(n, MILLION, 'M');
}

/** Full count with grouping, for aria-labels and tables where precision matters: "12,400". */
export function formatTokensExact(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}
