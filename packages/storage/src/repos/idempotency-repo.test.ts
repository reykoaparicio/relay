import { epochMs, isRelayError } from '@relay/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FixtureDb } from '../testing/fixtures.js';
import { openFixtureDb } from '../testing/fixtures.js';

describe('IdempotencyRepo', () => {
  let f: FixtureDb;

  beforeEach(async () => {
    f = await openFixtureDb();
  });
  afterEach(async () => {
    await f.db.dispose();
  });

  it('returns the stored small result for the same key and hash', () => {
    const repo = f.db.repos.idempotency;
    const result = { ids: { runId: 'run_x' }, status: 'queued' };

    const first = repo.put('runs.start', 'k1', 'h1', result);
    const replay = repo.put('runs.start', 'k1', 'h1', { ids: { runId: 'other' } });

    expect(first).toEqual({ ok: true, value: result });
    expect(replay).toEqual({ ok: true, value: result });
    expect(repo.get('runs.start', 'k1')?.requestHash).toBe('h1');
    expect(repo.get('runs.start', 'missing')).toBeUndefined();
  });

  it('returns CONFLICT for the same key with a different payload hash', () => {
    const repo = f.db.repos.idempotency;
    repo.put('runs.start', 'k1', 'h1', { ids: {} });

    const r = repo.put('runs.start', 'k1', 'h2', { ids: {} });

    expect(!r.ok && r.error.code).toBe('CONFLICT');
  });

  it('rejects a result over 2048 bytes', () => {
    const big = { ids: { blob: 'x'.repeat(2100) } };

    const attempt = () => f.db.repos.idempotency.put('op', 'k', 'h', big);

    expect(attempt).toThrow();
    try {
      attempt();
    } catch (e) {
      expect(isRelayError(e) && e.appError.code).toBe('VALIDATION_FAILED');
    }
  });

  it('sweep removes rows older than the TTL', () => {
    const repo = f.db.repos.idempotency;
    f.clock.set(1000);
    repo.put('op', 'old', 'h', { ids: {} });
    f.clock.set(5000);
    repo.put('op', 'new', 'h', { ids: {} });

    const removed = repo.sweep(epochMs(2000));

    expect(removed).toBe(1);
    expect(repo.get('op', 'old')).toBeUndefined();
    expect(repo.get('op', 'new')).toBeDefined();
  });
});
