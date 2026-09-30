import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ModelPrices } from './domain/catalog.js';
import { mulDivCeil } from './money.js';
import { INPUT_SPLIT_ROUNDING_SLACK_MICROUSD, computeCost, computeIterationsCost, maxPrices, upperBound } from './pricing.js';
import type { TokenUsage } from './pricing.js';

const PRICES = { input: 1_000_000, output: 10_000_000, cacheRead: 100_000, cacheWrite: 1_250_000 } as ModelPrices; // fake round prices

const usage = (u: Partial<TokenUsage>): TokenUsage => ({
  uncachedInputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  ...u,
});

describe('computeCost', () => {
  it('sums each disjoint category at its own rate', () => {
    const cost = computeCost(usage({ uncachedInputTokens: 1000, cacheReadInputTokens: 500, cacheWriteInputTokens: 200, outputTokens: 300 }), PRICES);

    expect(cost).toEqual({ microusd: 1000 + 50 + 250 + 3000, certainty: 'calculated' });
  });

  it('never adds reasoning tokens on top of output tokens', () => {
    expect(computeCost(usage({ outputTokens: 300, reasoningTokens: 200 }), PRICES).microusd).toBe(computeCost(usage({ outputTokens: 300 }), PRICES).microusd);
  });

  it('rounds every category up to a whole µUSD (mulDivCeil)', () => {
    expect(mulDivCeil(1, 100_000)).toBe(1);
    expect(computeCost(usage({ uncachedInputTokens: 1, cacheReadInputTokens: 1 }), PRICES).microusd).toBe(2);
  });

  it('rejects negative or fractional token counts', () => {
    expect(() => computeCost(usage({ outputTokens: -1 }), PRICES)).toThrow(RangeError);
    expect(() => computeCost(usage({ outputTokens: 1.5 }), PRICES)).toThrow(RangeError);
  });
});

describe('upperBound', () => {
  it('prices all input at the highest input-side rate plus the full output allowance and rounding slack', () => {
    expect(upperBound(1000, 500, PRICES)).toBe(1250 + 5000 + INPUT_SPLIT_ROUNDING_SLACK_MICROUSD);
    expect(upperBound(0, 500, PRICES)).toBe(5000);
  });

  it('uses cacheRead when it is the highest input-side rate', () => {
    expect(upperBound(10, 0, { input: 1, output: 1, cacheRead: 1_000_000, cacheWrite: 1 } as ModelPrices)).toBe(10 + 2);
  });

  const pricesArb = fc.record({
    input: fc.nat(50_000_000),
    output: fc.nat(100_000_000),
    cacheRead: fc.nat(50_000_000),
    cacheWrite: fc.nat(50_000_000),
  }) as fc.Arbitrary<ModelPrices>;

  it('is ≥ computeCost for any split of the same input tokens (property)', () => {
    fc.assert(
      fc.property(fc.nat(5_000_000), fc.nat(5_000_000), fc.nat(5_000_000), fc.nat(1_000_000), fc.nat(1_000_000), pricesArb,
        (uncached, read, write, maxOut, used, prices) => {
          const actual = computeCost(
            usage({ uncachedInputTokens: uncached, cacheReadInputTokens: read, cacheWriteInputTokens: write, outputTokens: Math.min(used, maxOut) }),
            prices,
          );
          return actual.microusd <= upperBound(uncached + read + write, maxOut, prices);
        }),
      { numRuns: 1000 },
    );
  });

  it('covers the worst-case per-category rounding', () => {
    const tiny = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } as ModelPrices;
    expect(computeCost(usage({ uncachedInputTokens: 1, cacheReadInputTokens: 1, cacheWriteInputTokens: 1 }), tiny).microusd).toBe(3);
    expect(upperBound(3, 0, tiny)).toBe(3);
  });
});

describe('maxPrices', () => {
  it('is the component-wise maximum and undefined for no prices', () => {
    const a = { input: 1, output: 9, cacheRead: 3, cacheWrite: 1 } as ModelPrices;
    const b = { input: 5, output: 2, cacheRead: 1, cacheWrite: 7 } as ModelPrices;

    expect(maxPrices([a, b])).toEqual({ input: 5, output: 9, cacheRead: 3, cacheWrite: 7 });
    expect(maxPrices([b, a])).toEqual({ input: 5, output: 9, cacheRead: 3, cacheWrite: 7 });
    expect(maxPrices([a])).toBe(a);
    expect(maxPrices([])).toBeUndefined();
  });
});

describe('computeIterationsCost', () => {
  const other = { ...PRICES, output: PRICES.output * 2 } as ModelPrices;

  it('prices each served iteration with its own model', () => {
    const cost = computeIterationsCost(
      [{ modelId: 'a', usage: usage({ outputTokens: 100 }) }, { modelId: 'b', usage: usage({ outputTokens: 100 }) }],
      { pricesFor: (id) => (id === 'a' ? PRICES : other), providerPrices: () => [] },
    );

    expect(cost).toEqual({ microusd: 1000 + 2000, certainty: 'calculated' });
  });

  it('prices an unknown model at the provider maximum (incl. known iteration prices) and marks it estimated', () => {
    const catalogMax = { input: 3_000_000, output: 15_000_000, cacheRead: 300_000, cacheWrite: 3_750_000 } as ModelPrices;
    const iterations = [
      { modelId: 'a', usage: usage({ uncachedInputTokens: 1000, outputTokens: 5 }) },
      { modelId: 'future', usage: usage({ uncachedInputTokens: 1000, outputTokens: 200 }) },
    ];

    const cost = computeIterationsCost(iterations, { pricesFor: (id) => (id === 'a' ? other : undefined), providerPrices: () => [catalogMax] });

    const max: ModelPrices = { ...catalogMax, output: other.output }; // 20M from the known iteration beats 15M
    expect(cost).toEqual({
      microusd: computeCost(iterations[0]!.usage, other).microusd + computeCost(iterations[1]!.usage, max).microusd,
      certainty: 'estimated',
    });
  });

  it('falls back to known iteration prices without provider prices, and throws with no price at all', () => {
    const cost = computeIterationsCost(
      [{ modelId: 'known', usage: usage({ outputTokens: 1 }) }, { modelId: 'unknown', usage: usage({ outputTokens: 1 }) }],
      { pricesFor: (id) => (id === 'known' ? PRICES : undefined), providerPrices: () => [] },
    );

    expect(cost).toEqual({ microusd: 20, certainty: 'estimated' });
    expect(() => computeIterationsCost([{ modelId: 'x', usage: usage({}) }], { pricesFor: () => undefined, providerPrices: () => [] })).toThrow(/no known price/);
  });

  it('is zero and calculated for no iterations', () => {
    expect(computeIterationsCost([], { pricesFor: () => undefined, providerPrices: () => [] })).toEqual({ microusd: 0, certainty: 'calculated' });
  });
});
