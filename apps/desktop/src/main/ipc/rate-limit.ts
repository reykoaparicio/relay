// 02 §B6 / 08 H4: in-memory token bucket per channel.
import type { RateLimit } from '@relay/contracts';

/** Outcome of one `take`. */
export type TakeResult = { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number };

/** Per-channel token buckets. */
export interface RateLimiter {
  take(channel: string, limit: RateLimit): TakeResult;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Creates a limiter over the injected monotonic clock (ms). */
export function createRateLimiter(now: () => number): RateLimiter {
  const buckets = new Map<string, Bucket>();
  return {
    take(channel, limit) {
      const t = now();
      const b = buckets.get(channel) ?? { tokens: limit.capacity, updatedAt: t };
      const refilled = Math.min(limit.capacity, b.tokens + ((t - b.updatedAt) / 1000) * limit.refillPerSec);
      if (refilled >= 1) {
        buckets.set(channel, { tokens: refilled - 1, updatedAt: t });
        return { ok: true };
      }
      buckets.set(channel, { tokens: refilled, updatedAt: t });
      return { ok: false, retryAfterMs: Math.ceil(((1 - refilled) / limit.refillPerSec) * 1000) };
    },
  };
}
