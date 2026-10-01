import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayError, catalogFileSchema, mulDivCeil } from '@relay/contracts';
import type { ModelPrices } from '@relay/contracts';
import testCatalog from '../catalog/test-fixture.json' with { type: 'json' };
import { createMockFetch, jsonResponse, sseResponse, tickingClock } from './__fixtures__/mock-fetch.js';
import type { MockFetchCall } from './__fixtures__/mock-fetch.js';
import { createAnthropicAdapter } from './anthropic.js';
import * as catalogModule from './catalog.js';
import { findCatalogEntry, maxProviderPrices } from './catalog.js';
import { LOCAL_REQUEST_OVERHEAD_TOKENS, conservativeInputTokens, localInputTokens } from './estimate.js';
import { INPUT_SPLIT_ROUNDING_SLACK_MICROUSD, computeCost, upperBound } from './pricing.js';
import type { GenerateHooks, ModelRequest, ModelResult } from './types.js';

const sse = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/anthropic/${name}.sse`, import.meta.url), 'utf8');

const PRICES: ModelPrices = catalogFileSchema.parse(testCatalog).entries[0]!.prices;
const API_KEY = 'sk-ant-api03-test-key-not-real-000000000000';

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  providerId: 'anthropic',
  modelId: 'claude-opus-5-5',
  system: 'You are the reviewer.',
  messages: [{ role: 'user', content: 'Review the selected files.' }],
  outputSchema: { name: 'findings.v1', jsonSchema: { type: 'object', properties: { summary: { type: 'string' } } } },
  maxOutputTokens: 8000,
  refusalFallback: 'off',
  metadata: { attemptId: 'att_secret_attempt', runId: 'run_secret_run', stepKey: 'review', purpose: 'initial' },
  ...over,
});

const serve = (name: string, requestId = 'req_fixture_1') =>
  createMockFetch((_url, init) => sseResponse(sse(name), { requestId, signal: init?.signal }));

async function run(
  fetchImpl: typeof fetch,
  over: Partial<ModelRequest> = {},
  hooks?: GenerateHooks,
  signal: AbortSignal = new AbortController().signal,
): Promise<ModelResult> {
  const adapter = createAnthropicAdapter({ clock: tickingClock(), fetch: fetchImpl });
  return adapter.generate(request(over), { apiKey: API_KEY, signal, ...(hooks === undefined ? {} : { hooks }) });
}

const bodyOf = (call: MockFetchCall | undefined): Record<string, unknown> => call?.body as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('anthropic adapter: request', () => {
  it('sends output_config.format and max_tokens, and never thinking, tool_choice, or local metadata', async () => {
    const { fetch, calls } = serve('success');

    await run(fetch, { effort: 'high' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    const body = bodyOf(calls[0]);
    expect(body['model']).toBe('claude-opus-5-5');
    expect(body['max_tokens']).toBe(8000);
    expect(body['stream']).toBe(true);
    expect(body['output_config']).toEqual({
      format: { type: 'json_schema', schema: request().outputSchema.jsonSchema },
      effort: 'high',
    });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('metadata');
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('stepKey');
    expect(raw).not.toContain('att_secret_attempt');
    expect(raw).not.toContain('run_secret_run');
    expect(calls[0]!.headers.get('x-api-key')).toBe(API_KEY);
  });

  it('omits effort when the request has none', async () => {
    const { fetch, calls } = serve('success');

    await run(fetch);

    expect(bodyOf(calls[0])['output_config']).not.toHaveProperty('effort');
  });

  it('honors maxRetries 0: a 500 produces exactly one fetch call and PROVIDER_UNAVAILABLE', async () => {
    const { fetch, calls } = createMockFetch(() =>
      jsonResponse(500, { type: 'error', error: { type: 'api_error', message: 'Internal server error' } }, { 'request-id': 'req_500' }),
    );

    const result = await run(fetch);

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ kind: 'error', phase: 'responded', providerRequestId: 'req_500', error: { code: 'PROVIDER_UNAVAILABLE' } });
  });

  it('maps a 429 to RATE_LIMITED after a single call', async () => {
    const { fetch, calls } = createMockFetch(() =>
      jsonResponse(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }, { 'retry-after': '3' }),
    );

    const result = await run(fetch);

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ kind: 'error', retryAfterMs: 3000, error: { code: 'RATE_LIMITED' } });
  });

  it('asserts effort support from the catalog (Haiku 4.5 has none)', async () => {
    const { fetch, calls } = serve('success');

    await expect(run(fetch, { modelId: 'claude-haiku-4-5', effort: 'low' })).rejects.toThrow(/effort low/);
    expect(calls).toHaveLength(0);
  });

  it('rejects a request for another provider as a programmer error', async () => {
    await expect(run(serve('success').fetch, { providerId: 'openai' })).rejects.toThrow(/providerId openai/);
  });

  it('uses the beta endpoint with fallbacks only when refusalFallback is default', async () => {
    const text = sse('success').replace(
      '"cache_read_input_tokens":0}}}',
      '"cache_read_input_tokens":0,"iterations":[{"type":"message","input_tokens":1000,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},{"type":"fallback_message","model":"claude-sonnet-5-5","input_tokens":1000,"output_tokens":175,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}]}}}',
    );
    const { fetch, calls } = createMockFetch((_u, init) => sseResponse(text, { signal: init?.signal }));

    const result = await run(fetch, { refusalFallback: 'default' });

    expect(calls[0]!.url).toContain('/v1/messages');
    expect(calls[0]!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(bodyOf(calls[0])['fallbacks']).toBe('default');
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.fallback?.servedByModel).toBe('claude-opus-5-5');
    expect(result.fallback?.iterations.map((i) => i.modelId)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
  });

  it('reads globalThis.fetch at call time when no fetch is injected', async () => {
    const adapter = createAnthropicAdapter({ clock: tickingClock() });
    const { fetch, calls } = serve('success');
    vi.stubGlobal('fetch', fetch);

    const result = await adapter.generate(request(), { apiKey: API_KEY, signal: new AbortController().signal });

    expect(calls).toHaveLength(1);
    expect(result.kind).toBe('success');
  });
});

describe('anthropic adapter: results', () => {
  it('returns success with parsed JSON, disjoint usage, and both ids', async () => {
    const result = await run(serve('success').fetch);

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.json).toMatchObject({ outcome: 'no_issues', findings: [] });
    expect(result.rawText).toBe(JSON.stringify(result.json));
    expect(result.usage).toEqual({ uncachedInputTokens: 1000, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 180, reasoningTokens: 120 });
    expect(result.providerResponseId).toBe('msg_01SuccessFixture');
    expect(result.providerRequestId).toBe('req_fixture_1');
    expect(result.stopReason).toBe('end_turn');
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.firstByteMs).toBeGreaterThan(0);
  });

  it('maps cache usage without double counting', async () => {
    const result = await run(serve('cache-usage').fetch);

    expect(result.kind === 'success' && result.usage).toEqual({
      uncachedInputTokens: 1000,
      cacheReadInputTokens: 500,
      cacheWriteInputTokens: 200,
      outputTokens: 180,
      reasoningTokens: 120,
    });
  });

  it('returns success with json undefined when the text is not JSON (the engine rejects it)', async () => {
    const text = sse('success').replace('"type":"text_delta","text":"{', '"type":"text_delta","text":"oops {');
    const { fetch } = createMockFetch((_u, init) => sseResponse(text, { signal: init?.signal }));

    const result = await run(fetch);

    expect(result).toMatchObject({ kind: 'success', json: undefined });
  });

  it('maps max_tokens to truncated', async () => {
    const result = await run(serve('max-tokens').fetch);

    expect(result).toMatchObject({ kind: 'truncated', providerResponseId: 'msg_01MaxTokensFixture' });
  });

  it('maps an unknown stop reason to truncated with the raw reason', async () => {
    const text = sse('max-tokens').replace('"stop_reason":"max_tokens"', '"stop_reason":"pause_turn"');
    const { fetch } = createMockFetch((_u, init) => sseResponse(text, { signal: init?.signal }));

    const result = await run(fetch);

    expect(result).toMatchObject({ kind: 'truncated', rawStopReason: 'pause_turn' });
  });

  it('maps refusal to refused with the stop_details category', async () => {
    const result = await run(serve('refusal').fetch);

    expect(result).toMatchObject({ kind: 'refused', category: 'cyber', providerResponseId: 'msg_01RefusalFixture' });
  });

  it.each([
    ['overloaded-midstream-error', 'msg_01OverloadedMidstream', 'overloaded_error'],
    ['api-midstream-error', 'msg_01ApiErrorMidstream', 'api_error'],
  ])('%s → REQUEST_OUTCOME_UNKNOWN / responded_partial with the message id', async (name, id, type) => {
    const result = await run(serve(name).fetch);

    expect(result).toMatchObject({ kind: 'error', phase: 'responded_partial', providerResponseId: id, error: { code: 'REQUEST_OUTCOME_UNKNOWN' } });
    if (result.kind !== 'error') return;
    expect(result.error.details?.['errorType']).toBe(type);
    expect(result.error.details?.['partialUsage']).toMatchObject({ uncachedInputTokens: 1000 });
  });

  it('maps a connection drop after N bytes to REQUEST_OUTCOME_UNKNOWN / responded_partial', async () => {
    const { fetch } = createMockFetch((_u, init) => sseResponse(sse('success'), { errorAfterBytes: 600, signal: init?.signal }));

    const result = await run(fetch);

    expect(result).toMatchObject({ kind: 'error', phase: 'responded_partial', providerResponseId: 'msg_01SuccessFixture', error: { code: 'REQUEST_OUTCOME_UNKNOWN' } });
  });

  it('maps a 2xx with an empty body to REQUEST_OUTCOME_UNKNOWN / responded', async () => {
    const { fetch } = createMockFetch(() => new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const result = await run(fetch);

    expect(result).toMatchObject({ kind: 'error', phase: 'responded', error: { code: 'REQUEST_OUTCOME_UNKNOWN' } });
  });

  it('maps DNS failure to PROVIDER_UNAVAILABLE / not_sent', async () => {
    const { fetch } = createMockFetch(() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })));

    const result = await run(fetch);

    expect(result).toMatchObject({ kind: 'error', phase: 'not_sent', error: { code: 'PROVIDER_UNAVAILABLE', details: { causeCode: 'ENOTFOUND' } } });
  });

  it('maps a connection reset before a response to REQUEST_OUTCOME_UNKNOWN / sent_no_response', async () => {
    const { fetch } = createMockFetch(() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })));

    const result = await run(fetch);

    expect(result).toMatchObject({ kind: 'error', phase: 'sent_no_response', error: { code: 'REQUEST_OUTCOME_UNKNOWN' } });
  });

  it('takes the request id from x-request-id when request-id is absent', async () => {
    const { fetch } = createMockFetch((_u, init) => {
      const res = sseResponse(sse('success'), { signal: init?.signal });
      res.headers.set('x-request-id', 'req_x_header');
      return res;
    });

    const result = await run(fetch);

    expect(result).toMatchObject({ kind: 'success', providerRequestId: 'req_x_header' });
  });
});

describe('anthropic adapter: hooks and cancellation', () => {
  it('reports the response id from message_start before the stream completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { fetch } = createMockFetch((_u, init) => sseResponse(sse('success'), { requestId: 'req_early', gate: { index: 1, wait: gate }, signal: init?.signal }));
    const onResponseId = vi.fn(() => {
      release();
    });
    const onDispatched = vi.fn();

    const result = await run(fetch, {}, { onResponseId, onDispatched });

    expect(onDispatched).toHaveBeenCalledTimes(1);
    expect(onResponseId).toHaveBeenCalledWith({ providerResponseId: 'msg_01SuccessFixture', providerRequestId: 'req_early' });
    expect(result.kind).toBe('success');
  });

  it('reports progress without content', async () => {
    const onProgress = vi.fn();

    await run(serve('success').fetch, {}, { onProgress });

    expect(onProgress).toHaveBeenCalled();
    for (const [p] of onProgress.mock.calls as [Record<string, unknown>][]) {
      expect(Object.keys(p).sort()).toEqual(['elapsedMs', 'outputTokensSoFar']);
    }
  });

  it('does not change the result when onResponseId / onProgress / onDispatched throw', async () => {
    const baseline = await run(serve('success').fetch);
    const boom = (): never => {
      throw new Error('hook bug');
    };

    const result = await run(serve('success').fetch, {}, { onResponseId: boom, onProgress: boom, onDispatched: boom });

    expect(result.kind).toBe('success');
    expect(result).toMatchObject({ json: (baseline as { json: unknown }).json, usage: (baseline as { usage: unknown }).usage });
  });

  it('stops the stream when the signal aborts', async () => {
    const controller = new AbortController();
    const { fetch } = createMockFetch((_u, init) => sseResponse(sse('success'), { hangAfterChunks: 3, signal: init?.signal }));

    const pending = run(fetch, {}, { onResponseId: () => { controller.abort(); } }, controller.signal);
    const result = await pending;

    expect(result).toMatchObject({ kind: 'error', error: { code: 'INTERNAL', details: { aborted: true } } });
    if (result.kind === 'error') expect(['responded_partial', 'responded']).toContain(result.phase);
  });

  it('returns aborted/not_sent when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, calls } = serve('success');
    const onDispatched = vi.fn();

    const result = await run(fetch, {}, { onDispatched }, controller.signal);

    expect(result).toMatchObject({ kind: 'error', phase: 'not_sent', error: { details: { aborted: true } } });
    expect(calls).toHaveLength(0);
    expect(onDispatched).not.toHaveBeenCalled();
  });
});

describe('anthropic adapter: estimate, capabilities, testConnection', () => {
  it('uses countTokens with an apiKey (provider_count)', async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse(200, { input_tokens: 1234 }));
    const adapter = createAnthropicAdapter({ clock: tickingClock(), fetch });

    const est = await adapter.estimate(request(), PRICES, { apiKey: API_KEY });

    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    expect(bodyOf(calls[0])).not.toHaveProperty('max_tokens');
    expect(est).toMatchObject({ basis: 'provider_count', inputTokens: 1234, maxOutputTokens: 8000, priceCatalogVersion: '2026-09-25' });
    // Input priced at the highest input-side rate (cache write 1.25×) + output allowance + rounding slack (04 §D2).
    expect(est.upperAllowanceMicrousd).toBe(mulDivCeil(1234, PRICES.cacheWrite) + 80_000 + INPUT_SPLIT_ROUNDING_SLACK_MICROUSD);
  });

  it('falls back to the local heuristic without a key', async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse(200, { input_tokens: 1 }));
    const adapter = createAnthropicAdapter({ clock: tickingClock(), fetch });

    const est = await adapter.estimate(request(), PRICES);

    expect(calls).toHaveLength(0);
    expect(est.basis).toBe('local_estimate');
    const schemaChars = JSON.stringify(request().outputSchema.jsonSchema).length;
    expect(est.inputTokens).toBe(Math.ceil(((21 + 26 + schemaChars) * 23) / 64) + LOCAL_REQUEST_OVERHEAD_TOKENS);
  });

  it('falls back to the local heuristic when counting fails', async () => {
    const warn = vi.fn();
    const { fetch } = createMockFetch(() => jsonResponse(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }));
    const adapter = createAnthropicAdapter({ clock: tickingClock(), fetch, logger: { warn } });

    const est = await adapter.estimate(request(), PRICES, { apiKey: API_KEY });

    expect(est).toMatchObject({ basis: 'local_estimate', inputTokens: localInputTokens(request()) });
    expect(warn).toHaveBeenCalledWith('provider.count_tokens_failed', expect.objectContaining({ providerId: 'anthropic' }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(API_KEY);
  });

  it('a failed count on a model with a price tier uses the conservative bound, like every adapter', async () => {
    const entry = catalogModule.findCatalogEntry('anthropic', request().modelId)!;
    vi.spyOn(catalogModule, 'findCatalogEntry').mockReturnValue({ ...entry, capabilities: { ...entry.capabilities, priceCliffInputTokens: 200_000 } });
    const { fetch } = createMockFetch(() => jsonResponse(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }));

    const est = await createAnthropicAdapter({ clock: tickingClock(), fetch }).estimate(request(), PRICES, { apiKey: API_KEY });

    expect(est).toMatchObject({ basis: 'local_estimate', inputTokens: conservativeInputTokens(request()) });
  });

  it('uses the local heuristic for a model missing from the catalog', async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse(200, { input_tokens: 1 }));
    const adapter = createAnthropicAdapter({ clock: tickingClock(), fetch });

    const est = await adapter.estimate(request({ modelId: 'claude-unknown' }), PRICES, { apiKey: API_KEY });

    expect(calls).toHaveLength(0);
    expect(est.basis).toBe('local_estimate');
  });

  it('regression (F1): the local estimate bills the output JSON schema as input', async () => {
    const adapter = createAnthropicAdapter({ clock: tickingClock(), fetch: createMockFetch(() => jsonResponse(200, {})).fetch });
    const bigSchema = { type: 'object', description: 'x'.repeat(18_000) };
    const schemaChars = JSON.stringify(bigSchema).length;
    expect(schemaChars).toBeGreaterThanOrEqual(18_000);

    const small = await adapter.estimate(request({ outputSchema: { name: 's', jsonSchema: {} } }), PRICES);
    const big = await adapter.estimate(request({ outputSchema: { name: 's', jsonSchema: bigSchema } }), PRICES);

    const extraTokens = big.inputTokens - small.inputTokens;
    expect(extraTokens).toBeGreaterThanOrEqual(Math.floor(((schemaChars - 2) * 23) / 64));
    expect(extraTokens).toBeGreaterThan(6000);
    expect(big.upperAllowanceMicrousd - small.upperAllowanceMicrousd).toBeGreaterThanOrEqual(mulDivCeil(extraTokens, PRICES.input));
    expect(small.inputTokens).toBeGreaterThanOrEqual(LOCAL_REQUEST_OVERHEAD_TOKENS);
  });

  it('regression (F2): refusalFallback default covers two hops at the maximum anthropic catalog price', async () => {
    const adapter = createAnthropicAdapter({ clock: tickingClock(), fetch: createMockFetch(() => jsonResponse(200, { input_tokens: 1000 })).fetch });
    const haiku = findCatalogEntry('anthropic', 'claude-haiku-4-5')!;
    const req = { modelId: 'claude-haiku-4-5', maxOutputTokens: 4000 };

    const off = await adapter.estimate(request({ ...req, refusalFallback: 'off' }), haiku.prices, { apiKey: API_KEY });
    const on = await adapter.estimate(request({ ...req, refusalFallback: 'default' }), haiku.prices, { apiKey: API_KEY });

    const max = maxProviderPrices('anthropic')!;
    expect(off.upperAllowanceMicrousd).toBe(upperBound(1000, 4000, haiku.prices));
    expect(on.upperAllowanceMicrousd).toBe(2 * upperBound(1000, 4000, max));
    // Worst case: haiku declines using the whole allowance, then the most expensive model rescues with the whole allowance.
    const declined = computeCost({ uncachedInputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 1000, outputTokens: 4000 }, haiku.prices);
    const rescue = computeCost({ uncachedInputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 1000, outputTokens: 4000 }, max);
    expect(on.upperAllowanceMicrousd).toBeGreaterThanOrEqual(declined.microusd + rescue.microusd);
  });

  it('records the catalog version the passed prices came from (explicit, or looked up by the prices)', async () => {
    const adapter = createAnthropicAdapter({ clock: tickingClock(), fetch: createMockFetch(() => jsonResponse(200, {})).fetch });
    const opus = findCatalogEntry('anthropic', 'claude-opus-5-5')!;

    const explicit = await adapter.estimate(request(), opus.prices, { priceCatalogVersion: '2026-01-01' });
    const byPrices = await adapter.estimate(request(), opus.prices);

    expect(explicit.priceCatalogVersion).toBe('2026-01-01');
    expect(byPrices.priceCatalogVersion).toBe(opus.catalogVersion);
  });

  it('returns catalog capabilities and rejects unknown models with MODEL_UNSUPPORTED', async () => {
    const adapter = createAnthropicAdapter({ clock: tickingClock(), fetch: serve('success').fetch });

    await expect(adapter.capabilities('claude-opus-5-5')).resolves.toMatchObject({ supportsRequestLookup: false, thinkingAlwaysOn: true });
    const err: unknown = await adapter.capabilities('claude-nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).appError.code).toBe('MODEL_UNSUPPORTED');
    expect('reconcile' in adapter).toBe(false);
  });

  it('testConnection sends a 16-token { ok } request to the chosen model', async () => {
    const { fetch, calls } = serve('success');
    const adapter = createAnthropicAdapter({ clock: tickingClock(), fetch });

    const result = await adapter.testConnection({ apiKey: API_KEY, signal: new AbortController().signal, modelId: 'claude-haiku-4-5' });

    const body = bodyOf(calls[0]);
    expect(body['max_tokens']).toBe(16);
    expect(body['model']).toBe('claude-haiku-4-5');
    expect(body['output_config']).toMatchObject({ format: { type: 'json_schema', schema: { required: ['ok'] } } });
    expect(result.kind).toBe('success');
  });
});
