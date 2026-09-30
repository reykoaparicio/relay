// 04 §D2: integer µUSD arithmetic over DISJOINT usage categories (§8.4, §9.2). Never floats.
import { addMicrousd, mulDivCeil } from '@relay/contracts';
import type { Microusd, ModelPrices } from '@relay/contracts';
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
 * Conservative admission bound N (§9.3): all input at the uncached rate plus the full output allowance.
 * @throws RangeError when a token count is not a non-negative safe integer.
 */
export function upperBound(inputTokens: number, maxOutputTokens: number, prices: ModelPrices): Microusd {
  return addMicrousd(mulDivCeil(inputTokens, prices.input), mulDivCeil(maxOutputTokens, prices.output));
}

/**
 * Cost of a turn served by several models (ADR-016 refusal fallback): each iteration is priced with its own model's
 * prices. Returns `undefined` when any iteration's model has no known price (the caller must not guess, §8.1).
 */
export function computeIterationsCost(
  iterations: readonly ServedIteration[],
  pricesFor: (modelId: string) => ModelPrices | undefined,
): CalculatedCost | undefined {
  const parts: Microusd[] = [];
  for (const it of iterations) {
    const prices = pricesFor(it.modelId);
    if (prices === undefined) return undefined;
    parts.push(computeCost(it.usage, prices).microusd);
  }
  return { microusd: addMicrousd(...parts), certainty: 'calculated' };
}
