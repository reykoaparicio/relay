import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { catalogFileSchema, mulDivCeil } from '@relay/contracts';
import type { ModelPrices } from '@relay/contracts';
import testCatalog from '../catalog/test-fixture.json' with { type: 'json' };
import { findCatalogEntry, maxProviderPrices } from './catalog.js';
import { INPUT_SPLIT_ROUNDING_SLACK_MICROUSD, computeCost, computeIterationsCost, upperBound } from './pricing.js';
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
  it('prices all input at the highest input-side rate (cache write) plus the full output allowance and rounding slack', () => {
    // 1000 × 1.25 + 500 × 10 + 2 µUSD
    expect(upperBound(1000, 500, PRICES)).toBe(1250 + 5000 + INPUT_SPLIT_ROUNDING_SLACK_MICROUSD);
    expect(upperBound(0, 500, PRICES)).toBe(5000);
  });

  it('regression: an all-cache-write turn never exceeds N', () => {
    const n = 100_000;
    const actual = computeCost(usage({ cacheWriteInputTokens: n, outputTokens: 10 }), PRICES);

    expect(actual.microusd).toBeLessThanOrEqual(upperBound(n, 10, PRICES));
  });

  const pricesArb = fc.record({
    input: fc.nat(50_000_000),
    output: fc.nat(100_000_000),
    cacheRead: fc.nat(50_000_000),
    cacheWrite: fc.nat(50_000_000),
  }) as fc.Arbitrary<ModelPrices>;

  it('is ≥ computeCost for any split of the same input tokens across uncached / cache read / cache write (property)', () => {
    fc.assert(
      fc.property(
        fc.nat(5_000_000),
        fc.nat(5_000_000),
        fc.nat(5_000_000),
        fc.nat(1_000_000),
        fc.nat(1_000_000),
        fc.oneof(fc.constant(PRICES), pricesArb),
        (uncached, read, write, maxOut, used, prices) => {
          const actual = computeCost(
            usage({ uncachedInputTokens: uncached, cacheReadInputTokens: read, cacheWriteInputTokens: write, outputTokens: Math.min(used, maxOut) }),
            prices,
          );
          return actual.microusd <= upperBound(uncached + read + write, maxOut, prices);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('covers the worst-case per-category rounding (1 token in each input category at a sub-µUSD rate)', () => {
    const tiny = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } as ModelPrices;
    const actual = computeCost(usage({ uncachedInputTokens: 1, cacheReadInputTokens: 1, cacheWriteInputTokens: 1 }), tiny);

    expect(actual.microusd).toBe(3);
    expect(upperBound(3, 0, tiny)).toBe(3);
  });
});

describe('computeIterationsCost', () => {
  it('prices each served iteration with its own model', () => {
    const other: ModelPrices = { ...PRICES, output: PRICES.output * 2 } as ModelPrices;
    const iterations = [
      { modelId: 'a', usage: usage({ outputTokens: 100 }) },
      { modelId: 'b', usage: usage({ outputTokens: 100 }) },
    ];

    const cost = computeIterationsCost(iterations, (id) => (id === 'a' ? PRICES : other), 'anthropic');

    expect(cost).toEqual({ microusd: 1000 + 2000, certainty: 'calculated' });
  });

  it('prices an unknown fallback model at the maximum catalog price of the provider and marks it estimated', () => {
    const opus = findCatalogEntry('anthropic', 'claude-opus-5-5')!.prices;
    const iterations = [
      { modelId: 'claude-haiku-4-5', usage: usage({ uncachedInputTokens: 1000, outputTokens: 5 }) },
      { modelId: 'claude-future-9', usage: usage({ uncachedInputTokens: 1000, outputTokens: 200 }) },
    ];
    const haiku = findCatalogEntry('anthropic', 'claude-haiku-4-5')!.prices;

    const cost = computeIterationsCost(iterations, (id) => findCatalogEntry('anthropic', id)?.prices, 'anthropic');

    const max = maxProviderPrices('anthropic')!;
    expect(max.output).toBeGreaterThanOrEqual(opus.output);
    expect(cost.certainty).toBe('estimated');
    expect(cost.microusd).toBe(computeCost(iterations[0]!.usage, haiku).microusd + computeCost(iterations[1]!.usage, max).microusd);
  });

  it('uses the known iteration prices when the provider has no catalog entries at all, and throws with no price', () => {
    const iterations = [
      { modelId: 'known', usage: usage({ outputTokens: 1 }) },
      { modelId: 'unknown', usage: usage({ outputTokens: 1 }) },
    ];

    const cost = computeIterationsCost(iterations, (id) => (id === 'known' ? PRICES : undefined), 'openai');

    expect(cost).toEqual({ microusd: 20, certainty: 'estimated' });
    expect(() => computeIterationsCost([{ modelId: 'x', usage: usage({}) }], () => undefined, 'openai')).toThrow(/no known price/);
  });
});
