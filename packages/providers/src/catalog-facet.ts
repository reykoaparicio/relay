// The catalog-backed half of an HTTP adapter (04 §D1/§D2): capabilities, the estimate contract (R4-12 + the
// count-failure fallback ADR note in 04), and the lowest-effort connection test. Each adapter keeps its own
// `countTokens` (the request shapes differ per provider).
import { RelayError, errors } from '@relay/contracts';
import type { ModelCapabilities, ModelPrices, ProviderId } from '@relay/contracts';
import { errorNameOf } from './adapter-kit.js';
import { findCatalogEntry, priceCatalogVersionFor } from './catalog.js';
import { connectionTestRequest } from './connection-test.js';
import { buildEstimate, conservativeInputTokens, localEstimate } from './estimate.js';
import type { EstimateContext, GenerateContext, Logger, ModelRequest, ModelResult, ProviderAdapter, UsageEstimate } from './types.js';

/**
 * `ProviderAdapter.capabilities` from the newest catalog entry.
 * @returns a promise rejected with `RelayError(MODEL_UNSUPPORTED not_in_catalog)` for an unknown model.
 */
export function catalogCapabilities(providerId: ProviderId, modelId: string): Promise<ModelCapabilities> {
  const entry = findCatalogEntry(providerId, modelId);
  if (entry === undefined) {
    return Promise.reject(new RelayError(errors.modelUnsupported({ providerId, modelId, reason: 'not_in_catalog' })));
  }
  return Promise.resolve(entry.capabilities);
}

/** A provider token count for `req` (the adapter's own request shape). Throws on any failure. */
export type CountTokens = (req: ModelRequest, apiKey: string, signal: AbortSignal | undefined) => Promise<number>;

/** Adapter-specific inputs of {@link estimateWith}. */
export interface EstimateDeps {
  readonly providerId: ProviderId;
  readonly logger: Logger;
  readonly countTokens: CountTokens;
}

/**
 * `ProviderAdapter.estimate` (R4-12): the provider count when `ctx.apiKey` is present and the catalog says
 * `supportsTokenCounting`; otherwise the local heuristic. When the count call fails (free but rate-limited), the
 * failure is logged and, for a model with a prompt-length price tier (`priceCliffInputTokens`), the conservative
 * one-token-per-char bound is used, so a dense-script prompt cannot slip under the tier via the chars/3.2 heuristic.
 */
export async function estimateWith(deps: EstimateDeps, req: ModelRequest, prices: ModelPrices, ctx?: EstimateContext): Promise<UsageEstimate> {
  const entry = findCatalogEntry(deps.providerId, req.modelId);
  const version = priceCatalogVersionFor(deps.providerId, req.modelId, prices, ctx?.priceCatalogVersion);
  if (ctx?.apiKey === undefined || entry?.capabilities.supportsTokenCounting !== true) return localEstimate(req, prices, version);
  try {
    const inputTokens = await deps.countTokens(req, ctx.apiKey, ctx.signal);
    return buildEstimate(inputTokens, req, prices, 'provider_count', version);
  } catch (err) {
    deps.logger.warn('provider.count_tokens_failed', { providerId: deps.providerId, errorName: errorNameOf(err) });
    if (entry.capabilities.priceCliffInputTokens !== undefined) {
      return buildEstimate(conservativeInputTokens(req), req, prices, 'local_estimate', version);
    }
    return localEstimate(req, prices, version);
  }
}

/**
 * `ProviderAdapter.testConnection` for models that always reason (OpenAI, Gemini): the lowest effort the catalog lists
 * plus the provider's connection-test output allowance lets the model finish `{"ok":true}`; a `truncated` answer
 * still proves the key and the model work.
 */
export function testConnectionAtLowestEffort(
  providerId: ProviderId,
  generate: ProviderAdapter['generate'],
  ctx: { readonly apiKey: string; readonly signal: AbortSignal; readonly modelId: string },
): Promise<ModelResult> {
  const effort = findCatalogEntry(providerId, ctx.modelId)?.capabilities.effortLevels[0];
  const req = connectionTestRequest(providerId, ctx.modelId);
  const generateCtx: GenerateContext = { apiKey: ctx.apiKey, signal: ctx.signal };
  return generate(effort === undefined ? req : { ...req, effort }, generateCtx);
}
