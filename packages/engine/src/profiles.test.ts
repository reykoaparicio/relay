import { afterEach, describe, expect, it } from 'vitest';
import { loadCatalogEntries } from '@relay/providers';
import type { CatalogModel } from '@relay/contracts';
import { checkProfile, findProfileByName, profilesWithWarnings } from './profiles.js';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const haiku = loadCatalogEntries().find((e) => e.modelId === 'claude-haiku-4-5') as CatalogModel;
const base = { providerId: 'anthropic' as const, modelId: 'claude-haiku-4-5', params: { maxOutputTokens: 8_000, refusalFallback: 'off' as const } };
const reason = (r: ReturnType<typeof checkProfile>) => (r.ok ? null : r.error.details?.['reason']);

describe('checkProfile (F14)', () => {
  it('passes a valid profile', () => {
    expect(checkProfile(base, haiku).ok).toBe(true);
  });

  it('returns MODEL_UNSUPPORTED for an unknown model, unsupported effort, no structured output, and a too-large output allowance', () => {
    expect(reason(checkProfile({ ...base, modelId: 'nope' }, undefined))).toBe('model_unknown');
    expect(reason(checkProfile({ ...base, params: { ...base.params, effort: 'high' } }, haiku))).toBe('effort_unsupported');
    expect(reason(checkProfile(base, haiku, { ...haiku.capabilities, structuredOutput: false }))).toBe('structured_output_unsupported');
    expect(reason(checkProfile({ ...base, params: { ...base.params, maxOutputTokens: 100_000 } }, haiku))).toBe('output_budget_low');
    const r = checkProfile({ ...base, modelId: 'nope' }, undefined);
    expect(r.ok ? null : r.error.code).toBe('MODEL_UNSUPPORTED');
  });
});

describe('profilesWithWarnings', () => {
  it('returns [] warnings for a valid seeded profile once a credential exists, and the matching codes for a broken one', async () => {
    h = await createHarness();
    h.db.tx('immediate', (r) => {
      r.credentials.upsert({ id: h!.ids.next('credentialRef'), providerId: 'anthropic', storageMode: 'session', vaultFile: null, redactedLabel: 'sk-…' });
      const saved = r.profiles.upsert({ id: h!.ids.next('profile'), name: 'Broken', providerId: 'openai', modelId: 'gpt-none', params: { maxOutputTokens: 10, effort: 'max', refusalFallback: 'off' },
        capabilitiesSnapshot: haiku.capabilities, catalogVersion: 'x' });
      if (!saved.ok) throw new Error('upsert');
    });

    const list = profilesWithWarnings(h.db.repos);

    const byName = Object.fromEntries(list.map((p) => [p.profile.name, p.warnings.map((w) => w.code)]));
    expect(byName).toEqual({ Economy: [], Balanced: [], Capable: [], Broken: ['model_unknown', 'missing_credential'] });
    expect(findProfileByName(h.db.repos, 'economy')?.name).toBe('Economy');
    expect(findProfileByName(h.db.repos, 'Capable')?.name).toBe('Capable');
    expect(findProfileByName(h.db.repos, 'nobody')).toBeUndefined();
  });
});
