// 04 §D5: OpenAI Responses API adapter (`openai` SDK 7.25). SDK objects never leave this file (§8.3).
import OpenAI from 'openai';
import { RelayError, errors } from '@relay/contracts';
import type { Clock, Effort, ModelCapabilities, ModelPrices, ProviderId } from '@relay/contracts';
import { findCatalogEntry, priceCatalogVersionFor } from './catalog.js';
import { connectionTestRequest } from './connection-test.js';
import { mapProviderError } from './errors.js';
import type { SdkErrorClasses } from './errors.js';
import { buildEstimate, conservativeInputTokens, localEstimate } from './estimate.js';
import { NOOP_LOGGER, safeHook } from './safe-hook.js';
import { assertStrictCompatible } from './strict-schema.js';
import { createTrackedFetch } from './tracked-fetch.js';
import type { DispatchTracker } from './tracked-fetch.js';
import type {
  EstimateContext,
  GenerateContext,
  Logger,
  ModelRequest,
  ModelResult,
  ProviderAdapter,
  ReconciliationResult,
  UsageEstimate,
} from './types.js';
import { normalizeOpenAIUsage } from './usage.js';
import type { OpenAIUsageLike } from './usage.js';

/** Factory options. `fetch` is the injected base fetch; when omitted, `globalThis.fetch` is read at call time. */
export interface OpenAIAdapterOptions {
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
}

const REQUEST_TIMEOUT_MS = 600_000;
/** Explicit base URL so `OPENAI_BASE_URL` in the environment can never redirect requests (or keys). */
const API_BASE_URL = 'https://api.openai.com/v1';
/** Rough chars-per-token used only for progress display (never for money). */
const PROGRESS_CHARS_PER_TOKEN = 4;

const OPENAI_ERRORS: SdkErrorClasses = {
  APIError: OpenAI.APIError,
  APIUserAbortError: OpenAI.APIUserAbortError,
  APIConnectionError: OpenAI.APIConnectionError,
  RateLimitError: OpenAI.RateLimitError,
  AuthenticationError: OpenAI.AuthenticationError,
  PermissionDeniedError: OpenAI.PermissionDeniedError,
  NotFoundError: OpenAI.NotFoundError,
  BadRequestError: OpenAI.BadRequestError,
  UnprocessableEntityError: OpenAI.UnprocessableEntityError,
  InternalServerError: OpenAI.InternalServerError,
};

// Structural views of the SDK response/events, so SDK types stay inside this module.
interface ContentLike {
  readonly type: string;
  readonly text?: string;
  readonly refusal?: string;
}
interface OutputItemLike {
  readonly type: string;
  readonly content?: readonly ContentLike[] | null;
}
interface ResponseLike {
  readonly id: string;
  readonly status?: string | null;
  readonly output?: readonly OutputItemLike[] | null;
  readonly usage?: OpenAIUsageLike | null;
  readonly incomplete_details?: { readonly reason?: string | null } | null;
  readonly error?: unknown;
  readonly service_tier?: string | null;
}
interface StreamEventLike {
  readonly type: string;
  readonly response?: ResponseLike;
  readonly delta?: unknown;
}

const TERMINAL_EVENTS: ReadonlySet<string> = new Set(['response.completed', 'response.incomplete', 'response.failed']);
const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  'response.created',
  'response.queued',
  'response.in_progress',
  ...TERMINAL_EVENTS,
]);

interface CallState {
  providerResponseId?: string;
  /** Latest lifecycle snapshot (usage for `partialUsage`). */
  latest?: ResponseLike;
  /** The raw `response.completed` / `.incomplete` / `.failed` payload, once seen. */
  terminal?: ResponseLike;
  outputChars: number;
}

/** Whether responses are stored on OpenAI for this request (project default `true`, 04 §D5). */
export function openAIStoreResponses(req: Pick<ModelRequest, 'providerOptions'>): boolean {
  return req.providerOptions?.openai?.storeResponses ?? true;
}

/**
 * Effective `supportsRequestLookup` for a request: an OpenAI response can only be retrieved after a crash when it was
 * stored (`providerOptions.openai.storeResponses`, default true). Other providers report the catalog value unchanged.
 */
