import { useEffect, useState } from 'react';

/** Tick for durations of running work (1 s). */
export const NOW_RUNNING_INTERVAL_MS = 1_000;
/** Tick for relative times and month labels (60 s). */
export const NOW_IDLE_INTERVAL_MS = 60_000;

/**
 * The current time, re-read every `intervalMs` and whenever `refreshKey` changes (pass the query's `dataUpdatedAt`
 * so a refetch never renders fresh data against a stale clock). Shared by every page that shows elapsed or relative
 * times, so nothing is frozen at mount.
 */
export function useNow(intervalMs: number, refreshKey?: unknown): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
    };
    // Re-read right away when the interval or the refresh key changed (e.g. data was refetched), then keep ticking.
    const refresh = setTimeout(tick, 0);
    const id = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(refresh);
      clearInterval(id);
    };
  }, [intervalMs, refreshKey]);
  return now;
}
