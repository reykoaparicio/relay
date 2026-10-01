// The ONE provider-adapter lookup policy of the engine (fail closed, 00b §1.5). `ProviderRegistry.get` throws when no
// adapter serves a provider id in this mode (e.g. `fake` in a live build); every caller goes through these two helpers
// instead of its own try/catch:
//
//   - `adapterOf`: no adapter → MODEL_UNSUPPORTED `{ providerId, reason: 'no_adapter' }`. Dispatch pauses on it,
//     preflight/start/providers.test return it, and reconciliation skips the attempt (it stays unknown).
//   - `liveCapabilities`: the same no_adapter error; an adapter whose `capabilities()` throws (a bug: capabilities are
//     a static table) is logged through `logSafe` and treated the same way — capabilities that cannot be read are never
//     guessed from the catalog, so the profile is unsupported until the adapter answers.
import { errors, err, ok } from '@relay/contracts';
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
 * The adapter's live capabilities for `modelId`. No adapter, or a `capabilities()` call that throws (logged), is
 * MODEL_UNSUPPORTED `no_adapter`: the caller reports or refuses it, never falls back to a guess.
 */
export async function liveCapabilities(ctx: Pick<EngineCtx, 'providers' | 'logger'>, providerId: ProviderId, modelId: string): Promise<Result<ModelCapabilities>> {
  const adapter = adapterOf(ctx, providerId);
  if (!adapter.ok) return err(noAdapter(providerId, modelId));
  try {
    return ok(await adapter.value.capabilities(modelId));
  } catch (e) {
    ctx.logger.warn('provider.capabilities_failed', { providerId, err: logSafe(e) });
    return err(noAdapter(providerId, modelId));
  }
}
