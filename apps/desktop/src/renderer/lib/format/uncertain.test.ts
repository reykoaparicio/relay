import { describe, expect, it } from 'vitest';
import { attempt, runDetail } from '../../components/ui/test-fixtures';
import { mayNotHaveBeenCharged, uncertainAmount, uncertainAttemptsOf } from './uncertain';

describe('uncertain attempts (decision 1)', () => {
  it('lists uncertainAttempts, then legacy unresolvedAttempts, once each', () => {
    const a = attempt(2, { state: 'unknown', cost: { microusd: 620_000, certainty: 'estimated' } });
    const b = attempt(3, { state: 'unknown', cost: { microusd: 100_000, certainty: 'unknown' } });
    const run = runDetail({ uncertainAttempts: [a], unresolvedAttempts: [a, b] });
    expect(uncertainAttemptsOf(run).map((x) => x.id)).toEqual([a.id, b.id]);
    expect(uncertainAmount(uncertainAttemptsOf(run))).toBe(720_000);
  });

  it('reads mayNotHaveBeenCharged', () => {
    expect(mayNotHaveBeenCharged(attempt(1, { mayNotHaveBeenCharged: true }))).toBe(true);
    expect(mayNotHaveBeenCharged(attempt(1))).toBe(false);
  });
});
