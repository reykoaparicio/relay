import { describe, expect, it } from 'vitest';
import { profileOptionSchema, runDetailSchema, runInputSchema, storedRunInputSchema } from './run.js';

describe('runInputSchema (E1)', () => {
  const SHA = 'a'.repeat(64);

  it('accepts acknowledgedSuspectedSecrets { relPath, sha256 } of selected files and keeps them on the stored input', () => {
    const parsed = runInputSchema.parse({ kind: 'files', relPaths: ['src/a.ts', 'src/b.ts'], acknowledgedSuspectedSecrets: [{ relPath: 'src/b.ts', sha256: SHA }] });
    expect(parsed).toEqual({ kind: 'files', relPaths: ['src/a.ts', 'src/b.ts'], acknowledgedSuspectedSecrets: [{ relPath: 'src/b.ts', sha256: SHA }] });
  });

  it('rejects an acknowledged path that is not one of relPaths (path names the entry)', () => {
    const res = runInputSchema.safeParse({ kind: 'files', relPaths: ['src/a.ts'], acknowledgedSuspectedSecrets: [{ relPath: 'src/b.ts', sha256: SHA }] });
    expect(res.success).toBe(false);
    expect(res.error?.issues.map((i) => i.path.join('.'))).toEqual(['acknowledgedSuspectedSecrets.0.relPath']);
  });

  it('round-3 M4: rejects the legacy bare-relPath form and an entry without a valid sha256', () => {
    expect(runInputSchema.safeParse({ kind: 'files', relPaths: ['src/a.ts'], acknowledgedSuspectedSecrets: ['src/a.ts'] }).success).toBe(false);
    expect(runInputSchema.safeParse({ kind: 'files', relPaths: ['src/a.ts'], acknowledgedSuspectedSecrets: [{ relPath: 'src/a.ts' }] }).success).toBe(false);
    expect(runInputSchema.safeParse({ kind: 'files', relPaths: ['src/a.ts'], acknowledgedSuspectedSecrets: [{ relPath: 'src/a.ts', sha256: 'xyz' }] }).success).toBe(false);
  });

  it('storedRunInputSchema: a stored run with legacy string acks still loads, with those acks dropped (never matching)', () => {
    expect(storedRunInputSchema.parse({ kind: 'files', relPaths: ['src/a.ts'], acknowledgedSuspectedSecrets: ['src/a.ts'] })).toEqual({ kind: 'files', relPaths: ['src/a.ts'] });
    const mixed = { kind: 'files', relPaths: ['src/a.ts', 'src/b.ts'], acknowledgedSuspectedSecrets: ['src/a.ts', { relPath: 'src/b.ts', sha256: SHA }] };
    expect(storedRunInputSchema.parse(mixed)).toEqual({ kind: 'files', relPaths: ['src/a.ts', 'src/b.ts'], acknowledgedSuspectedSecrets: [{ relPath: 'src/b.ts', sha256: SHA }] });
    const current = { kind: 'files', relPaths: ['src/a.ts'], acknowledgedSuspectedSecrets: [{ relPath: 'src/a.ts', sha256: SHA }] };
    expect(storedRunInputSchema.parse(current)).toEqual(current);
    const diff = { kind: 'diff', diffArtifactId: 'art_01J9ZZZZZZZZZZZZZZZZZZZZZ0' };
    expect(storedRunInputSchema.parse(diff)).toEqual(diff);
    expect(storedRunInputSchema.safeParse(null).success).toBe(false);
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
