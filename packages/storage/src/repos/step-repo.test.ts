import type { StepKey } from '@relay/contracts';
import { epochMs } from '@relay/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FixtureDb } from '../testing/fixtures.js';
import { newId, openFixtureDb, seedProject, seedRun, seedStep } from '../testing/fixtures.js';

describe('StepRepo', () => {
  let f: FixtureDb;

  beforeEach(async () => {
    f = await openFixtureDb();
  });
  afterEach(async () => {
    await f.db.dispose();
  });

  const setup = () => {
    const p = seedProject(f.db, f.clock);
    return seedRun(f.db, f.clock, p.id);
  };

  it('insertRetry creates retry_index + 1 with fresh counters', () => {
    const run = setup();
    const s = seedStep(f.db, f.clock, run.id);
    f.db.repos.steps.transition(s.id, ['ready'], 'failed', { schemaRepairsUsed: 1, transportRetriesUsed: 1, rateLimitWaitsUsed: 2 });
    const failed = f.db.repos.steps.get(s.id);

    const retry = f.db.repos.steps.insertRetry(failed, { id: newId('stepRun'), state: 'ready', createdAt: f.clock.now() });

    expect(failed.schemaRepairsUsed).toBe(1);
    expect(retry.retryIndex).toBe(1);
    expect(retry.revisionIndex).toBe(0);
    expect(retry.ordinal).toBe(failed.ordinal);
    expect(retry.profileName).toBe('Economy');
    expect([retry.schemaRepairsUsed, retry.transportRetriesUsed, retry.rateLimitWaitsUsed]).toEqual([0, 0, 0]);
  });

  it('latestFor and latestPerStepKey pick the max (revision_index, retry_index); a revision beats a retry', () => {
    const run = setup();
    const r0 = seedStep(f.db, f.clock, run.id, { stepKey: 'review' });
    const r0retry1 = f.db.repos.steps.insertRetry(r0, { id: newId('stepRun'), state: 'ready', createdAt: f.clock.now() });
    f.db.repos.steps.insertRetry(r0retry1, { id: newId('stepRun'), state: 'ready', createdAt: f.clock.now() });
    const rev1 = seedStep(f.db, f.clock, run.id, { stepKey: 'review', revisionIndex: 1 });
    const plan = seedStep(f.db, f.clock, run.id, { stepKey: 'plan', ordinal: 2, state: 'pending' });

    const latest = f.db.repos.steps.latestFor(run.id, 'review' as StepKey);
    const perKey = f.db.repos.steps.latestPerStepKey(run.id);

    expect(latest?.id).toBe(rev1.id);
    expect(perKey.map((s) => s.id)).toEqual([rev1.id, plan.id]);
    expect(f.db.repos.steps.listForRun(run.id)).toHaveLength(5);
    expect(f.db.repos.steps.latestFor(run.id, 'nope' as StepKey)).toBeUndefined();
  });

  it('listEligible respects not_before_at, and earliestNotBefore returns the minimum future value or null', () => {
    const run = setup();
    const a = seedStep(f.db, f.clock, run.id, { stepKey: 'review', ordinal: 1 });
    const b = seedStep(f.db, f.clock, run.id, { stepKey: 'plan', ordinal: 2 });
    f.db.repos.steps.setNotBefore(a.id, epochMs(5000));
    f.db.repos.steps.setNotBefore(b.id, epochMs(7000));

    const early = f.db.repos.steps.listEligible(run.id, epochMs(4000));
    const mid = f.db.repos.steps.listEligible(run.id, epochMs(5000));
    const nextWake = f.db.repos.steps.earliestNotBefore(run.id, epochMs(4000));
    const afterA = f.db.repos.steps.earliestNotBefore(run.id, epochMs(5000));
    f.db.repos.steps.setNotBefore(b.id, null);
    const none = f.db.repos.steps.earliestNotBefore(run.id, epochMs(6000));

    expect(early).toEqual([]);
    expect(mid.map((s) => s.id)).toEqual([a.id]);
    expect(nextWake).toBe(5000);
    expect(afterA).toBe(7000);
    expect(none).toBeNull();
    expect(f.db.repos.steps.listEligible(run.id, epochMs(6000)).map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it('transition is compare-and-set and writes only the provided columns', () => {
    const run = setup();
    const s = seedStep(f.db, f.clock, run.id);
    const art = newId('artifact');

    const lost = f.db.repos.steps.transition(s.id, ['executing'], 'succeeded', {});
    const won = f.db.repos.steps.transition(s.id, ['ready'], 'executing', { outcome: 'accept', inputArtifactIds: [art] });
    const failed = f.db.repos.steps.transition(s.id, ['executing'], 'failed', {
      error: { code: 'OUTPUT_INVALID', userMessage: 'bad', retryable: true, nextAction: 'retry_step', alternatives: [] },
      outcome: null,
    });
    const row = f.db.repos.steps.get(s.id);

    expect(lost).toBe(false);
    expect(won && failed).toBe(true);
    expect(row.state).toBe('failed');
    expect(row.outcome).toBeNull();
    expect(row.inputArtifactIds).toEqual([art]);
    expect(row.error?.code).toBe('OUTPUT_INVALID');
    expect(row.profileName).toBe('Economy');
    expect(f.db.repos.steps.find(newId('stepRun'))).toBeUndefined();
    expect(() => f.db.repos.steps.get(newId('stepRun'))).toThrow();
    expect(() => f.db.repos.steps.transition(s.id, [], 'ready', {})).toThrow();
  });
});