export function supportsRequestLookupFor(
  providerId: ProviderId,
  capabilities: Pick<ModelCapabilities, 'supportsRequestLookup'>,
  providerOptions?: ModelRequest['providerOptions'],
): boolean {
  if (!capabilities.supportsRequestLookup) return false;
  return providerId !== 'openai' || (providerOptions?.openai?.storeResponses ?? true);
}

/**
 * Maps a Relay effort to an OpenAI `reasoning.effort`. Only levels the catalog lists for the model are sent; anything
 * else is blocked in capability validation (§8.4), so reaching here with an unlisted level is a programmer error.
 * @throws Error when `effort` is not listed for the model.
 */
export function mapEffort(effort: Effort, capabilities: Pick<ModelCapabilities, 'effortLevels'>): Effort {
  if (!capabilities.effortLevels.includes(effort)) throw new Error(`effort ${effort} is not supported by this model`);
  return effort; // Relay's levels are a subset of OpenAI's ReasoningEffort ('none'|'minimal'|'low'|…|'max')
}

/**
 * The only service tier Relay requests: the catalog prices are the standard (`default`) tier. `auto` would let a project
 * setting route calls to flex/priority/scale tiers at different prices; the response echoes the tier actually used.
 */
export const OPENAI_SERVICE_TIER = 'default' as const;

/**
 * Headers that pin authentication per request. `RequestOptions.headers` are applied LAST by the SDK, after
 * `defaultHeaders` (which is where the SDK merges `OPENAI_CUSTOM_HEADERS` from the environment), so nothing from the
 * environment can replace the user's key or add an organization/project. `null` removes a header.
 */
function pinnedAuthHeaders(apiKey: string): Record<string, string | null> {
  return { Authorization: `Bearer ${apiKey}`, 'OpenAI-Organization': null, 'OpenAI-Project': null };
}

/**
 * Default headers that strip any env-supplied (`OPENAI_CUSTOM_HEADERS`) `Authorization`, `OpenAI-Organization` or
 * `OpenAI-Project` header (case-insensitive; the SDK merges env headers before these). Defense in depth next to
 * {@link pinnedAuthHeaders}.
 */
const STRIPPED_ENV_HEADERS: Readonly<Record<string, null>> = Object.freeze({
  Authorization: null,
  'OpenAI-Organization': null,
  'OpenAI-Project': null,
});

/** Whether a response's reported `service_tier` means it was billed at other than the standard (catalog) prices. */
export function isPriceTierMismatch(serviceTier: string | null | undefined): boolean {
  // Absent: the tier was not reported (the request asked for `default`); only an explicit other tier is a mismatch.
  return serviceTier != null && serviceTier !== OPENAI_SERVICE_TIER;
}

/** Request body per 04 §D5. Only attemptId + runId are sent as metadata; stepKey/purpose never leave the machine. */
function requestParams(req: ModelRequest, effort: Effort | undefined) {
  return {
    model: req.modelId,
    instructions: req.system,
    input: req.messages.map((m) => ({ role: m.role, content: m.content })),
    max_output_tokens: req.maxOutputTokens,
    text: {
      format: {
        type: 'json_schema' as const,
        name: openAISchemaName(req.outputSchema.name),
        schema: { ...req.outputSchema.jsonSchema },
        strict: true,
      },
    },
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    store: openAIStoreResponses(req),
    service_tier: OPENAI_SERVICE_TIER,
    metadata: { relay_attempt_id: req.metadata.attemptId, relay_run_id: req.metadata.runId },
  };
}

/** OpenAI format names allow `[a-zA-Z0-9_-]{1,64}` only (`findings.v1` → `findings_v1`). */
export function openAISchemaName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned === '' ? 'output' : cleaned;
}

function messageContents(resp: ResponseLike): ContentLike[] {
  return (resp.output ?? []).filter((o) => o.type === 'message').flatMap((o) => [...(o.content ?? [])]);
}

function outputText(resp: ResponseLike): string {
  return messageContents(resp)
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text ?? '')
    .join('');
}

