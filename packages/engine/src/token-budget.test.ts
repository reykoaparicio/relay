import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ProfileSnapshot } from '@relay/contracts';
import type { FitItem } from './token-budget.js';
import { createLocalEstimator, fitToBudget, inputBudget, localTokens } from './token-budget.js';

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

const file = (ref: string, tokens: number): FitItem => ({ kind: 'file', ref, tokens });

describe('fitToBudget (07 G1b)', () => {
  it('returns CONTEXT_TOO_LARGE details with the largest mandatory items when mandatory material exceeds the budget', () => {
    const res = fitToBudget({ budget: 100, mandatoryTokens: 150, mandatory: [file('a.ts', 10), file('big.ts', 120), file('c.ts', 10)], optional: [file('d.ts', 1)] });

    expect(res).toEqual({ ok: false, details: { mandatoryTokens: 150, budget: 100, largestItems: [
      { relPath: 'big.ts', tokens: 120 }, { relPath: 'a.ts', tokens: 10 }, { relPath: 'c.ts', tokens: 10 },
    ] } });
  });

  it('adds optional items in priority order until the next one does not fit; that one and every later one are omitted whole', () => {
    const optional: FitItem[] = [{ kind: 'memory', ref: 'mem_1', tokens: 10 }, file('a.ts', 30), file('b.ts', 50), file('c.ts', 5)];

    const res = fitToBudget({ budget: 100, mandatoryTokens: 50, mandatory: [], optional });

    expect(res.ok && res.included.map((i) => i.ref)).toEqual(['mem_1', 'a.ts']);
    expect(res.ok && res.omitted.map((i) => i.ref)).toEqual(['b.ts', 'c.ts']);
    expect(res.ok && res.totalTokens).toBe(90);
  });

  it('property: included tokens never exceed the budget, and every optional item is either included or omitted (never split)', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 5_000 }),
      fc.integer({ min: 0, max: 5_000 }),
      fc.array(fc.integer({ min: 0, max: 2_000 }), { maxLength: 20 }),
      (budget, mandatoryTokens, sizes) => {
        const optional = sizes.map((t, n) => file(`f${String(n)}.ts`, t));
        const res = fitToBudget({ budget, mandatoryTokens, mandatory: [], optional });
        if (!res.ok) return mandatoryTokens > budget;
        const sum = mandatoryTokens + res.included.reduce((n, i) => n + i.tokens, 0);
        return sum === res.totalTokens && sum <= budget && res.included.length + res.omitted.length === optional.length;
      },
    ));
  });
});
