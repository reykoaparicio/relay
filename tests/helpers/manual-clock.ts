/**
 * Manual time for integration tests (11 §K3, 06 §R4-36). Fake time applies ONLY to the injected deps (`clock`, `timers`
 * passed to `createRuntime`); tests never call `vi.useFakeTimers()`, which would also freeze `node:sqlite` busy waits,
 * worker messaging, and Vitest's own timeouts.
 */
import { epochMs } from '@relay/contracts';
import type { Clock, EpochMs } from '@relay/contracts';
import type { Timers } from '@relay/engine';

/** Default start: 2026-09-30T12:00:00Z. */
export const MANUAL_CLOCK_START = Date.UTC(2026, 8, 30, 12);

export interface ManualClock {
  readonly clock: Clock;
  readonly timers: Timers & { pending(): number };
  /** Moves time forward by `ms`, firing due timers in order (each at its own due time). */
  advance(ms: number): void;
  /** Current manual time. */
  now(): EpochMs;
}

interface Entry {
  readonly id: number;
  at: number;
  readonly cb: () => void;
  readonly every: number | null;
}

/** Creates a manual clock + timers pair starting at `startMs`. */
export function createManualClock(startMs: number = MANUAL_CLOCK_START): ManualClock {
  let t = startMs;
  let seq = 0;
  const entries = new Map<number, Entry>();
  const add = (cb: () => void, ms: number, every: number | null): number => {
    seq += 1;
    entries.set(seq, { id: seq, at: t + Math.max(0, ms), cb, every });
    return seq;
  };
  const clear = (h: unknown): void => {
    if (typeof h === 'number') entries.delete(h);
  };
  const clock: Clock = { now: () => epochMs(t) };
  return {
    clock,
    now: () => epochMs(t),
    timers: {
      setTimeout: (cb, ms) => add(cb, ms, null),
      clearTimeout: clear,
      setInterval: (cb, ms) => add(cb, ms, Math.max(1, ms)),
      clearInterval: clear,
      pending: () => entries.size,
    },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...entries.values()].filter((e) => e.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (due === undefined) break;
        t = Math.max(t, due.at);
        if (due.every === null) entries.delete(due.id);
        else due.at += due.every;
        due.cb();
      }
      t = target;
    },
  };
}
