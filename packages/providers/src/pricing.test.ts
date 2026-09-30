import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { catalogFileSchema, mulDivCeil } from '@relay/contracts';
import type { ModelPrices } from '@relay/contracts';
import testCatalog from '../catalog/test-fixture.json' with { type: 'json' };
import { computeCost, computeIterationsCost, upperBound } from './pricing.js';
import type { NormalizedUsage } from './types.js';

const PRICES: ModelPrices = catalogFileSchema.parse(testCatalog).entries[0]!.prices; // clearly fake round prices

const usage = (u: Partial<NormalizedUsage>): NormalizedUsage => ({
  uncachedInputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  ...u,
});

describe('computeCost', () => {
  it('sums each disjoint category at its own rate', () => {
    const u = usage({ uncachedInputTokens: 1000, cacheReadInputTokens: 500, cacheWriteInputTokens: 200, outputTokens: 300 });

    const cost = computeCost(u, PRICES);

    // 1000×1 + 500×0.1 + 200×1.25 + 300×10 µUSD
    expect(cost).toEqual({ microusd: 1000 + 50 + 250 + 3000, certainty: 'calculated' });
  });

  it('never adds reasoning tokens on top of output tokens', () => {
    const withReasoning = usage({ outputTokens: 300, reasoningTokens: 200 });

    expect(computeCost(withReasoning, PRICES).microusd).toBe(computeCost(usage({ outputTokens: 300 }), PRICES).microusd);
  });

  it('rounds every category up to a whole µUSD (mulDivCeil)', () => {
    const cost = computeCost(usage({ uncachedInputTokens: 1, cacheReadInputTokens: 1 }), PRICES);

    expect(mulDivCeil(1, 100_000)).toBe(1);
    expect(cost.microusd).toBe(2);
  });

  it('rejects negative or fractional token counts', () => {
    expect(() => computeCost(usage({ outputTokens: -1 }), PRICES)).toThrow(RangeError);
    expect(() => computeCost(usage({ outputTokens: 1.5 }), PRICES)).toThrow(RangeError);
  });
});

describe('upperBound', () => {
  it('prices all input as uncached plus the full output allowance', () => {
    expect(upperBound(1000, 500, PRICES)).toBe(1000 + 5000);
  });

  it('is ≥ any actual cost with the same token counts and no cache categories (property)', () => {
    fc.assert(
      fc.property(fc.nat(10_000_000), fc.nat(1_000_000), fc.nat(1_000_000), (input, maxOut, used) => {
        const actual = computeCost(usage({ uncachedInputTokens: input, outputTokens: Math.min(used, maxOut) }), PRICES);
        return actual.microusd <= upperBound(input, maxOut, PRICES);
      }),
    );
  });

  it('is ≥ the cost when part of the input was cached (cache rates never exceed 1.25× input)', () => {
    fc.assert(
      fc.property(fc.nat(1_000_000), fc.nat(1_000_000), fc.nat(100_000), (uncached, read, out) => {
        const actual = computeCost(usage({ uncachedInputTokens: uncached, cacheReadInputTokens: read, outputTokens: out }), PRICES);
        return actual.microusd <= upperBound(uncached + read, out, PRICES);
      }),
    );
  });
});

describe('computeIterationsCost', () => {
  it('prices each served iteration with its own model', () => {
    const other: ModelPrices = { ...PRICES, output: PRICES.output * 2 } as ModelPrices;
    const iterations = [
      { modelId: 'a', usage: usage({ outputTokens: 100 }) },
      { modelId: 'b', usage: usage({ outputTokens: 100 }) },
    ];

    const cost = computeIterationsCost(iterations, (id) => (id === 'a' ? PRICES : other));

    expect(cost).toEqual({ microusd: 1000 + 2000, certainty: 'calculated' });
  });

  it('refuses to guess when a model has no known price', () => {
    expect(computeIterationsCost([{ modelId: 'x', usage: usage({}) }], () => undefined)).toBeUndefined();
  });
});
