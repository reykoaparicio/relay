// The ONE provider-adapter lookup policy of the engine (fail closed, 00b §1.5). `ProviderRegistry.get` throws when no
// adapter serves a provider id in this mode (e.g. `fake` in a live build); every caller goes through these two helpers
// instead of its own try/catch:
//
//   - `adapterOf`: no adapter → MODEL_UNSUPPORTED `{ providerId, reason: 'no_adapter' }`. Dispatch pauses on it,
//     preflight/start/providers.test return it, and reconciliation skips the attempt (it stays unknown).
//   - `liveCapabilities`: the same no_adapter error when no adapter serves the provider. An adapter that does not serve
//     the MODEL rejects with MODEL_UNSUPPORTED (the catalog adapters' `not_in_catalog`, by design): that error passes
//     through unlogged, and callers report it as `model_unknown` by checking the profile with no catalog entry
//     ({@link isModelRejected}). Any other `capabilities()` failure is a bug (capabilities are a static table): it is
//     logged through `logSafe` and treated as no_adapter. Capabilities that cannot be read are never guessed from the
//     catalog, so the profile is unsupported until the adapter answers.
import { errors, err, isRelayError, ok } from '@relay/contracts';
import type { ModelCapabilities, ProviderId, Result } from '@relay/contracts';
import type { ProviderAdapter } from '@relay/providers';
import { logSafe } from './log-safe.js';
import type { EngineCtx } from './ports.js';

const noAdapter = (providerId: ProviderId, modelId?: string) =>
  errors.modelUnsupported({ providerId, ...(modelId === undefined ? {} : { modelId }), reason: 'no_adapter' });

/** The adapter serving `providerId`, or MODEL_UNSUPPORTED `no_adapter` (fail closed). */
export function adapterOf(ctx: Pick<EngineCtx, 'providers'>, providerId: ProviderId): Result<ProviderAdapter> {
  try {
    return ok(ctx.providers.get(providerId));
  } catch {
    return err(noAdapter(providerId));
  }
}

/**
 * The adapter's live capabilities for `modelId`. No adapter, or a `capabilities()` call that fails unexpectedly
 * (logged), is MODEL_UNSUPPORTED `no_adapter`; an adapter that rejects the model with MODEL_UNSUPPORTED returns that
 * error as-is ({@link isModelRejected}). The caller reports or refuses either, never falls back to a guess.
 */
export async function liveCapabilities(ctx: Pick<EngineCtx, 'providers' | 'logger'>, providerId: ProviderId, modelId: string): Promise<Result<ModelCapabilities>> {
  const adapter = adapterOf(ctx, providerId);
  if (!adapter.ok) return err(noAdapter(providerId, modelId));
  try {
    return ok(await adapter.value.capabilities(modelId));
  } catch (e) {
    if (isRelayError(e) && e.appError.code === 'MODEL_UNSUPPORTED') return err(e.appError); // the adapter does not serve this model
    ctx.logger.warn('provider.capabilities_failed', { providerId, err: logSafe(e) });
    return err(noAdapter(providerId, modelId));
  }
}

/**
 * True when {@link liveCapabilities} failed because the adapter does not serve the model, as opposed to no adapter
 * serving the provider. Callers then check the profile with no catalog entry, so `checkProfile` reports
 * `model_unknown` exactly once (with its message), instead of a second `no_adapter` issue.
 */
export function isModelRejected(live: Result<unknown>): boolean {
  return !live.ok && live.error.code === 'MODEL_UNSUPPORTED' && live.error.details?.['reason'] !== 'no_adapter';
}
