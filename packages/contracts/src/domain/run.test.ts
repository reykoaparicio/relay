import { describe, expect, it } from 'vitest';
import { profileOptionSchema, runDetailSchema, runInputSchema } from './run.js';

describe('runInputSchema (E1)', () => {
  it('accepts acknowledgedSuspectedSecrets that are selected files and keeps them on the stored input', () => {
    const parsed = runInputSchema.parse({ kind: 'files', relPaths: ['src/a.ts', 'src/b.ts'], acknowledgedSuspectedSecrets: ['src/b.ts'] });
    expect(parsed).toEqual({ kind: 'files', relPaths: ['src/a.ts', 'src/b.ts'], acknowledgedSuspectedSecrets: ['src/b.ts'] });
  });

  it('rejects an acknowledged path that is not one of relPaths (path names the entry)', () => {
    const res = runInputSchema.safeParse({ kind: 'files', relPaths: ['src/a.ts'], acknowledgedSuspectedSecrets: ['src/b.ts'] });
    expect(res.success).toBe(false);
    expect(res.error?.issues.map((i) => i.path.join('.'))).toEqual(['acknowledgedSuspectedSecrets.0']);
  });
});

describe('RunDetail E1 fields', () => {
  it('profile options carry a basis; the run-level fields are optional', () => {
    const option = { stepKey: 'review', profileId: 'prf_01J9ZZZZZZZZZZZZZZZZZZZZZ0', profileName: 'Economy', providerId: 'anthropic', modelId: 'm',
      reservationMicrousd: 1, estimatedInputTokens: 0, basis: 'minimum', current: true };
    expect(profileOptionSchema.safeParse(option).success).toBe(true);
    expect(profileOptionSchema.safeParse({ ...option, basis: 'guess' }).success).toBe(false);
    expect(runDetailSchema.shape.attempts.safeParse(undefined).success).toBe(true);
    expect(runDetailSchema.shape.profileOptions.safeParse(undefined).success).toBe(true);
  });
});
