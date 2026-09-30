import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit.js';

describe('token bucket', () => {
  it('allows capacity requests, then refuses with retryAfterMs, then refills over time', () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    const limit = { capacity: 2, refillPerSec: 1 / 5 };

    const a = limiter.take('c', limit);
    const b = limiter.take('c', limit);
    const c = limiter.take('c', limit);

    expect(a.ok && b.ok).toBe(true);
    expect(c).toEqual({ ok: false, retryAfterMs: 5000 });
    now = 2500;
    expect(limiter.take('c', limit)).toEqual({ ok: false, retryAfterMs: 2500 });
    now = 5000;
    expect(limiter.take('c', limit).ok).toBe(true);
  });

  it('keeps buckets per channel and never exceeds capacity', () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    const limit = { capacity: 1, refillPerSec: 1 };
    limiter.take('a', limit);

    expect(limiter.take('b', limit).ok).toBe(true);
    now = 100_000;
    expect(limiter.take('a', limit).ok).toBe(true);
    expect(limiter.take('a', limit).ok).toBe(false);
  });
});
