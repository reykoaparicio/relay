// 04 §D4: Anthropic Messages API adapter (@anthropic-ai/sdk). SDK objects never leave this file (§8.3).
import Anthropic from '@anthropic-ai/sdk';
import { RelayError, errors } from '@relay/contracts';
import type { Clock, ModelCapabilities, ModelPrices } from '@relay/contracts';
import { findCatalogEntry, priceCatalogVersionFor } from './catalog.js';
import { connectionTestRequest } from './connection-test.js';
import { mapProviderError } from './errors.js';
import type { SdkErrorClasses } from './errors.js';
import { buildEstimate, localEstimate } from './estimate.js';
import { NOOP_LOGGER, safeHook } from './safe-hook.js';
import { createTrackedFetch } from './tracked-fetch.js';
import type { DispatchTracker } from './tracked-fetch.js';
import type {
  EstimateContext,
  FallbackInfo,
  GenerateContext,
  Logger,
  ModelRequest,
  ModelResult,
  NormalizedUsage,
  ProviderAdapter,
  UsageEstimate,
} from './types.js';
import { normalizeAnthropicUsage } from './usage.js';
import type { AnthropicUsageLike } from './usage.js';

/** Factory options. `fetch` is the injected base fetch; when omitted, `globalThis.fetch` is read at call time. */
export interface AnthropicAdapterOptions {
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
}

/** ADR-013: the engine owns every retry, so each HTTP attempt is an Attempt row with its own reservation. */
const REQUEST_TIMEOUT_MS = 600_000;
const API_BASE_URL = 'https://api.anthropic.com';
/** ADR-016 refusal fallback, scalar `fallbacks: 'default'` form (requires exactly this beta header). */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Rough chars-per-token used only for progress display (never for money). */
const PROGRESS_CHARS_PER_TOKEN = 4;

const ANTHROPIC_ERRORS: SdkErrorClasses = {
  APIError: Anthropic.APIError,
  APIUserAbortError: Anthropic.APIUserAbortError,
  APIConnectionError: Anthropic.APIConnectionError,
  RateLimitError: Anthropic.RateLimitError,
  AuthenticationError: Anthropic.AuthenticationError,
  PermissionDeniedError: Anthropic.PermissionDeniedError,
  NotFoundError: Anthropic.NotFoundError,
  BadRequestError: Anthropic.BadRequestError,
  UnprocessableEntityError: Anthropic.UnprocessableEntityError,
  InternalServerError: Anthropic.InternalServerError,
};

// Structural views of the SDK stream/message, so the SDK's types stay inside this module.
interface IterationLike extends AnthropicUsageLike {
  readonly type: string;
  readonly model?: string | null;
}
interface MessageLike {
  readonly id: string;
  readonly model: string;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly stop_reason: string | null;
  readonly stop_details?: { readonly category?: string | null } | null;
  readonly usage: AnthropicUsageLike & { readonly iterations?: readonly IterationLike[] | null };
}
interface StreamEventLike {
  readonly type: string;
  readonly message?: { readonly id: string };
  readonly delta?: unknown;
}
interface StreamLike {
  on(event: 'streamEvent', listener: (event: StreamEventLike, snapshot: MessageLike) => void): unknown;
  finalMessage(): Promise<MessageLike>;
  readonly request_id?: string | null | undefined;
}

interface CallState {
  providerResponseId?: string;
  partialUsage?: NormalizedUsage;
  outputChars: number;
}

/** Request body per 04 §D4. `thinking` and `tool_choice` are deliberately never set (400 on Opus/Sonnet 5.5). */
function requestParams(req: ModelRequest) {
  return {
    model: req.modelId,
    max_tokens: req.maxOutputTokens,
    system: req.system,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    output_config: {
      format: { type: 'json_schema' as const, schema: { ...req.outputSchema.jsonSchema } },
      ...(req.effort === undefined ? {} : { effort: req.effort }),
    },
    // No `metadata` (Anthropic metadata is user_id only); stepKey/purpose never leave the machine.
  };
}

function deltaTextLength(delta: unknown): number {
  if (typeof delta !== 'object' || delta === null || !('text' in delta)) return 0;
  const text = (delta).text;
  return typeof text === 'string' ? text.length : 0;
}

