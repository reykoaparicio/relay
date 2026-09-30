import type { Brand } from './brand.js';

/** Milliseconds since the Unix epoch, UTC (00b §4: timestamps are INTEGER epoch ms). */
export type EpochMs = Brand<number, 'EpochMs'>;

/** Injected clock (00b §2.4: clock and randomness are injected so tests are deterministic). */
export interface Clock {
  now(): EpochMs;
}

/**
 * Brands a number as {@link EpochMs}.
 * @throws RangeError when `n` is not a non-negative safe integer.
 */
export function epochMs(n: number): EpochMs {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`not a valid epoch ms value: ${String(n)}`);
  }
  return n as EpochMs;
}

/** Wall-clock implementation of {@link Clock}. Only composition roots use it; everything else receives a `Clock`. */
export const systemClock: Clock = Object.freeze({ now: (): EpochMs => epochMs(Date.now()) });
