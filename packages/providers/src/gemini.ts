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
import { ApiError, GoogleGenAI, ServiceTier, ThinkingLevel } from '@google/genai';
import { RelayError, errors } from '@relay/contracts';
import type { Clock, Effort, ModelCapabilities, ModelPrices } from '@relay/contracts';
import { findCatalogEntry, priceCatalogVersionFor } from './catalog.js';
import { connectionTestRequest } from './connection-test.js';
import { mapProviderError } from './errors.js';
import type { SdkErrorClasses } from './errors.js';
import { LOCAL_REQUEST_OVERHEAD_TOKENS, buildEstimate, conservativeInputTokens, localEstimate } from './estimate.js';
import { NOOP_LOGGER, safeHook } from './safe-hook.js';
import { abortError, createTrackedFetch, isSignalAborted } from './tracked-fetch.js';
import type { DispatchTracker } from './tracked-fetch.js';
import type {
  EstimateContext,
  GenerateContext,
  Logger,
  ModelRequest,
  ModelResult,
  NormalizedUsage,
  ProviderAdapter,
  UsageEstimate,
} from './types.js';
import { normalizeGeminiUsage } from './usage.js';
import type { GeminiUsageLike } from './usage.js';

/** Factory options. `fetch` is the injected base fetch; when omitted, `globalThis.fetch` is read at call time. */
export interface GeminiAdapterOptions {
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
}

/** Explicit base URL + version so GOOGLE_GEMINI_BASE_URL / setDefaultBaseUrls can never redirect requests (or keys). */
const API_BASE_URL = 'https://generativelanguage.googleapis.com/';
const API_VERSION = 'v1beta';
const API_KEY_HEADER = 'x-goog-api-key';
/** Rough chars-per-token used only for progress display (never for money). */
const PROGRESS_CHARS_PER_TOKEN = 4;
const MS_PER_SECOND = 1000;

// ---- Error classes: the SDK has one `ApiError`; the D3 chain needs the status families as classes. ----

/** A Gemini HTTP error status, normalized for the D3 chain (`status`, `error` = parsed body, `headers`, `type`). */
class GeminiApiError extends Error {
  readonly status: number;
  readonly error: unknown;
  readonly headers: Headers | undefined;
  readonly type: string | undefined;
  constructor(status: number, message: string, body: unknown, type: string | undefined, headers: Headers | undefined) {
    super(message);
    this.name = 'GeminiApiError';
    this.status = status;
    this.error = body;
    this.type = type;
    this.headers = headers;
  }
}
class GeminiBadRequestError extends GeminiApiError {}
class GeminiAuthenticationError extends GeminiApiError {}
class GeminiPermissionDeniedError extends GeminiApiError {}
class GeminiNotFoundError extends GeminiApiError {}
class GeminiUnprocessableEntityError extends GeminiApiError {}
class GeminiRateLimitError extends GeminiApiError {}
class GeminiInternalServerError extends GeminiApiError {}
/** The base fetch rejected (DNS, refused, TLS, reset, …); phase comes from the tracker (D3 rows 4–5). */
class GeminiConnectionError extends Error {
  constructor(cause: unknown) {
    super('connection error', { cause });
    this.name = 'GeminiConnectionError';
  }
}
/** Never thrown: aborts are detected through our own `AbortSignal` (row 1 via `aborted`). */
class GeminiUserAbortError extends Error {}

const GEMINI_ERRORS: SdkErrorClasses = {
  APIError: GeminiApiError,
  APIUserAbortError: GeminiUserAbortError,
  APIConnectionError: GeminiConnectionError,
  RateLimitError: GeminiRateLimitError,
  AuthenticationError: GeminiAuthenticationError,
  PermissionDeniedError: GeminiPermissionDeniedError,
  NotFoundError: GeminiNotFoundError,
  BadRequestError: GeminiBadRequestError,
  UnprocessableEntityError: GeminiUnprocessableEntityError,
  InternalServerError: GeminiInternalServerError,
};

