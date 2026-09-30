// Pure pricing (§8.4, §9.2, §9.3; 04 §D2): integer µUSD arithmetic over DISJOINT usage categories. Never floats.
// Shared by @relay/providers (estimates) and @relay/engine (admission + settlement), so both price identically.
import type { ModelPrices } from './domain/catalog.js';
import type { Microusd } from './money.js';
import { addMicrousd, microusd, mulDivCeil } from './money.js';

/** Token usage over disjoint categories (structurally identical to providers `NormalizedUsage`). */
export interface TokenUsage {
  readonly uncachedInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
  /** Includes reasoning/thinking tokens (billed as output). */
  readonly outputTokens: number;
  /** Informational subset of `outputTokens`; never priced on its own. */
  readonly reasoningTokens?: number | undefined;
}

/** A cost computed from known usage and catalog prices. */
export interface CalculatedCost {
  readonly microusd: Microusd;
  readonly certainty: 'calculated';
}

/**
 * Σ ceil(tokens × price / 1M) over the disjoint categories. `reasoningTokens` is never added: it is already part of
 * `outputTokens` (§8.4 "do not double-count").
 * @throws RangeError when a token count is not a non-negative safe integer.
 */
export function computeCost(usage: TokenUsage, prices: ModelPrices): CalculatedCost {
  return {
    microusd: addMicrousd(
      mulDivCeil(usage.uncachedInputTokens, prices.input),
      mulDivCeil(usage.cacheReadInputTokens, prices.cacheRead),
      mulDivCeil(usage.cacheWriteInputTokens, prices.cacheWrite),
      mulDivCeil(usage.outputTokens, prices.output),
    ),
    certainty: 'calculated',
  };
}

/**
 * Rounding slack for {@link upperBound}: `computeCost` rounds each of the three input categories up separately, and
 * ceil(x) + ceil(y) + ceil(z) ≤ ceil(x + y + z) + 2, so two extra µUSD cover any split of the input tokens.
 */
export const INPUT_SPLIT_ROUNDING_SLACK_MICROUSD = 2;

/**
 * Conservative admission bound N (§9.3): every input token at the HIGHEST input-side rate
 * (max of input, cacheWrite, cacheRead — a cache write costs more than an uncached token) plus the full output
 * allowance, plus {@link INPUT_SPLIT_ROUNDING_SLACK_MICROUSD}. Hence `upperBound(n, m, p) ≥ computeCost(u, p)` for every
 * usage `u` whose three input categories sum to `n` and whose output is ≤ `m`.
 * @throws RangeError when a token count is not a non-negative safe integer.
 */
export function upperBound(inputTokens: number, maxOutputTokens: number, prices: ModelPrices): Microusd {
  const inputRate = Math.max(prices.input, prices.cacheWrite, prices.cacheRead);
  const slack = inputTokens > 0 ? INPUT_SPLIT_ROUNDING_SLACK_MICROUSD : 0;
  return addMicrousd(mulDivCeil(inputTokens, inputRate), mulDivCeil(maxOutputTokens, prices.output), microusd(slack));
}

/** Component-wise maximum of `prices` (undefined when empty). */
export function maxPrices(prices: readonly ModelPrices[]): ModelPrices | undefined {
  const [first, ...rest] = prices;
  if (first === undefined) return undefined;
  return rest.reduce<ModelPrices>(
    (max, p) => ({
      input: p.input > max.input ? p.input : max.input,
      output: p.output > max.output ? p.output : max.output,
      cacheRead: p.cacheRead > max.cacheRead ? p.cacheRead : max.cacheRead,
      cacheWrite: p.cacheWrite > max.cacheWrite ? p.cacheWrite : max.cacheWrite,
    }),
    first,
  );
}

/** One served iteration of a multi-model turn (ADR-016 refusal fallback). */
export interface PricedIteration {
  readonly modelId: string;
  readonly usage: TokenUsage;
}

/** Cost of a multi-model turn; `estimated` when some iteration's model had no known price. */
export interface IterationsCost {
  readonly microusd: Microusd;
  readonly certainty: 'calculated' | 'estimated';
}

/** Price sources of {@link computeIterationsCost}. */
export interface IterationPriceLookup {
  /** Prices of a model of the provider, or undefined when unknown (e.g. a fallback model newer than the catalog). */
  readonly pricesFor: (modelId: string) => ModelPrices | undefined;
  /** Every known catalog price of the provider (used for the unknown-model maximum). */
  readonly providerPrices: () => readonly ModelPrices[];
}

/**
 * Cost of a turn served by several models (ADR-016 refusal fallback): each iteration is priced with its own model's
 * prices. An iteration whose model has no known price is priced at the component-wise maximum of every provider
 * catalog price and the known iteration prices, and the result is then `certainty: 'estimated'` (never a silent
 * under-charge, §8.1).
 * @throws Error when an iteration has no known price and no provider price is known at all.
 */
export function computeIterationsCost(iterations: readonly PricedIteration[], lookup: IterationPriceLookup): IterationsCost {
  const priced = iterations.map((it) => ({ usage: it.usage, prices: lookup.pricesFor(it.modelId) }));
  const known = priced.flatMap((p) => (p.prices === undefined ? [] : [p.prices]));
  let fallbackPrices: ModelPrices | undefined;
  const parts = priced.map((p) => {
    if (p.prices !== undefined) return computeCost(p.usage, p.prices).microusd;
    fallbackPrices ??= maxPrices([...lookup.providerPrices(), ...known]);
    if (fallbackPrices === undefined) throw new Error('no known price for the provider');
    return computeCost(p.usage, fallbackPrices).microusd;
  });
  return { microusd: addMicrousd(...parts), certainty: known.length === priced.length ? 'calculated' : 'estimated' };
}
