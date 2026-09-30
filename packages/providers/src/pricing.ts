// 04 §D2: integer µUSD pricing. The pure functions live in @relay/contracts (shared with the engine so estimates and
// settlement price identically); this module re-exports them and binds the unknown-model rule to the bundled catalog.
import { computeIterationsCost as computeIterationsCostWith } from '@relay/contracts';
import type { IterationsCost, ModelPrices, ProviderId } from '@relay/contracts';
import { loadCatalogEntries } from './catalog.js';
import type { ServedIteration } from './types.js';

export { INPUT_SPLIT_ROUNDING_SLACK_MICROUSD, computeCost, upperBound } from '@relay/contracts';
export type { CalculatedCost, IterationsCost } from '@relay/contracts';

/**
 * Cost of a turn served by several models (ADR-016 refusal fallback), each iteration at its own model's prices. An
 * iteration whose model has no known price is priced at the component-wise maximum of every bundled catalog price of
 * `providerId` and the known iteration prices, and the result is `certainty: 'estimated'` (contracts
 * `computeIterationsCost`).
 * @throws Error when no price at all is known for `providerId` (invariant: the requested model is in the catalog).
 */
export function computeIterationsCost(
  iterations: readonly ServedIteration[],
  pricesFor: (modelId: string) => ModelPrices | undefined,
  providerId: ProviderId,
): IterationsCost {
  return computeIterationsCostWith(iterations, {
    pricesFor,
    providerPrices: () => loadCatalogEntries().filter((e) => e.providerId === providerId).map((e) => e.prices),
  });
}
