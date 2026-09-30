import { describe, expect, it } from 'vitest';
import { contextManifestSchema } from '@relay/contracts';
import type { RunId, StepKey } from '@relay/contracts';
import type { ManifestInput } from './manifest.js';
import { buildManifest, computeContextHash, computeIntakeContextHash, sha256Text } from './manifest.js';

const BASE: ManifestInput = {
  runId: 'run_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as RunId,
  stepKey: 'review' as StepKey,
  revisionIndex: 0,
  attemptPurpose: 'initial',
  profile: { name: 'Economy', providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
  priceCatalogVersion: '2026-09-25',
  instructions: { version: 'reviewer.v1', sha256: sha256Text('prompt') },
  files: [{ relPath: 'src/a.ts' as never, sha256: 'a'.repeat(64), sizeBytes: 10, tokens: 4, included: true, reason: 'selected' }],
  memory: [],
  upstream: [],
  omitted: [{ kind: 'file', ref: 'src/big.ts', reason: 'token_budget' }],
  tokens: { estimatedInput: 100, budget: 1000, basis: 'local_estimate' },
  contextHash: computeContextHash('s', 'u'),
  providersReceivingContext: ['anthropic'],
};

describe('manifest (07 G4)', () => {
  it('buildManifest output parses with the contracts contextManifestSchema; omitted items carry reasons', () => {
    const m = buildManifest(BASE);

    expect(contextManifestSchema.parse(m)).toEqual(m);
    expect(m.schemaVersion).toBe(1);
    expect(m.omitted[0]?.reason).toBe('token_budget');
  });

  it('rejects an invalid manifest (an internal error at G, never a stored artifact)', () => {
    expect(() => buildManifest({ ...BASE, contextHash: 'nope' })).toThrow();
  });

  it('computeContextHash is stable and separator-sensitive', () => {
    expect(computeContextHash('ab', 'c')).toBe(computeContextHash('ab', 'c'));
    expect(computeContextHash('ab', 'c')).not.toBe(computeContextHash('a', 'bc'));
    expect(computeContextHash('s', 'u')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('computeIntakeContextHash is independent of file/memory order and changes with content', () => {
    const f1 = { relPath: 'a.ts', sha256: 'a'.repeat(64) };
    const f2 = { relPath: 'b.ts', sha256: 'b'.repeat(64) };
    const m1 = { recordId: 'mem_1', revision: 1 };
    const m2 = { recordId: 'mem_2', revision: 3 };
    const input = { kind: 'files' as const, relPaths: ['a.ts', 'b.ts'] as never[] };

    const x = computeIntakeContextHash({ goal: 'g', input, files: [f1, f2], memory: [m1, m2] });

    expect(computeIntakeContextHash({ goal: 'g', input, files: [f2, f1], memory: [m2, m1] })).toBe(x);
    expect(computeIntakeContextHash({ goal: 'g2', input, files: [f1, f2], memory: [m1, m2] })).not.toBe(x);
    expect(computeIntakeContextHash({ goal: 'g', input, files: [f1, { ...f2, sha256: 'c'.repeat(64) }], memory: [m1, m2] })).not.toBe(x);
  });
});
