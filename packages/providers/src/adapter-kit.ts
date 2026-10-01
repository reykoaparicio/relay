// Shared plumbing of the HTTP adapters (anthropic, openai, gemini). Only the mechanics live here; every real provider
// difference (where the request id comes from, Anthropic's progress max with reported usage, terminal-state logic)
// stays in the adapter.
import type { Clock } from '@relay/contracts';
import { PROGRESS_CHARS_PER_TOKEN } from '@relay/contracts';
import { safeHook } from './safe-hook.js';
import { createTrackedFetch } from './tracked-fetch.js';
import type { DispatchTracker } from './tracked-fetch.js';
import type { GenerateContext, Logger, ModelSuccess, NormalizedUsage } from './types.js';

/** `err.name` for an Error, else its `typeof`: the only thing logged about a caught error (never message or args). */
export function errorNameOf(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** The defined subset of `{ providerResponseId, providerRequestId }`, ready to spread (exactOptionalPropertyTypes). */
export function optionalIds(ids: {
  readonly providerResponseId?: string | undefined;
  readonly providerRequestId?: string | undefined;
}): { providerResponseId?: string; providerRequestId?: string } {
  return {
    ...(ids.providerResponseId === undefined ? {} : { providerResponseId: ids.providerResponseId }),
    ...(ids.providerRequestId === undefined ? {} : { providerRequestId: ids.providerRequestId }),
  };
}

/** One in-flight `generate` call: its tracked fetch, the tracker, and when it started. */
export interface TrackedCall {
  readonly trackedFetch: typeof fetch;
  readonly tracker: DispatchTracker;
  readonly startedAt: number;
}

/** Starts a tracked call: a per-call tracked fetch that fires `ctx.hooks.onDispatched` right before bytes leave. */
export function startTrackedCall(baseFetch: typeof fetch, clock: Clock, logger: Logger, ctx: GenerateContext): TrackedCall {
  const startedAt = clock.now();
  const { fetch: trackedFetch, tracker } = createTrackedFetch(baseFetch, { clock, logger, onDispatched: () => ctx.hooks?.onDispatched?.() });
  return { trackedFetch, tracker, startedAt };
}

/** Fires `onResponseId` through {@link safeHook} (R4-27: a throwing hook never breaks the call). */
export function emitResponseId(ctx: GenerateContext, logger: Logger, providerResponseId: string, providerRequestId: string | undefined): void {
  safeHook('onResponseId', () => ctx.hooks?.onResponseId?.(optionalIds({ providerResponseId, providerRequestId })), logger);
}

/** Output tokens shown while streaming: a rough chars/token count (display only, never money). */
export function progressTokens(outputChars: number): number {
  return Math.ceil(outputChars / PROGRESS_CHARS_PER_TOKEN);
}

/** Fires `onProgress` through {@link safeHook}. */
export function emitProgress(ctx: GenerateContext, logger: Logger, clock: Clock, startedAt: number, outputTokensSoFar: number): void {
  safeHook('onProgress', () => ctx.hooks?.onProgress?.({ outputTokensSoFar, elapsedMs: clock.now() - startedAt }), logger);
}

/**
 * Wraps a stream listener so its own failure (a bug in event handling) is logged at warn and swallowed: the SDK must
 * keep streaming, and the call's outcome is decided by the stream, not by the listener.
 */
export function guardListener<A extends unknown[]>(logger: Logger, fn: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    try {
      fn(...args);
    } catch (err) {
      logger.warn('provider.stream_listener_failed', { errorName: errorNameOf(err) });
    }
  };
}

/** The `success` result: latency from the dispatch instant (or `now`), first-byte time when the tracker saw one. */
export function successResult(
  tracker: DispatchTracker,
  now: number,
  body: { readonly json: unknown; readonly rawText: string; readonly usage: NormalizedUsage },
  extra: Omit<ModelSuccess, 'kind' | 'json' | 'rawText' | 'usage' | 'stopReason' | 'latencyMs' | 'firstByteMs'>,
): ModelSuccess {
  const start = tracker.dispatchedAt ?? now;
  return {
    kind: 'success',
    ...body,
    stopReason: 'end_turn',
    latencyMs: now - start,
    ...(tracker.firstByteAt === undefined ? {} : { firstByteMs: tracker.firstByteAt - start }),
    ...extra,
  };
}
