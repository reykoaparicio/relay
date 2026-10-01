// 04 §D10: Gemini adapter (`@google/genai` 2.24, Gemini Developer API). SDK objects never leave this file (§8.3).
//
// SDK facts (verified 2026-09-30 against node_modules/@google/genai 2.24.0 typings + dist/node/index.mjs):
// - `new GoogleGenAI({ apiKey, vertexai, enterprise, apiVersion, httpOptions })`; `httpOptions.fetch` is a custom fetch
//   used for every request, `httpOptions.headers` are applied BEFORE auth, and the SDK only adds `x-goog-api-key` when
//   that header is not already present.
// - Environment fallbacks in the constructor: GOOGLE_API_KEY / GEMINI_API_KEY (only when `apiKey` is undefined),
//   GOOGLE_GENAI_USE_VERTEXAI / GOOGLE_GENAI_USE_ENTERPRISE (only when neither flag is passed), GOOGLE_CLOUD_PROJECT /
//   _LOCATION (Vertex only), GOOGLE_GEMINI_BASE_URL and the module-global `setDefaultBaseUrls` (only when
//   `httpOptions.baseUrl` is unset). Every one of them is pinned below.
// - Retries: none unless `httpOptions.retryOptions` is set (then p-retry, default 5 attempts on 408/429/5xx). We pin
//   `retryOptions: { attempts: 1 }` ("0 or 1 means no retries") so a future default cannot re-enable them (ADR-013).
// - `httpOptions.timeout` is NOT set: the SDK would mutate the process-global undici dispatcher timeouts
//   (`raiseUndiciTimeouts`). Cancellation comes from the engine's AbortSignal (`config.abortSignal`).
// - Errors: a single `ApiError { status, message }` class; the message is the JSON-stringified error body. Fetch
//   rejections are rethrown as-is (no connection-error class), so this file wraps them (`GeminiConnectionError`).
import { GoogleGenAI, ServiceTier } from '@google/genai';
import type { ThinkingLevel } from '@google/genai';
import type { ModelPrices } from '@relay/contracts';
import { emitProgress, emitResponseId, guardListener, optionalIds, progressTokens, startTrackedCall, successResult } from './adapter-kit.js';
import { findCatalogEntry } from './catalog.js';
import { catalogCapabilities, estimateWith, testConnectionAtLowestEffort } from './catalog-facet.js';
import { mapProviderError } from './errors.js';
import { LOCAL_REQUEST_OVERHEAD_TOKENS } from './estimate.js';
import { GEMINI_ERRORS, GeminiConnectionError, toTypedGeminiError } from './gemini-errors.js';
import { streamErrorOf, watchSseErrors } from './gemini-sse.js';
import type { SseErrorPayload } from './gemini-sse.js';
import { isGeminiPriceTierMismatch, mapGeminiEffort } from './gemini-tier.js';
import { tryParseJson } from './json.js';
import { NOOP_LOGGER } from './safe-hook.js';
import { abortError, createTrackedFetch, isSignalAborted } from './tracked-fetch.js';
import type { DispatchTracker } from './tracked-fetch.js';
import type {
  EstimateContext,
  GenerateContext,
  ModelRequest,
  ModelResult,
  NormalizedUsage,
  ProviderAdapter,
  ProviderAdapterOptions,
  UsageEstimate,
} from './types.js';
import { normalizeGeminiUsage } from './usage.js';
import type { GeminiUsageLike } from './usage.js';

export { toTypedGeminiError } from './gemini-errors.js';
export { isGeminiPriceTierMismatch, mapGeminiEffort } from './gemini-tier.js';

/** Factory options (the shared {@link ProviderAdapterOptions}). */
export type GeminiAdapterOptions = ProviderAdapterOptions;

/** Explicit base URL + version so GOOGLE_GEMINI_BASE_URL / setDefaultBaseUrls can never redirect requests (or keys). */
const API_BASE_URL = 'https://generativelanguage.googleapis.com/';
const API_VERSION = 'v1beta';
const API_KEY_HEADER = 'x-goog-api-key';

// ---- Structural views of the stream chunks (SDK types stay inside this module). ----

