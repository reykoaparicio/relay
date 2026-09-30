const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Durations: "850 ms", "12s", "1m 12s", "1h 05m". Negative/non-finite input renders "–". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  if (ms < SECOND) return `${String(Math.round(ms))} ms`;
  if (ms < MINUTE) return `${String(Math.floor(ms / SECOND))}s`;
  if (ms < HOUR) {
    const minutes = Math.floor(ms / MINUTE);
    const seconds = Math.floor((ms % MINUTE) / SECOND);
    return `${String(minutes)}m ${String(seconds)}s`;
  }
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  return `${String(hours)}h ${String(minutes).padStart(2, '0')}m`;
}
