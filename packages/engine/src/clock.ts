// Time helpers (00b §2.4: clock and timers are injected; nothing here reads the wall clock).
import { epochMs } from '@relay/contracts';
import type { EpochMs } from '@relay/contracts';
import type { MonotonicClock, Timers, WakeSignal } from './ports.js';

/**
 * The local calendar month containing `now` as `[start, end)` (R4-4 project month).
 * @throws RangeError when `now` is not a valid epoch.
 */
export function monthWindow(now: EpochMs): { start: EpochMs; end: EpochMs } {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return { start: epochMs(start), end: epochMs(end) };
}

/** `[start, end)` of a `YYYY-MM` month in local time. */
export function monthWindowOf(month: string): { start: EpochMs; end: EpochMs } {
  const [y, m] = month.split('-').map(Number);
  const year = y ?? 1970;
  const index = (m ?? 1) - 1;
  return { start: epochMs(new Date(year, index, 1).getTime()), end: epochMs(new Date(year, index + 1, 1).getTime()) };
}

/** The process timers (composition roots only). */
export const globalTimers: Timers = Object.freeze({
  setTimeout: (cb: () => void, ms: number): unknown => globalThis.setTimeout(cb, ms),
  clearTimeout: (h: unknown): void => {
    globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>);
  },
  setInterval: (cb: () => void, ms: number): unknown => globalThis.setInterval(cb, ms),
  clearInterval: (h: unknown): void => {
    globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>);
  },
});

/**
 * The process monotonic clock (composition roots only): `performance.now()` (libuv hrtime — on macOS it does not
 * advance while the Mac sleeps, and it never jumps with wall-clock changes).
 */
export const systemMonotonic: MonotonicClock = Object.freeze({ now: (): number => performance.now() });

/**
 * Creates the loop's wake-up signal. `wait(ms)` resolves after `ms` on the injected timers or as soon as `signal()`
 * is called. A signal that arrives while nobody waits is remembered, so a wake-up is never lost.
 */
export function createWakeSignal(timers: Timers): WakeSignal {
  let pending = false;
  let waiter: (() => void) | null = null;
  return {
    signal() {
      if (waiter === null) {
        pending = true;
        return;
      }
      const w = waiter;
      waiter = null;
      w();
    },
    wait(ms) {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const handle = timers.setTimeout(() => {
          waiter = null;
          resolve();
        }, Math.max(0, ms));
        waiter = () => {
          timers.clearTimeout(handle);
          resolve();
        };
      });
    },
  };
}
