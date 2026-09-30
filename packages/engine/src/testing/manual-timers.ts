// R4-36: fake time applies ONLY to the injected timers and clock (never global fake timers).
import { epochMs } from '@relay/contracts';
import type { Clock, EpochMs } from '@relay/contracts';
import type { Timers } from '../ports.js';

/** A settable clock. */
export interface ManualClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

/** Creates a manual clock starting at `start` (2026-09-30T12:00:00Z by default). */
export function createManualClock(start = Date.UTC(2026, 8, 30, 12)): ManualClock {
  let t = start;
  return {
    now: (): EpochMs => epochMs(t),
    set(ms) {
      t = ms;
    },
    advance(ms) {
      t += ms;
    },
  };
}

/** Manual timers driven by `advance(ms)` (which also advances the paired clock, when given). */
export interface ManualTimers extends Timers {
  advance(ms: number): void;
  pending(): number;
}

interface Entry {
  id: number;
  at: number;
  cb: () => void;
  every: number | null;
}

/** Creates manual timers. Callbacks run synchronously inside `advance`, in due order. */
export function createManualTimers(clock?: ManualClock): ManualTimers {
  let now = clock?.now() ?? 0;
  let seq = 0;
  const entries = new Map<number, Entry>();
  const add = (cb: () => void, ms: number, every: number | null): number => {
    seq += 1;
    entries.set(seq, { id: seq, at: now + Math.max(0, ms), cb, every });
    return seq;
  };
  const clear = (h: unknown): void => {
    if (typeof h === 'number') entries.delete(h);
  };
  return {
    setTimeout: (cb, ms) => add(cb, ms, null),
    clearTimeout: clear,
    setInterval: (cb, ms) => add(cb, ms, Math.max(1, ms)),
    clearInterval: clear,
    pending: () => entries.size,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...entries.values()].filter((e) => e.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (due === undefined) break;
        now = due.at;
        clock?.set(now);
        if (due.every === null) entries.delete(due.id);
        else due.at += due.every;
        due.cb();
      }
      now = target;
      clock?.set(now);
    },
  };
}