/** `google.rpc.Status` as the Gemini API returns it (`{ error: { code, message, status, details } }`). */
interface RpcErrorBody {
  readonly error?: {
    readonly message?: unknown;
    readonly status?: unknown;
    readonly details?: unknown;
  };
}
interface RpcDetail {
  readonly '@type'?: unknown;
  readonly reason?: unknown;
  readonly retryDelay?: unknown;
}

/** Google API-key rejections arrive as HTTP 400 INVALID_ARGUMENT with this structured `ErrorInfo.reason`. */
const API_KEY_REASONS: ReadonlySet<string> = new Set(['API_KEY_INVALID', 'API_KEY_EXPIRED']);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function rpcDetails(body: unknown): RpcDetail[] {
  const details = (body as RpcErrorBody | undefined)?.error?.details;
  return Array.isArray(details) ? details.filter((d): d is RpcDetail => typeof d === 'object' && d !== null) : [];
}

/** `RetryInfo.retryDelay` ("12s", "1.5s") as a `retry-after` header, so the D3 chain can honor it. */
function retryAfterHeaders(details: readonly RpcDetail[]): Headers | undefined {
  for (const d of details) {
    if (typeof d['@type'] !== 'string' || !d['@type'].endsWith('RetryInfo') || typeof d.retryDelay !== 'string') continue;
    const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay.trim());
    if (m?.[1] !== undefined) return new Headers({ 'retry-after': String(Math.ceil(Number(m[1]) * MS_PER_SECOND) / MS_PER_SECOND) });
  }
  return undefined;
}

function classFor(status: number, details: readonly RpcDetail[]): typeof GeminiApiError {
  if (details.some((d) => typeof d.reason === 'string' && API_KEY_REASONS.has(d.reason))) return GeminiAuthenticationError;
  if (status === 400) return GeminiBadRequestError;
  if (status === 401) return GeminiAuthenticationError;
  if (status === 403) return GeminiPermissionDeniedError;
  if (status === 404) return GeminiNotFoundError;
  if (status === 422) return GeminiUnprocessableEntityError;
  if (status === 429) return GeminiRateLimitError;
  if (status >= 500) return GeminiInternalServerError;
  return GeminiApiError;
}

/** Converts the SDK's `ApiError` into the typed family above; anything else passes through unchanged. */
export function toTypedGeminiError(err: unknown): unknown {
  if (!(err instanceof ApiError)) return err;
  const body = parseJson(err.message) ?? { error: { message: err.message } };
  const rpc = (body as RpcErrorBody).error;
  const message = typeof rpc?.message === 'string' ? rpc.message : err.message;
  const type = typeof rpc?.status === 'string' ? rpc.status : undefined;
  const details = rpcDetails(body);
  const Cls = classFor(err.status, details);
  return new Cls(err.status, message, body, type, retryAfterHeaders(details));
}

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

/** The `google.rpc.Status` fields kept from a mid-stream SSE error event (redacted before storage). */
interface SseErrorPayload {
  readonly code?: number;
  readonly status?: string;
  readonly message?: string;
}

const SSE_EVENT_DELIMITER = /\r\n\r\n|\n\n|\r\r/;
const SSE_ERROR_DATA = /^\{\s*"error"\s*:/;

/** Parses one SSE event; returns its error payload when the `data:` is a `{"error":{…}}` object. */
function sseErrorOf(eventText: string): SseErrorPayload | undefined {
  const data = eventText
    .split(/\r\n|\n|\r/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n');
  if (!SSE_ERROR_DATA.test(data)) return undefined;
  const parsed = parseJson(data) as { error?: unknown } | undefined;
  const e = parsed?.error;
  if (typeof e !== 'object' || e === null) return undefined;
  const { code, status, message } = e as { code?: unknown; status?: unknown; message?: unknown };
  return {
    ...(typeof code === 'number' ? { code } : {}),
    ...(typeof status === 'string' ? { status } : {}),
    ...(typeof message === 'string' ? { message } : {}),
  };
}

/**
 * Passes a 2xx stream body through unchanged while watching for SSE `data: {"error":…}` events: the SDK parses such an
 * event into an empty chunk (the converter keeps only known response fields), so the error is otherwise lost.
 */
function watchSseErrors(response: Response, onError: (e: SseErrorPayload) => void): Response {
  if (response.body === null || response.status < 200 || response.status >= 300) return response;
  const decoder = new TextDecoder();
  let buffer = '';
  const scan = (final: boolean): void => {
    const parts = buffer.split(SSE_EVENT_DELIMITER);
    buffer = final ? '' : (parts.pop() ?? '');
    for (const part of parts) {
      const e = sseErrorOf(part);
      if (e !== undefined) onError(e);
    }
  };
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        scan(false);
      },
      flush() {
        buffer += decoder.decode();
        scan(true);
      },
    }),
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
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

