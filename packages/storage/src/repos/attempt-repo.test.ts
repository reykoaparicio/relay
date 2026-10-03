import { epochMs } from '@relay/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FixtureDb } from '../testing/fixtures.js';
import { newId, openFixtureDb, seedAttempt, seedProject, seedRun, seedStep } from '../testing/fixtures.js';

describe('AttemptRepo', () => {
  let f: FixtureDb;

  beforeEach(async () => {
    f = await openFixtureDb();
  });
  afterEach(async () => {
    await f.db.dispose();
  });

  const setup = () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const step = seedStep(f.db, f.clock, run.id);
    return { run, step, attempt: seedAttempt(f.db, f.clock, run.id, step.id) };
  };

  it('setProviderIds fills each column once and never overwrites', () => {
    const { attempt } = setup();
    const repo = f.db.repos.attempts;

    repo.setProviderIds(attempt.id, { responseId: 'resp_1' });
    repo.setProviderIds(attempt.id, { responseId: 'resp_2' });
    const mid = repo.get(attempt.id);
    repo.setProviderIds(attempt.id, { requestId: 'req_1', responseId: 'resp_3' });
    const end = repo.get(attempt.id);

    expect(mid.providerResponseId).toBe('resp_1');
    expect(mid.providerRequestId).toBeNull();
    expect(end.providerRequestId).toBe('req_1');
    expect(end.providerResponseId).toBe('resp_1');
  });

  it('decision 1: transition sets outcome_uncertain / may_not_have_been_charged; markUncertain; listUncertain; listReconcileCandidates', () => {
    const { run, step, attempt } = setup();
    const repo = f.db.repos.attempts;
    expect([attempt.outcomeUncertain, attempt.mayNotHaveBeenCharged]).toEqual([false, false]);

    repo.transition(attempt.id, ['reserved'], 'dispatching', {});
    repo.transition(attempt.id, ['dispatching'], 'unknown', { outcomeUncertain: true, mayNotHaveBeenCharged: true });
    const other = seedAttempt(f.db, f.clock, run.id, step.id);
    repo.transition(other.id, ['reserved'], 'abandoned', {});
    const legacy = seedAttempt(f.db, f.clock, run.id, step.id);
    repo.transition(legacy.id, ['reserved'], 'abandoned', {});
    expect(repo.markUncertain(legacy.id, false)).toBe(true);
    repo.setProviderIds(legacy.id, { responseId: 'resp_legacy' });

    expect([repo.get(attempt.id).outcomeUncertain, repo.get(attempt.id).mayNotHaveBeenCharged]).toEqual([true, true]);
    expect(repo.listUncertain(run.id).map((a) => [a.id, a.mayNotHaveBeenCharged])).toEqual([[attempt.id, true], [legacy.id, false]]);
    // unknown always; abandoned only when uncertain AND a provider response id exists (only its cost can be corrected)
    expect(repo.listReconcileCandidates().map((a) => a.id)).toEqual([attempt.id, legacy.id]);
    expect(() => f.db.tx('immediate', () => repo.transition(attempt.id, ['unknown'], 'unknown', { outcomeUncertain: false }))).not.toThrow();
    expect(repo.get(attempt.id).outcomeUncertain).toBe(false);
  });

  it('D1-3: markLookupDone takes an abandoned uncertain attempt out of the reconcile candidates (never an unknown one)', () => {
    const { run, step, attempt } = setup();
    const repo = f.db.repos.attempts;
    repo.transition(attempt.id, ['reserved'], 'dispatching', {});
    repo.transition(attempt.id, ['dispatching'], 'unknown', { outcomeUncertain: true });
    const kept = seedAttempt(f.db, f.clock, run.id, step.id);
    repo.transition(kept.id, ['reserved'], 'abandoned', { outcomeUncertain: true, providerResponseId: 'resp_kept' });
    expect(repo.get(kept.id).lookupDone).toBe(false);
    expect(repo.listReconcileCandidates().map((a) => a.id)).toEqual([attempt.id, kept.id]);

    expect(repo.markLookupDone(kept.id)).toBe(true);
    expect(repo.markLookupDone(kept.id)).toBe(false); // already done
    expect(repo.markLookupDone(attempt.id)).toBe(true);

    expect(repo.get(kept.id).lookupDone).toBe(true);
    expect(repo.listReconcileCandidates().map((a) => a.id)).toEqual([attempt.id]); // unknown attempts always qualify
  });

  it('nextSeq increments per step run', () => {
    const { run, step } = setup();
    const other = f.db.repos.steps.insertRetry(step, { id: newId('stepRun'), state: 'ready', createdAt: f.clock.now() });

    const second = f.db.repos.attempts.nextSeq(step.id);
    seedAttempt(f.db, f.clock, run.id, step.id);

    expect(second).toBe(2);
    expect(f.db.repos.attempts.nextSeq(step.id)).toBe(3);
    expect(f.db.repos.attempts.nextSeq(other.id)).toBe(1);
  });

  it('transition is CAS, keeps provider ids write-once, and lists unresolved attempts', () => {
    const { run, step, attempt } = setup();
    const repo = f.db.repos.attempts;

    const lost = repo.transition(attempt.id, ['dispatching'], 'succeeded', {});
    repo.transition(attempt.id, ['reserved'], 'dispatching', { dispatchedAt: epochMs(10), providerResponseId: 'resp_a' });
    const unresolved = repo.listUnresolved(run.id).map((a) => a.id);
    repo.transition(attempt.id, ['dispatching'], 'succeeded', {
      finishedAt: epochMs(20),
      firstByteAt: epochMs(12),
      usage: { uncachedInputTokens: 10, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5 },
      rawUsage: { input_tokens: 10 },
      stopReason: 'end_turn',
      providerRequestId: 'req_a',
      providerResponseId: 'resp_b',
    });
    const done = repo.get(attempt.id);

    expect(lost).toBe(false);
    expect(unresolved).toEqual([attempt.id]);
    expect(done.state).toBe('succeeded');
    expect(done.dispatchedAt).toBe(10);
    expect(done.usage?.outputTokens).toBe(5);
    expect(done.rawUsage).toEqual({ input_tokens: 10 });
    expect(done.providerResponseId).toBe('resp_a');
    expect(done.providerRequestId).toBe('req_a');
    expect(done.estimate).toEqual({ upperAllowanceMicrousd: 1000 });
    expect(repo.listUnresolved()).toEqual([]);
    expect(repo.listForStep(step.id).map((a) => a.seq)).toEqual([1]);
    expect(repo.listForRun(run.id)).toHaveLength(1);
    expect(repo.find(newId('attempt'))).toBeUndefined();
    expect(() => repo.get(newId('attempt'))).toThrow();
    expect(() => repo.transition(attempt.id, [], 'failed', {})).toThrow();
  });
});