function hasRefusal(resp: ResponseLike): boolean {
  return messageContents(resp).some((c) => c.type === 'refusal');
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function deltaLength(delta: unknown): number {
  return typeof delta === 'string' ? delta.length : 0;
}

/**
 * Creates the OpenAI adapter. A client is constructed per call (the key is never retained) with SDK retries disabled
 * (ADR-013), environment overrides pinned, and the per-call tracked fetch (04 §D3).
 */
export function createOpenAIAdapter(opts: OpenAIAdapterOptions): ProviderAdapter {
  const { clock } = opts;
  const logger = opts.logger ?? NOOP_LOGGER;
  const baseFetch = (): typeof fetch => opts.fetch ?? globalThis.fetch; // read at call time, never at module load

  // Every env-sourced option is pinned explicitly (OPENAI_BASE_URL, OPENAI_ORG_ID, OPENAI_PROJECT_ID, OPENAI_ADMIN_KEY,
  // OPENAI_WEBHOOK_SECRET, OPENAI_LOG). The key comes only from the credential store via `apiKey`.
  const makeClient = (apiKey: string, trackedFetch: typeof fetch): OpenAI =>
    new OpenAI({
      apiKey,
      adminAPIKey: null,
      organization: null,
      project: null,
      webhookSecret: null,
      baseURL: API_BASE_URL,
      defaultHeaders: { ...STRIPPED_ENV_HEADERS },
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
      fetch: trackedFetch,
      logLevel: 'off',
    });

  const assertRequest = (req: ModelRequest): Effort | undefined => {
    if (req.providerId !== 'openai') throw new Error(`openai adapter got providerId ${req.providerId}`);
    assertStrictCompatible(req.outputSchema.jsonSchema);
    if (req.effort === undefined) return undefined;
    const entry = findCatalogEntry('openai', req.modelId);
    // Unknown models are rejected by capability validation first; without an entry the level is passed through.
    return entry === undefined ? req.effort : mapEffort(req.effort, entry.capabilities);
  };

  const requestIdOf = (tracker: DispatchTracker, sdkRequestId: string | null | undefined): string | undefined =>
    tracker.requestId ?? sdkRequestId ?? undefined;

  const onEvent = (event: StreamEventLike, state: CallState, ctx: GenerateContext, tracker: DispatchTracker, startedAt: number): void => {
    if (LIFECYCLE_EVENTS.has(event.type) && event.response !== undefined) {
      state.latest = event.response;
      if (TERMINAL_EVENTS.has(event.type)) state.terminal = event.response;
    }
    if (event.type === 'response.created' && event.response !== undefined) {
      const providerResponseId = event.response.id;
      state.providerResponseId = providerResponseId;
      const providerRequestId = requestIdOf(tracker, undefined);
      safeHook('onResponseId', () => ctx.hooks?.onResponseId?.({ providerResponseId, ...(providerRequestId === undefined ? {} : { providerRequestId }) }), logger);
      return;
    }
    if (event.type !== 'response.output_text.delta' && event.type !== 'response.refusal.delta') return;
    state.outputChars += deltaLength(event.delta);
    const outputTokensSoFar = Math.ceil(state.outputChars / PROGRESS_CHARS_PER_TOKEN);
    safeHook('onProgress', () => ctx.hooks?.onProgress?.({ outputTokensSoFar, elapsedMs: clock.now() - startedAt }), logger);
  };

  /** D3 row 2: a terminal `response.failed`, or a stream that ended without a terminal status, after the first byte. */
  const unknownOutcome = (resp: ResponseLike, tracker: DispatchTracker, aborted: boolean): ModelResult => {
    const status = resp.status ?? 'none';
    const body = resp.error ?? { status };
    const partialUsage = resp.usage == null ? undefined : normalizeOpenAIUsage(resp.usage);
    return mapProviderError(new OpenAI.APIError(undefined, body, `response ${status}`, undefined), {
      providerId: 'openai',
      tracker,
      classes: OPENAI_ERRORS,
      clock,
      aborted,
      providerResponseId: resp.id,
      ...(partialUsage === undefined ? {} : { partialUsage }),
    });
  };

  const toResult = (resp: ResponseLike, tracker: DispatchTracker, sdkRequestId: string | null | undefined, aborted: boolean): ModelResult => {
    const usage = normalizeOpenAIUsage(resp.usage);
    const requestId = requestIdOf(tracker, sdkRequestId);
    const extra = {
      rawUsage: resp.usage ?? null,
      providerResponseId: resp.id,
      ...(requestId === undefined ? {} : { providerRequestId: requestId }),
      // A terminal response without `usage` must not read as a known $0 (the zeros above are placeholders).
      ...(resp.usage == null ? { usageKnown: false } : {}),
      ...(isPriceTierMismatch(resp.service_tier) ? { priceTierMismatch: true } : {}),
    };
    const rawText = outputText(resp);
    if (resp.status === 'completed') {
      if (hasRefusal(resp)) return { kind: 'refused', category: 'refusal', usage, ...extra };
      const now = clock.now();
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
    if (resp.status === 'incomplete') {
      const reason = resp.incomplete_details?.reason ?? 'unknown';
      if (reason === 'content_filter') return { kind: 'refused', category: 'content_filter', usage, ...extra };
      if (reason === 'max_output_tokens') return { kind: 'truncated', rawText, usage, ...extra };
      return { kind: 'truncated', rawText, usage, rawStopReason: `incomplete:${reason}`, ...extra };
    }
    return unknownOutcome(resp, tracker, aborted); // failed / cancelled / in_progress / queued / missing
  };

  const generate = async (req: ModelRequest, ctx: GenerateContext): Promise<ModelResult> => {
    const effort = assertRequest(req);
    const startedAt = clock.now();
    const { fetch: trackedFetch, tracker } = createTrackedFetch(baseFetch(), {
      clock,
      logger,
      onDispatched: () => ctx.hooks?.onDispatched?.(),
    });
    const state: CallState = { outputChars: 0 };
    try {
      const stream = makeClient(ctx.apiKey, trackedFetch).responses.stream(requestParams(req, effort), {
        signal: ctx.signal,
        headers: pinnedAuthHeaders(ctx.apiKey),
      });
      stream.on('event', (event) => {
        try {
          onEvent(event, state, ctx, tracker, startedAt);
        } catch (err) {
          logger.warn('provider.stream_listener_failed', { errorName: err instanceof Error ? err.name : typeof err });
        }
      });
      let final: (ResponseLike & { readonly _request_id?: string | null }) | undefined;
      try {
        final = await stream.finalResponse();
      } catch (err) {
        // The SDK JSON-parses strict output after a `completed` event and throws on malformed text; once a terminal
        // event arrived the outcome is known, so the raw terminal payload wins (malformed JSON → success, json undefined).
        if (state.terminal === undefined || state.terminal.status === 'failed') throw err;
      }
      const resp = state.terminal ?? final;
      if (resp === undefined) throw new Error('stream ended without a response');
      return toResult(resp, tracker, final?._request_id, ctx.signal.aborted);
    } catch (err) {
      return mapProviderError(err, {
        providerId: 'openai',
        tracker,
        classes: OPENAI_ERRORS,
        clock,
        aborted: ctx.signal.aborted,
        ...(state.providerResponseId === undefined ? {} : { providerResponseId: state.providerResponseId }),
        ...(state.latest?.usage == null ? {} : { partialUsage: normalizeOpenAIUsage(state.latest.usage) }),
      });
    }
  };

  const countTokens = async (req: ModelRequest, apiKey: string, signal: AbortSignal | undefined): Promise<number> => {
    const { fetch: trackedFetch } = createTrackedFetch(baseFetch(), { clock, logger });
    const params = requestParams(req, undefined);
    const res = await makeClient(apiKey, trackedFetch).responses.inputTokens.count(
      { model: params.model, instructions: params.instructions, input: params.input, text: params.text },
      { headers: pinnedAuthHeaders(apiKey), ...(signal === undefined ? {} : { signal }) },
    );
    return res.input_tokens;
  };

  const estimate = async (req: ModelRequest, prices: ModelPrices, ctx?: EstimateContext): Promise<UsageEstimate> => {
    const entry = findCatalogEntry('openai', req.modelId);
    const version = priceCatalogVersionFor('openai', req.modelId, prices, ctx?.priceCatalogVersion);
    if (ctx?.apiKey !== undefined && entry?.capabilities.supportsTokenCounting === true) {
      try {
        const inputTokens = await countTokens(req, ctx.apiKey, ctx.signal);
        return buildEstimate(inputTokens, req, prices, 'provider_count', version);
      } catch (err) {
        logger.warn('provider.count_tokens_failed', { providerId: 'openai', errorName: err instanceof Error ? err.name : typeof err });
        // Price cliff (catalog `maxInputTokens`, e.g. 272K for gpt-6.1-sol): the chars/3.2 heuristic can undercount
        // dense scripts (CJK ≈ 1+ token per character) and slip a long-context prompt past capability validation into
        // the 2x tier. Without a provider count, bound it at one token per UTF-16 code unit instead.
        if (entry.capabilities.maxInputTokens !== undefined) {
          return buildEstimate(conservativeInputTokens(req), req, prices, 'local_estimate', version);
        }
      }
    }
    return localEstimate(req, prices, version);
  };

  const reconcile = async (
    ids: { readonly providerResponseId: string },
    ctx: { readonly apiKey: string; readonly signal: AbortSignal },
  ): Promise<ReconciliationResult> => {
    const { fetch: trackedFetch, tracker } = createTrackedFetch(baseFetch(), { clock, logger });
    let resp: ResponseLike;
    try {
      resp = await makeClient(ctx.apiKey, trackedFetch).responses.retrieve(
        ids.providerResponseId,
        {},
        { signal: ctx.signal, headers: pinnedAuthHeaders(ctx.apiKey) },
      );
    } catch (err) {
      if (err instanceof OpenAI.NotFoundError) return { kind: 'not_found' };
      const mapped = mapProviderError(err, { providerId: 'openai', tracker, classes: OPENAI_ERRORS, clock, aborted: ctx.signal.aborted });
      throw new RelayError(mapped.error);
    }
    const usage = resp.usage == null ? undefined : normalizeOpenAIUsage(resp.usage);
    // `usageKnown: false` keeps the liability: a missing usage block is NOT a known $0 (04 §D5).
    const usageKnown = usage !== undefined;
    switch (resp.status) {
      case 'completed':
        return {
          kind: 'completed',
          json: tryParseJson(outputText(resp)),
          usage: usage ?? normalizeOpenAIUsage(null),
          rawUsage: resp.usage ?? null,
          usageKnown,
        };
      case 'queued':
      case 'in_progress':
        return { kind: 'in_progress' };
      case 'failed':
      case 'cancelled':
      case 'incomplete':
      case null:
      case undefined:
      default:
        // failed / cancelled / incomplete: no usable output; the usage (if any) settles the liability, otherwise the
        // engine keeps it (usageKnown: false), since the provider may still have billed the call.
        return usage === undefined ? { kind: 'failed', usageKnown } : { kind: 'failed', usage, usageKnown };
    }
  };

  const capabilities = (modelId: string): Promise<ModelCapabilities> => {
    const entry = findCatalogEntry('openai', modelId);
    if (entry === undefined) {
      return Promise.reject(new RelayError(errors.modelUnsupported({ providerId: 'openai', modelId, reason: 'not_in_catalog' })));
    }
    return Promise.resolve(entry.capabilities);
  };

  const lowestEffort = (modelId: string): Effort | undefined => findCatalogEntry('openai', modelId)?.capabilities.effortLevels[0];

  return {
    providerId: 'openai',
    capabilities,
    estimate,
    generate,
    reconcile,
    testConnection: (ctx) => {
      // Reasoning is always on for current models: the lowest listed effort plus a 256-token allowance
      // (OPENAI_CONNECTION_TEST_MAX_OUTPUT_TOKENS, set by connectionTestRequest) lets the model finish its answer; a
      // `truncated` answer still proves the key and model work.
      const effort = lowestEffort(ctx.modelId);
      const req = connectionTestRequest('openai', ctx.modelId);
      return generate(effort === undefined ? req : { ...req, effort }, { apiKey: ctx.apiKey, signal: ctx.signal });
    },
  };
}