interface PartLike {
  readonly text?: string;
  readonly thought?: boolean;
}
interface CandidateLike {
  readonly content?: { readonly parts?: readonly PartLike[] };
  readonly finishReason?: string;
}
interface UsageMetadataLike extends GeminiUsageLike {
  /** Vertex AI only (`TrafficType`). */
  readonly trafficType?: string;
  /** Gemini Developer API only (`ServiceTier`: unspecified / standard / flex / priority). */
  readonly serviceTier?: string;
}
interface ChunkLike {
  readonly responseId?: string;
  readonly candidates?: readonly CandidateLike[];
  readonly usageMetadata?: UsageMetadataLike;
  readonly promptFeedback?: { readonly blockReason?: string };
}

interface CallState {
  providerResponseId?: string;
  text: string;
  finishReason?: string;
  blockReason?: string;
  /** Latest usage block (the last chunk carries the complete counts). */
  usage?: UsageMetadataLike;
  /** Whether a terminal chunk (finishReason / prompt blockReason) has been seen. */
  terminalSeen: boolean;
  /** A usage block arrived on or after the terminal chunk: only then are the counts final. */
  usageFinal: boolean;
  /** A raw SSE `{"error":…}` payload the SDK silently drops (captured from the body stream). */
  sseError?: SseErrorPayload;
}

/** Finish reasons that mean the model (or a policy) declined: `refused` (04 §D10). */
const REFUSAL_FINISH_REASONS: ReadonlySet<string> = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'RECITATION',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
]);

function userContents(req: ModelRequest) {
  return req.messages.map((m) => ({ role: m.role, parts: [{ text: m.content }] }));
}

/**
 * Request per 04 §D10. No metadata is sent: Gemini API `labels` are Vertex-only (the SDK throws for the Developer API).
 * `serviceTier: standard` pins the catalog-priced tier (the SDK sends it as the top-level request `serviceTier`), so a
 * future default change or a project-level flex/priority setting cannot silently change the price.
 */
function requestParams(req: ModelRequest, thinkingLevel: ThinkingLevel | undefined, signal: AbortSignal) {
  return {
    model: req.modelId,
    contents: userContents(req),
    config: {
      serviceTier: ServiceTier.STANDARD,
      systemInstruction: req.system,
      maxOutputTokens: req.maxOutputTokens,
      responseMimeType: 'application/json',
      responseJsonSchema: { ...req.outputSchema.jsonSchema },
      ...(thinkingLevel === undefined ? {} : { thinkingConfig: { thinkingLevel } }),
      abortSignal: signal,
    },
  };
}

/**
 * Usage is known only when a usage block arrived on or after the terminal chunk (earlier blocks are running counts,
 * not the bill) and it carries `promptTokenCount` and, if any text was produced, `candidatesTokenCount`; otherwise the
 * numbers are placeholders or stale and must not read as a known (under)cost.
 */
function usageIsKnown(state: CallState): boolean {
  const u = state.usage;
  if (!state.usageFinal || u === undefined || typeof u.promptTokenCount !== 'number') return false;
  return state.text === '' || typeof u.candidatesTokenCount === 'number';
}

/**
 * Creates the Gemini adapter. A client is constructed per call (the key is never retained) with SDK retries disabled
 * (ADR-013), every environment fallback pinned, and the per-call tracked fetch (04 §D3).
 */