function textOf(message: MessageLike): string {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** ADR-016: which model(s) served the turn when fallbacks were enabled. */
function fallbackInfo(message: MessageLike, req: ModelRequest): FallbackInfo | undefined {
  const iterations = message.usage.iterations ?? [];
  if (!iterations.some((it) => it.type === 'fallback_message')) return undefined;
  return {
    servedByModel: message.model,
    iterations: iterations.map((it) => ({
      modelId: it.type === 'fallback_message' && typeof it.model === 'string' ? it.model : req.modelId,
      usage: normalizeAnthropicUsage(it),
    })),
  };
}

function toResult(message: MessageLike, req: ModelRequest, tracker: DispatchTracker, stream: StreamLike, now: number): ModelResult {
  const usage = normalizeAnthropicUsage(message.usage);
  const rawText = textOf(message);
  const requestId = tracker.requestId ?? stream.request_id ?? undefined;
  const ids = { providerResponseId: message.id, ...(requestId === undefined ? {} : { providerRequestId: requestId }) };
  const fb = req.refusalFallback === 'default' ? fallbackInfo(message, req) : undefined;
  const extra = { rawUsage: message.usage, ...ids, ...(fb === undefined ? {} : { fallback: fb }) };
  const stopReason = message.stop_reason ?? 'none';
  switch (stopReason) {
    case 'end_turn': {
      const start = tracker.dispatchedAt ?? now;
      return {
        kind: 'success',
        json: tryParseJson(rawText),
        rawText,
        usage,
        stopReason: 'end_turn',
        latencyMs: now - start,
        ...(tracker.firstByteAt === undefined ? {} : { firstByteMs: tracker.firstByteAt - start }),
        ...extra,
      };
    }
    case 'refusal': {
      const category = message.stop_details?.category ?? undefined; // stop_details is null unless refused
      return { kind: 'refused', usage, ...(category === undefined ? {} : { category }), ...extra };
    }
    case 'max_tokens':
      return { kind: 'truncated', rawText, usage, ...extra };
    default:
      return { kind: 'truncated', rawText, usage, rawStopReason: stopReason, ...extra };
  }
}

/**
 * Creates the Anthropic adapter. A client is constructed per call (the key is never retained) with SDK retries
 * disabled (ADR-013) and the per-call tracked fetch (04 §D3).
 */
export function createAnthropicAdapter(opts: AnthropicAdapterOptions): ProviderAdapter {
  const { clock } = opts;
  const logger = opts.logger ?? NOOP_LOGGER;
  const baseFetch = (): typeof fetch => opts.fetch ?? globalThis.fetch; // read at call time, never at module load

  const makeClient = (apiKey: string, trackedFetch: typeof fetch): Anthropic =>
    new Anthropic({
      apiKey,
      authToken: null,
      baseURL: API_BASE_URL,
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
      fetch: trackedFetch,
      logLevel: 'off',
    });

  const openStream = (client: Anthropic, req: ModelRequest, signal: AbortSignal): StreamLike => {
    const params = requestParams(req);
    if (req.refusalFallback === 'default') {
      return client.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, { signal });
    }
    return client.messages.stream(params, { signal });
  };

  const assertRequest = (req: ModelRequest): void => {
    if (req.providerId !== 'anthropic') throw new Error(`anthropic adapter got providerId ${req.providerId}`);
    const entry = findCatalogEntry('anthropic', req.modelId);
    // §8.4: capability validation blocks unsupported effort before dispatch; this is the adapter's own assertion.
    if (req.effort !== undefined && entry !== undefined && !entry.capabilities.effortLevels.includes(req.effort)) {
      throw new Error(`effort ${req.effort} is not supported by ${req.modelId}`);
    }
  };

  const onStreamEvent = (event: StreamEventLike, snapshot: MessageLike, state: CallState, ctx: GenerateContext, tracker: DispatchTracker, stream: StreamLike, startedAt: number): void => {
    state.partialUsage = normalizeAnthropicUsage(snapshot.usage);
    if (event.type === 'message_start' && event.message !== undefined) {
      const providerResponseId = event.message.id;
      state.providerResponseId = providerResponseId;
      const providerRequestId = tracker.requestId ?? stream.request_id ?? undefined;
      safeHook('onResponseId', () => ctx.hooks?.onResponseId?.({ providerResponseId, ...(providerRequestId === undefined ? {} : { providerRequestId }) }), logger);
      return;
    }
    if (event.type !== 'content_block_delta' && event.type !== 'message_delta') return;
    state.outputChars += deltaTextLength(event.delta);
    const outputTokensSoFar = Math.max(snapshot.usage.output_tokens ?? 0, Math.ceil(state.outputChars / PROGRESS_CHARS_PER_TOKEN));
    safeHook('onProgress', () => ctx.hooks?.onProgress?.({ outputTokensSoFar, elapsedMs: clock.now() - startedAt }), logger);
  };

  const generate = async (req: ModelRequest, ctx: GenerateContext): Promise<ModelResult> => {
    assertRequest(req);
    const startedAt = clock.now();
    const { fetch: trackedFetch, tracker } = createTrackedFetch(baseFetch(), {
      clock,
      logger,
      onDispatched: () => ctx.hooks?.onDispatched?.(),
    });
    const state: CallState = { outputChars: 0 };
    try {
      const stream = openStream(makeClient(ctx.apiKey, trackedFetch), req, ctx.signal);
      stream.on('streamEvent', (event, snapshot) => {
        try {
          onStreamEvent(event, snapshot, state, ctx, tracker, stream, startedAt);
        } catch (err) {
          logger.warn('provider.stream_listener_failed', { errorName: err instanceof Error ? err.name : typeof err });
        }
      });
      const message = await stream.finalMessage();
      return toResult(message, req, tracker, stream, clock.now());
    } catch (err) {
      return mapProviderError(err, {
        providerId: 'anthropic',
        tracker,
        classes: ANTHROPIC_ERRORS,
        clock,
        aborted: ctx.signal.aborted,
        ...(state.providerResponseId === undefined ? {} : { providerResponseId: state.providerResponseId }),
        ...(state.partialUsage === undefined ? {} : { partialUsage: state.partialUsage }),
      });
    }
  };

  const countTokens = async (req: ModelRequest, apiKey: string, signal: AbortSignal | undefined): Promise<number> => {
    const { fetch: trackedFetch } = createTrackedFetch(baseFetch(), { clock, logger });
    const params = requestParams(req);
    const res = await makeClient(apiKey, trackedFetch).messages.countTokens(
      { model: params.model, system: params.system, messages: params.messages, output_config: { format: params.output_config.format } },
      signal === undefined ? {} : { signal },
    );
    return res.input_tokens;
  };

  const estimate = async (
    req: ModelRequest,
    prices: ModelPrices,
    ctx?: EstimateContext,
  ): Promise<UsageEstimate> => {
    const entry = findCatalogEntry('anthropic', req.modelId);
    const version = priceCatalogVersionFor('anthropic', req.modelId, prices, ctx?.priceCatalogVersion);
    if (ctx?.apiKey !== undefined && entry?.capabilities.supportsTokenCounting === true) {
      try {
        const inputTokens = await countTokens(req, ctx.apiKey, ctx.signal);
        return buildEstimate(inputTokens, req, prices, 'provider_count', version);
      } catch (err) {
        // Counting is free but rate-limited; any failure falls back to the local heuristic (R4-12).
        logger.warn('provider.count_tokens_failed', { providerId: 'anthropic', errorName: err instanceof Error ? err.name : typeof err });
      }
    }
    return localEstimate(req, prices, version);
  };

  const capabilities = (modelId: string): Promise<ModelCapabilities> => {
    const entry = findCatalogEntry('anthropic', modelId);
    if (entry === undefined) {
      return Promise.reject(new RelayError(errors.modelUnsupported({ providerId: 'anthropic', modelId, reason: 'not_in_catalog' })));
    }
    return Promise.resolve(entry.capabilities);
  };

  // reconcile: not implemented. There is no endpoint to look up a past Messages request (supportsRequestLookup: false),
  // so unknown Anthropic outcomes always go to the user decision flow (§7.5).
  return {
    providerId: 'anthropic',
    capabilities,
    estimate,
    generate,
    testConnection: (ctx) =>
      generate(connectionTestRequest('anthropic', ctx.modelId), { apiKey: ctx.apiKey, signal: ctx.signal }),
  };
}