/** Vertex traffic types billed at the standard (catalog) prices; any other reported type is a price-tier mismatch. */
const STANDARD_TRAFFIC: ReadonlySet<string> = new Set(['ON_DEMAND', 'TRAFFIC_TYPE_UNSPECIFIED']);
/**
 * Gemini Developer API service tiers billed at the standard (catalog) prices (SDK `ServiceTier`: `unspecified` is
 * "default service tier, which is standard"). Compared case-insensitively, tolerating a `SERVICE_TIER_` enum prefix.
 */
const STANDARD_SERVICE_TIERS: ReadonlySet<string> = new Set(['standard', 'unspecified']);

function isStandardServiceTier(tier: string): boolean {
  return STANDARD_SERVICE_TIERS.has(tier.toLowerCase().replace(/^service_tier_/, ''));
}

/**
 * Whether the reported usage says the call was billed other than at the standard tier: a Developer API
 * `usageMetadata.serviceTier` other than standard/unspecified (flex, priority, …), or a Vertex `trafficType` other than
 * on-demand/unspecified.
 */
export function isGeminiPriceTierMismatch(usage: { readonly trafficType?: string; readonly serviceTier?: string } | undefined): boolean {
  if (usage === undefined) return false;
  if (typeof usage.serviceTier === 'string' && !isStandardServiceTier(usage.serviceTier)) return true;
  return typeof usage.trafficType === 'string' && !STANDARD_TRAFFIC.has(usage.trafficType);
}

const THINKING_LEVELS: Readonly<Partial<Record<Effort, ThinkingLevel>>> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/**
 * Maps a Relay effort to a Gemini `thinkingLevel`. Only levels the catalog lists for the model (and Gemini has) are
 * sent; anything else is blocked in capability validation (§8.4), so reaching here with one is a programmer error.
 * @throws Error when `effort` is not supported.
 */
export function mapGeminiEffort(effort: Effort, capabilities: Pick<ModelCapabilities, 'effortLevels'>): ThinkingLevel {
  const level = THINKING_LEVELS[effort];
  if (level === undefined || !capabilities.effortLevels.includes(effort)) throw new Error(`effort ${effort} is not supported by this model`);
  return level;
}

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

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
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

