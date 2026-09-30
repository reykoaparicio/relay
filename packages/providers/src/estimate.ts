// 04 §D1 estimate contract (R4-12): local heuristic when no provider count is available.
import type { ModelPrices } from '@relay/contracts';
import { upperBound } from './pricing.js';
import type { ModelRequest, UsageEstimate } from './types.js';

/** Characters of prompt text the model will see. */
export function promptChars(req: Pick<ModelRequest, 'system' | 'messages'>): number {
  return req.messages.reduce((n, m) => n + m.content.length, req.system.length);
}

/**
 * Local token heuristic `ceil(chars / 3.2 × 1.15)` (04 §D4), computed exactly in integers as `ceil(chars × 23 / 64)`.
 * Deliberately generous so admission stays conservative (§9.3).
 */
export function localTokenEstimate(chars: number): number {
  return Math.ceil((chars * 23) / 64);
}

/** Builds a {@link UsageEstimate}; N = upperBound(inputTokens, maxOutputTokens, prices) in both bases. */
export function buildEstimate(
  inputTokens: number,
  req: Pick<ModelRequest, 'maxOutputTokens'>,
  prices: ModelPrices,
  basis: UsageEstimate['basis'],
  priceCatalogVersion: string,
): UsageEstimate {
  return {
    inputTokens,
    maxOutputTokens: req.maxOutputTokens,
    upperAllowanceMicrousd: upperBound(inputTokens, req.maxOutputTokens, prices),
    basis,
    priceCatalogVersion,
  };
}

/** Local-heuristic estimate for `req`. */
export function localEstimate(req: ModelRequest, prices: ModelPrices, priceCatalogVersion: string): UsageEstimate {
  return buildEstimate(localTokenEstimate(promptChars(req)), req, prices, 'local_estimate', priceCatalogVersion);
}
