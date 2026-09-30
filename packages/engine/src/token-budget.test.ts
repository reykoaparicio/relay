import { describe, expect, it } from 'vitest';
import type { ProfileSnapshot } from '@relay/contracts';
import { createLocalEstimator, inputBudget, localTokens } from './token-budget.js';

const profile = (maxInputTokens: number | undefined, paramsMax?: number): ProfileSnapshot => ({
  id: 'prf_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as ProfileSnapshot['id'], name: 'Economy', providerId: 'anthropic', modelId: 'm', revision: 1, updatedAt: 0 as ProfileSnapshot['updatedAt'],
  params: { maxOutputTokens: 1000, refusalFallback: 'off', ...(paramsMax === undefined ? {} : { maxInputTokens: paramsMax }) },
  capabilities: { structuredOutput: true, streaming: true, tools: false, supportsRequestLookup: false, supportsTokenCounting: false, effortLevels: [], thinkingAlwaysOn: false,
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }) },
  prices: { input: 1 as never, output: 1 as never, cacheRead: 1 as never, cacheWrite: 1 as never },
  priceCatalogVersion: 'v',
});

describe('token budget (Wave-1 minimum)', () => {
  it('inputBudget = min(caps − output, profile cap) × 0.95, floored', () => {
    expect(inputBudget(profile(10_000), 2_000)).toBe(7_600);
    expect(inputBudget(profile(10_000, 5_000), 2_000)).toBe(4_750);
    expect(inputBudget(profile(undefined, 1_000), 2_000)).toBe(950);
    expect(inputBudget(profile(1_000), 2_000)).toBe(0);
    expect(inputBudget(profile(undefined), 1)).toBe(Math.floor(Number.MAX_SAFE_INTEGER * 0.95));
  });

  it('the local estimator counts ceil(chars × 23 / 64) over system + user', async () => {
    expect(localTokens(64)).toBe(23);
    expect(localTokens(1)).toBe(1);
    expect(await createLocalEstimator().count({ system: 'x'.repeat(32), user: 'y'.repeat(32), profile: profile(1) })).toEqual({ tokens: 23, basis: 'local_estimate' });
  });
});