/** The mapper's `streamError`: the redacted `{code,status,message}` body plus the RPC status as `errorType`. */
function streamErrorOf(e: SseErrorPayload): { readonly providerError: unknown; readonly errorType?: string } {
  return { providerError: { error: e }, ...(e.status === undefined ? {} : { errorType: e.status }) };
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
      const providerResponseId = chunk.responseId;
      state.providerResponseId = providerResponseId;
      const providerRequestId = tracker.requestId;
      safeHook('onResponseId', () => ctx.hooks?.onResponseId?.({ providerResponseId, ...(providerRequestId === undefined ? {} : { providerRequestId }) }), logger);
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
    const outputTokensSoFar = Math.ceil(state.text.length / PROGRESS_CHARS_PER_TOKEN);
    safeHook('onProgress', () => ctx.hooks?.onProgress?.({ outputTokensSoFar, elapsedMs: clock.now() - startedAt }), logger);
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
      ...(state.providerResponseId === undefined ? {} : { providerResponseId: state.providerResponseId }),
      ...(tracker.requestId === undefined ? {} : { providerRequestId: tracker.requestId }),
      ...(usageIsKnown(state) ? {} : { usageKnown: false }),
      ...(isGeminiPriceTierMismatch(state.usage) ? { priceTierMismatch: true } : {}),
    };
    if (state.blockReason !== undefined && state.finishReason === undefined) {
      return { kind: 'refused', category: `prompt_blocked:${state.blockReason}`, usage, ...extra };
    }
    const reason = state.finishReason;
    if (reason === 'STOP') {
      const now = clock.now();
      const start = tracker.dispatchedAt ?? now;
      return {
        kind: 'success',
        json: tryParseJson(state.text),
        rawText: state.text,
        usage,
        stopReason: 'end_turn',
        latencyMs: now - start,
        ...(tracker.firstByteAt === undefined ? {} : { firstByteMs: tracker.firstByteAt - start }),
        ...extra,
      };
    }
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
    const startedAt = clock.now();
    const { fetch: trackedFetch, tracker } = createTrackedFetch(baseFetch(), {
      clock,
      logger,
      onDispatched: () => ctx.hooks?.onDispatched?.(),
    });
    const state: CallState = { text: '', terminalSeen: false, usageFinal: false };
    const onSseError = (e: SseErrorPayload): void => {
      state.sseError ??= e;
    };
    try {
      const stream = await makeClient(ctx.apiKey, trackedFetch, onSseError).models.generateContentStream(requestParams(req, thinkingLevel, ctx.signal));
      for await (const chunk of stream) {
        try {
          onChunk(chunk, state, ctx, tracker, startedAt);
        } catch (err) {
          logger.warn('provider.stream_listener_failed', { errorName: err instanceof Error ? err.name : typeof err });
        }
      }
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

  const estimate = async (req: ModelRequest, prices: ModelPrices, ctx?: EstimateContext): Promise<UsageEstimate> => {
    const entry = findCatalogEntry('gemini', req.modelId);
    const version = priceCatalogVersionFor('gemini', req.modelId, prices, ctx?.priceCatalogVersion);
    if (ctx?.apiKey !== undefined && entry?.capabilities.supportsTokenCounting === true) {
      try {
        const inputTokens = await countTokens(req, ctx.apiKey, ctx.signal);
        return buildEstimate(inputTokens, req, prices, 'provider_count', version);
      } catch (err) {
        logger.warn('provider.count_tokens_failed', { providerId: 'gemini', errorName: err instanceof Error ? err.name : typeof err });
        // Price cliff (Gemini Pro-class models bill prompts above 200K tokens at a higher tier; the catalog then caps
        // `maxInputTokens` below the threshold): the chars/3.2 heuristic can undercount dense scripts and slip a
        // long-context prompt past capability validation. Without a count, bound it at one token per UTF-16 code unit.
        if (entry.capabilities.maxInputTokens !== undefined) {
          return buildEstimate(conservativeInputTokens(req), req, prices, 'local_estimate', version);
        }
      }
    }
    return localEstimate(req, prices, version);
  };

  const capabilities = (modelId: string): Promise<ModelCapabilities> => {
    const entry = findCatalogEntry('gemini', modelId);
    if (entry === undefined) {
      return Promise.reject(new RelayError(errors.modelUnsupported({ providerId: 'gemini', modelId, reason: 'not_in_catalog' })));
    }
    return Promise.resolve(entry.capabilities);
  };

  const lowestEffort = (modelId: string): Effort | undefined => findCatalogEntry('gemini', modelId)?.capabilities.effortLevels[0];

  return {
    providerId: 'gemini',
    capabilities,
    estimate,
    generate,
    // No reconcile: the Gemini API has no endpoint that retrieves a past generateContent by responseId
    // (supportsRequestLookup: false), so unknown outcomes go to the user decision flow (§7.5), like Anthropic.
    testConnection: (ctx) => {
      // Thinking is always on: the lowest listed level plus a 256-token allowance (GEMINI_CONNECTION_TEST_MAX_OUTPUT_TOKENS)
      // lets the model answer; a `truncated` answer still proves the key and model work.
      const effort = lowestEffort(ctx.modelId);
      const req = connectionTestRequest('gemini', ctx.modelId);
      return generate(effort === undefined ? req : { ...req, effort }, { apiKey: ctx.apiKey, signal: ctx.signal });
    },
  };
}
