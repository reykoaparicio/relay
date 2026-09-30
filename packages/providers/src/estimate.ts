// 04 §D1 estimate contract (R4-12): local heuristic when no provider count is available.
import { addMicrousd } from '@relay/contracts';
import type { ModelPrices } from '@relay/contracts';
import { maxProviderPrices } from './catalog.js';
import { upperBound } from './pricing.js';
import type { ModelRequest, UsageEstimate } from './types.js';

/**
 * Fixed per-request input overhead (tokens) added to every LOCAL estimate: the provider-injected framing of a
 * structured-output request (the system prompt the provider wraps around the JSON schema, message/role markers). It is
 * deliberately generous; a provider count (`basis: 'provider_count'`) already includes it.
 */
export const LOCAL_REQUEST_OVERHEAD_TOKENS = 512;

/**
 * Characters of input the model is billed for: system + messages + the serialized output JSON schema (structured
 * outputs bill the schema as input tokens).
 */
export function promptChars(req: Pick<ModelRequest, 'system' | 'messages'> & { readonly outputSchema?: ModelRequest['outputSchema'] }): number {
  const schemaChars = req.outputSchema === undefined ? 0 : JSON.stringify(req.outputSchema.jsonSchema).length;
  return req.messages.reduce((n, m) => n + m.content.length, req.system.length + schemaChars);
}

/**
 * Local token heuristic `ceil(chars / 3.2 × 1.15)` (04 §D4), computed exactly in integers as `ceil(chars × 23 / 64)`.
 * Deliberately generous so admission stays conservative (§9.3).
 */
export function localTokenEstimate(chars: number): number {
  return Math.ceil((chars * 23) / 64);
}

/** Number of billed hops N must cover: two with an ADR-016 refusal fallback (declined call + rescue), else one. */
export function billedHops(req: Pick<ModelRequest, 'refusalFallback'>): 1 | 2 {
  return req.refusalFallback === 'default' ? 2 : 1;
}

/**
 * Prices used for N. Without a fallback: `prices`. With `refusalFallback: 'default'` the provider may serve the turn with
 * another model of the same provider, so every hop is priced at the component-wise maximum of `prices` and every
 * catalog entry of `req.providerId` (conservative: all entries are treated as eligible fallbacks).
 */
export function allowancePrices(req: Pick<ModelRequest, 'providerId' | 'refusalFallback'>, prices: ModelPrices): ModelPrices {
  if (req.refusalFallback !== 'default') return prices;
  return maxProviderPrices(req.providerId, prices) ?? prices;
}

/**
 * Builds a {@link UsageEstimate} (both bases). N = hops × upperBound(inputTokens, maxOutputTokens, allowancePrices).
 */
export function buildEstimate(
  inputTokens: number,
  req: Pick<ModelRequest, 'maxOutputTokens' | 'providerId' | 'refusalFallback'>,
  prices: ModelPrices,
  basis: UsageEstimate['basis'],
  priceCatalogVersion: string,
): UsageEstimate {
  const perHop = upperBound(inputTokens, req.maxOutputTokens, allowancePrices(req, prices));
  return {
    inputTokens,
    maxOutputTokens: req.maxOutputTokens,
    upperAllowanceMicrousd: billedHops(req) === 2 ? addMicrousd(perHop, perHop) : perHop,
    basis,
    priceCatalogVersion,
  };
}

/** Local input-token estimate for `req`: prompt + schema characters, plus {@link LOCAL_REQUEST_OVERHEAD_TOKENS}. */
export function localInputTokens(req: ModelRequest): number {
  return localTokenEstimate(promptChars(req)) + LOCAL_REQUEST_OVERHEAD_TOKENS;
}

/**
 * Conservative local input bound for price-cliff models when no provider count is available: one token per UTF-16 code
 * unit of all prompt text + serialized schema (dense scripts such as CJK tokenize at about one token per character,
 * which the chars/3.2 heuristic undercounts ~3x), plus {@link LOCAL_REQUEST_OVERHEAD_TOKENS}.
 */
export function conservativeInputTokens(req: ModelRequest): number {
  return promptChars(req) + LOCAL_REQUEST_OVERHEAD_TOKENS;
}

/** Local-heuristic estimate for `req`. */
export function localEstimate(req: ModelRequest, prices: ModelPrices, priceCatalogVersion: string): UsageEstimate {
  return buildEstimate(localInputTokens(req), req, prices, 'local_estimate', priceCatalogVersion);
}
