// 04 §D4: Anthropic Messages API adapter (@anthropic-ai/sdk). SDK objects never leave this file (§8.3).
import Anthropic from '@anthropic-ai/sdk';
import { PROVIDER_REQUEST_TIMEOUT_MS } from '@relay/contracts';
import type { ModelPrices } from '@relay/contracts';
import { emitProgress, emitResponseId, guardListener, optionalIds, progressTokens, startTrackedCall, successResult } from './adapter-kit.js';
import { findCatalogEntry } from './catalog.js';
import { catalogCapabilities, estimateWith } from './catalog-facet.js';
import { connectionTestRequest } from './connection-test.js';
import { mapProviderError, sdkErrorClasses } from './errors.js';
import { tryParseJson } from './json.js';
import { NOOP_LOGGER } from './safe-hook.js';
import { createTrackedFetch } from './tracked-fetch.js';
import type { DispatchTracker } from './tracked-fetch.js';
import type {
  EstimateContext,
  FallbackInfo,
  GenerateContext,
  ModelRequest,
  ModelResult,
  NormalizedUsage,
  ProviderAdapter,
  ProviderAdapterOptions,
  UsageEstimate,
} from './types.js';
import { normalizeAnthropicUsage } from './usage.js';
import type { AnthropicUsageLike } from './usage.js';

/** Factory options (the shared {@link ProviderAdapterOptions}). */
export type AnthropicAdapterOptions = ProviderAdapterOptions;

const API_BASE_URL = 'https://api.anthropic.com';
/** ADR-016 refusal fallback, scalar `fallbacks: 'default'` form (requires exactly this beta header). */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const ANTHROPIC_ERRORS = sdkErrorClasses(Anthropic);

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
  const ids = optionalIds({ providerResponseId: message.id, providerRequestId: tracker.requestId ?? stream.request_id ?? undefined });
  const fb = req.refusalFallback === 'default' ? fallbackInfo(message, req) : undefined;
  const extra = { rawUsage: message.usage, ...ids, ...(fb === undefined ? {} : { fallback: fb }) };
  const stopReason = message.stop_reason ?? 'none';
  switch (stopReason) {
    case 'end_turn':
      return successResult(tracker, now, { json: tryParseJson(rawText), rawText, usage }, extra);
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
      timeout: PROVIDER_REQUEST_TIMEOUT_MS, // ADR-013: the engine owns every retry; one HTTP call = one Attempt
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
      state.providerResponseId = event.message.id;
      emitResponseId(ctx, logger, event.message.id, tracker.requestId ?? stream.request_id ?? undefined);
      return;
    }
    if (event.type !== 'content_block_delta' && event.type !== 'message_delta') return;
    state.outputChars += deltaTextLength(event.delta);
    // Anthropic reports running output usage: show whichever is larger, the reported count or the chars estimate.
    emitProgress(ctx, logger, clock, startedAt, Math.max(snapshot.usage.output_tokens ?? 0, progressTokens(state.outputChars)));
  };

  const generate = async (req: ModelRequest, ctx: GenerateContext): Promise<ModelResult> => {
    assertRequest(req);
    const { trackedFetch, tracker, startedAt } = startTrackedCall(baseFetch(), clock, logger, ctx);
    const state: CallState = { outputChars: 0 };
    try {
      const stream = openStream(makeClient(ctx.apiKey, trackedFetch), req, ctx.signal);
      stream.on(
        'streamEvent',
        guardListener(logger, (event: StreamEventLike, snapshot: MessageLike) => {
          onStreamEvent(event, snapshot, state, ctx, tracker, stream, startedAt);
        }),
      );
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

  const estimate = (req: ModelRequest, prices: ModelPrices, ctx?: EstimateContext): Promise<UsageEstimate> =>
    estimateWith({ providerId: 'anthropic', logger, countTokens }, req, prices, ctx);

  // reconcile: not implemented. There is no endpoint to look up a past Messages request (supportsRequestLookup: false),
  // so unknown Anthropic outcomes always go to the user decision flow (§7.5).
  return {
    providerId: 'anthropic',
    capabilities: (modelId) => catalogCapabilities('anthropic', modelId),
    estimate,
    generate,
    testConnection: (ctx) =>
      generate(connectionTestRequest('anthropic', ctx.modelId), { apiKey: ctx.apiKey, signal: ctx.signal }),
  };
}
