// 04 §D2: integer µUSD arithmetic over DISJOINT usage categories (§8.4, §9.2). Never floats.
import { addMicrousd, microusd, mulDivCeil } from '@relay/contracts';
import type { Microusd, ModelPrices, ProviderId } from '@relay/contracts';
import { maxProviderPrices } from './catalog.js';
import type { NormalizedUsage, ServedIteration } from './types.js';

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
export function computeCost(usage: NormalizedUsage, prices: ModelPrices): CalculatedCost {
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

/** Cost of a multi-model turn; `estimated` when some iteration's model had no known price. */
export interface IterationsCost {
  readonly microusd: Microusd;
  readonly certainty: 'calculated' | 'estimated';
}

/**
 * Cost of a turn served by several models (ADR-016 refusal fallback): each iteration is priced with its own model's
 * prices. An iteration whose model has no known price (e.g. a fallback model newer than the catalog) is priced at the
 * component-wise maximum of every `providerId` catalog price and the known iteration prices, and the result is then
 * `certainty: 'estimated'` (never a silent under-charge, §8.1).
 * @throws Error when no price at all is known for `providerId` (invariant: the requested model is in the catalog).
 */
export function computeIterationsCost(
  iterations: readonly ServedIteration[],
  pricesFor: (modelId: string) => ModelPrices | undefined,
  providerId: ProviderId,
): IterationsCost {
  const priced = iterations.map((it) => ({ usage: it.usage, prices: pricesFor(it.modelId) }));
  const known = priced.flatMap((p) => (p.prices === undefined ? [] : [p.prices]));
  let fallbackPrices: ModelPrices | undefined;
  const parts = priced.map((p) => {
    if (p.prices !== undefined) return computeCost(p.usage, p.prices).microusd;
    fallbackPrices ??= maxProviderPrices(providerId, ...known);
    if (fallbackPrices === undefined) throw new Error(`no known price for provider ${providerId}`);
    return computeCost(p.usage, fallbackPrices).microusd;
  });
  return { microusd: addMicrousd(...parts), certainty: known.length === priced.length ? 'calculated' : 'estimated' };
}