export function createGeminiAdapter(opts: GeminiAdapterOptions): ProviderAdapter {
  const { clock } = opts;
  const logger = opts.logger ?? NOOP_LOGGER;
  const baseFetch = (): typeof fetch => opts.fetch ?? globalThis.fetch; // read at call time, never at module load

  /**
   * The key comes only from the credential store: passing `apiKey` disables the GOOGLE_API_KEY / GEMINI_API_KEY
   * fallback, and the `x-goog-api-key` header is pinned in `httpOptions.headers` (the SDK never overwrites a present
   * key header). `vertexai`/`enterprise: false` ignore GOOGLE_GENAI_USE_*; `baseUrl` ignores GOOGLE_GEMINI_BASE_URL.
   */
  const makeClient = (apiKey: string, trackedFetch: typeof fetch, onSseError?: (e: SseErrorPayload) => void): GoogleGenAI => {
    const connectionFetch: typeof fetch = async (input, init) => {
      // The SDK calls fetch even when its abortSignal is already aborted: never dispatch (phase stays `not_sent`).
      if (isSignalAborted(input, init)) throw abortError();
      let response: Response;
      try {
        response = await trackedFetch(input, init);
      } catch (err) {
        if (init?.signal?.aborted === true) throw err;
        throw new GeminiConnectionError(err);
      }
      return onSseError === undefined ? response : watchSseErrors(response, onSseError);
    };
    return new GoogleGenAI({
      apiKey,
      vertexai: false,
      enterprise: false,
      apiVersion: API_VERSION,
      httpOptions: {
        baseUrl: API_BASE_URL,
        apiVersion: API_VERSION,
        headers: { [API_KEY_HEADER]: apiKey },
        retryOptions: { attempts: 1 },
        fetch: connectionFetch,
      },
    });
  };

  const assertRequest = (req: ModelRequest): ThinkingLevel | undefined => {
    if (req.providerId !== 'gemini') throw new Error(`gemini adapter got providerId ${req.providerId}`);
    if (req.effort === undefined) return undefined;
    const entry = findCatalogEntry('gemini', req.modelId);
    // Unknown models are rejected by capability validation first; without an entry only Gemini's levels are mapped.
    return mapGeminiEffort(req.effort, entry?.capabilities ?? { effortLevels: [req.effort] });
  };

  const onChunk = (chunk: ChunkLike, state: CallState, ctx: GenerateContext, tracker: DispatchTracker, startedAt: number): void => {
    if (chunk.responseId !== undefined && state.providerResponseId === undefined) {
      state.providerResponseId = chunk.responseId;
      emitResponseId(ctx, logger, chunk.responseId, tracker.requestId); // the SDK exposes no request id of its own
    }
    if (chunk.promptFeedback?.blockReason !== undefined) state.blockReason = chunk.promptFeedback.blockReason;
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason !== undefined) state.finishReason = candidate.finishReason;
    if (state.finishReason !== undefined || state.blockReason !== undefined) state.terminalSeen = true;
    if (chunk.usageMetadata !== undefined) {
      state.usage = chunk.usageMetadata;
      state.usageFinal = state.terminalSeen; // a block before the terminal chunk is a running count, not the bill
    }
    if (candidate === undefined) return;
    const text = (candidate.content?.parts ?? [])
      .filter((p) => p.thought !== true)
      .map((p) => p.text ?? '')
      .join('');
    if (text === '') return;
    state.text += text;
    emitProgress(ctx, logger, clock, startedAt, progressTokens(state.text.length));
  };

  const partialUsageOf = (state: CallState): NormalizedUsage | undefined =>
    state.usage === undefined ? undefined : normalizeGeminiUsage(state.usage);

  const errorResult = (err: unknown, state: CallState, tracker: DispatchTracker, aborted: boolean): ModelResult => {
    const partialUsage = partialUsageOf(state);
    return mapProviderError(toTypedGeminiError(err), {
      providerId: 'gemini',
      tracker,
      classes: GEMINI_ERRORS,
      clock,
      aborted,
      ...(state.providerResponseId === undefined ? {} : { providerResponseId: state.providerResponseId }),
      ...(partialUsage === undefined ? {} : { partialUsage }),
      ...(state.sseError === undefined ? {} : { streamError: streamErrorOf(state.sseError) }),
    });
  };

  const toResult = (state: CallState, tracker: DispatchTracker, aborted: boolean): ModelResult => {
    const usage = normalizeGeminiUsage(state.usage);
    const extra = {
      rawUsage: state.usage ?? null,
      ...optionalIds({ providerResponseId: state.providerResponseId, providerRequestId: tracker.requestId }),
      ...(usageIsKnown(state) ? {} : { usageKnown: false }),
      ...(isGeminiPriceTierMismatch(state.usage) ? { priceTierMismatch: true } : {}),
    };
    if (state.blockReason !== undefined && state.finishReason === undefined) {
      return { kind: 'refused', category: `prompt_blocked:${state.blockReason}`, usage, ...extra };
    }
    const reason = state.finishReason;
    if (reason === 'STOP') return successResult(tracker, clock.now(), { json: tryParseJson(state.text), rawText: state.text, usage }, extra);
    if (reason === 'MAX_TOKENS') return { kind: 'truncated', rawText: state.text, usage, ...extra };
    if (reason !== undefined && REFUSAL_FINISH_REASONS.has(reason)) return { kind: 'refused', category: reason, usage, ...extra };
    if (reason !== undefined) return { kind: 'truncated', rawText: state.text, usage, rawStopReason: reason, ...extra };
    // The stream ended without a finish reason (e.g. an SSE error payload the SDK drops, or a cut stream): the provider
    // accepted the request and may have executed it, so this is never "not executed" (D3 rows 2/3). A captured SSE
    // error payload is attached (redacted) for diagnosis only; the classification does not change.
    return errorResult(new Error('stream ended without a finish reason'), state, tracker, aborted);
  };

  const generate = async (req: ModelRequest, ctx: GenerateContext): Promise<ModelResult> => {
    const thinkingLevel = assertRequest(req);
    const { trackedFetch, tracker, startedAt } = startTrackedCall(baseFetch(), clock, logger, ctx);
    const state: CallState = { text: '', terminalSeen: false, usageFinal: false };
    const onSseError = (e: SseErrorPayload): void => {
      state.sseError ??= e;
    };
    try {
      const stream = await makeClient(ctx.apiKey, trackedFetch, onSseError).models.generateContentStream(requestParams(req, thinkingLevel, ctx.signal));
      const onEachChunk = guardListener(logger, (chunk: ChunkLike) => {
        onChunk(chunk, state, ctx, tracker, startedAt);
      });
      for await (const chunk of stream) onEachChunk(chunk);
      return toResult(state, tracker, ctx.signal.aborted);
    } catch (err) {
      return errorResult(err, state, tracker, ctx.signal.aborted);
    }
  };

  /**
   * Gemini Developer API `countTokens` accepts only `contents` (the SDK throws for `systemInstruction` /
   * `generationConfig` outside Vertex), so the system prompt and the serialized schema are counted as extra text parts,
   * plus the fixed structured-output framing allowance the provider count cannot see.
   */
  const countTokens = async (req: ModelRequest, apiKey: string, signal: AbortSignal | undefined): Promise<number> => {
    const { fetch: trackedFetch } = createTrackedFetch(baseFetch(), { clock, logger });
    const res = await makeClient(apiKey, trackedFetch).models.countTokens({
      model: req.modelId,
      contents: [
        ...userContents(req),
        { role: 'user', parts: [{ text: req.system }, { text: JSON.stringify(req.outputSchema.jsonSchema) }] },
      ],
      ...(signal === undefined ? {} : { config: { abortSignal: signal } }),
    });
    if (typeof res.totalTokens !== 'number' || !Number.isSafeInteger(res.totalTokens) || res.totalTokens < 0) {
      throw new Error('countTokens returned no totalTokens');
    }
    return res.totalTokens + LOCAL_REQUEST_OVERHEAD_TOKENS;
  };

  // gemini-3.5-flash has no prompt-length price tier (no `priceCliffInputTokens`): a count failure falls back to the
  // normal local heuristic. A tiered model would get the conservative bound (04 ADR note "Count-failure fallback").
  const estimate = (req: ModelRequest, prices: ModelPrices, ctx?: EstimateContext): Promise<UsageEstimate> =>
    estimateWith({ providerId: 'gemini', logger, countTokens }, req, prices, ctx);

  return {
    providerId: 'gemini',
    capabilities: (modelId) => catalogCapabilities('gemini', modelId),
    estimate,
    generate,
    // No reconcile: the Gemini API has no endpoint that retrieves a past generateContent by responseId
    // (supportsRequestLookup: false), so unknown outcomes go to the user decision flow (§7.5), like Anthropic.
    // Thinking is always on: the lowest listed level + GEMINI_CONNECTION_TEST_MAX_OUTPUT_TOKENS (connectionTestRequest).
    testConnection: (ctx) => testConnectionAtLowestEffort('gemini', generate, ctx),
  };
}
