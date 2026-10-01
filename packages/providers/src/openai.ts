// 04 §D5: OpenAI Responses API adapter (`openai` SDK 7.25). SDK objects never leave this file (§8.3).
import OpenAI from 'openai';
import { PROVIDER_REQUEST_TIMEOUT_MS, RelayError } from '@relay/contracts';
import type { Effort, ModelCapabilities, ModelPrices, ProviderId } from '@relay/contracts';
import { emitProgress, emitResponseId, guardListener, progressTokens, startTrackedCall } from './adapter-kit.js';
import { findCatalogEntry } from './catalog.js';
import { catalogCapabilities, estimateWith, testConnectionAtLowestEffort } from './catalog-facet.js';
import { mapProviderError } from './errors.js';
import { OPENAI_ERRORS, OPENAI_SERVICE_TIER, reconcileResult, toResult } from './openai-results.js';
import type { ResponseLike } from './openai-results.js';
import { NOOP_LOGGER } from './safe-hook.js';
import { assertStrictCompatible } from './strict-schema.js';
import { createTrackedFetch } from './tracked-fetch.js';
import type { DispatchTracker } from './tracked-fetch.js';
import type {
  EstimateContext,
  GenerateContext,
  ModelRequest,
  ModelResult,
  ProviderAdapter,
  ProviderAdapterOptions,
  ReconciliationResult,
  UsageEstimate,
} from './types.js';
import { normalizeOpenAIUsage } from './usage.js';

export { OPENAI_SERVICE_TIER, isPriceTierMismatch } from './openai-results.js';

/** Factory options (the shared {@link ProviderAdapterOptions}). */
export type OpenAIAdapterOptions = ProviderAdapterOptions;

/** Explicit base URL so `OPENAI_BASE_URL` in the environment can never redirect requests (or keys). */
const API_BASE_URL = 'https://api.openai.com/v1';

// Structural view of the SDK stream events, so SDK types stay inside the openai modules.
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
      timeout: PROVIDER_REQUEST_TIMEOUT_MS, // ADR-013: the engine owns every retry; one HTTP call = one Attempt
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

  const onEvent = (event: StreamEventLike, state: CallState, ctx: GenerateContext, tracker: DispatchTracker, startedAt: number): void => {
    if (LIFECYCLE_EVENTS.has(event.type) && event.response !== undefined) {
      state.latest = event.response;
      if (TERMINAL_EVENTS.has(event.type)) state.terminal = event.response;
    }
    if (event.type === 'response.created' && event.response !== undefined) {
      state.providerResponseId = event.response.id;
      // Only the tracked fetch's `x-request-id` exists this early (the SDK's `_request_id` arrives with the final response).
      emitResponseId(ctx, logger, event.response.id, tracker.requestId);
      return;
    }
    if (event.type !== 'response.output_text.delta' && event.type !== 'response.refusal.delta') return;
    state.outputChars += deltaLength(event.delta);
    emitProgress(ctx, logger, clock, startedAt, progressTokens(state.outputChars));
  };

  const generate = async (req: ModelRequest, ctx: GenerateContext): Promise<ModelResult> => {
    const effort = assertRequest(req);
    const { trackedFetch, tracker, startedAt } = startTrackedCall(baseFetch(), clock, logger, ctx);
    const state: CallState = { outputChars: 0 };
    try {
      const stream = makeClient(ctx.apiKey, trackedFetch).responses.stream(requestParams(req, effort), {
        signal: ctx.signal,
        headers: pinnedAuthHeaders(ctx.apiKey),
      });
      stream.on(
        'event',
        guardListener(logger, (event: StreamEventLike) => {
          onEvent(event, state, ctx, tracker, startedAt);
        }),
      );
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
      return toResult(resp, { tracker, clock, aborted: ctx.signal.aborted, sdkRequestId: final?._request_id });
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

  // The price cliff (gpt-6.1-sol bills prompts above 272K at 2x input) is `priceCliffInputTokens` in the catalog;
  // `estimateWith` uses the conservative bound on a count failure for such models (04 ADR note "Count-failure fallback").
  const estimate = (req: ModelRequest, prices: ModelPrices, ctx?: EstimateContext): Promise<UsageEstimate> =>
    estimateWith({ providerId: 'openai', logger, countTokens }, req, prices, ctx);

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
      throw new RelayError(mapped.error, { cause: err });
    }
    return reconcileResult(resp);
  };

  return {
    providerId: 'openai',
    capabilities: (modelId) => catalogCapabilities('openai', modelId),
    estimate,
    generate,
    reconcile,
    // Reasoning is always on: the lowest listed effort + OPENAI_CONNECTION_TEST_MAX_OUTPUT_TOKENS (connectionTestRequest).
    testConnection: (ctx) => testConnectionAtLowestEffort('openai', generate, ctx),
  };
}

