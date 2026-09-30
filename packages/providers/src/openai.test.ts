import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayError, catalogFileSchema, mulDivCeil } from '@relay/contracts';
import type { ModelPrices } from '@relay/contracts';
import testCatalog from '../catalog/test-fixture.json' with { type: 'json' };
import { createMockFetch, jsonResponse, streamBody, sseChunks, tickingClock } from './__fixtures__/mock-fetch.js';
import type { MockFetchCall, StreamBodyOptions } from './__fixtures__/mock-fetch.js';
import * as catalogModule from './catalog.js';
import { findCatalogEntry } from './catalog.js';
import { CONNECTION_TEST_MAX_OUTPUT_TOKENS, OPENAI_CONNECTION_TEST_MAX_OUTPUT_TOKENS, connectionTestRequest } from './connection-test.js';
import { LOCAL_REQUEST_OVERHEAD_TOKENS, localTokenEstimate } from './estimate.js';
import { createOpenAIAdapter, isPriceTierMismatch, mapEffort, openAISchemaName, supportsRequestLookupFor } from './openai.js';
import { INPUT_SPLIT_ROUNDING_SLACK_MICROUSD } from './pricing.js';
import type { GenerateHooks, ModelRequest, ModelResult } from './types.js';

const sse = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/openai/${name}.sse`, import.meta.url), 'utf8');

const PRICES: ModelPrices = catalogFileSchema.parse(testCatalog).entries[0]!.prices;
const API_KEY = 'sk-proj-test-key-not-real-0000000000000000';
const MODEL = 'gpt-6.1-sol';

const STRICT_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, note: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
  required: ['summary', 'note'],
  additionalProperties: false,
};

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  providerId: 'openai',
  modelId: MODEL,
  system: 'You are the reviewer.',
  messages: [{ role: 'user', content: 'Review the selected files.' }],
  outputSchema: { name: 'findings.v1', jsonSchema: STRICT_SCHEMA },
  maxOutputTokens: 8000,
  refusalFallback: 'off',
  metadata: { attemptId: 'att_1', runId: 'run_1', stepKey: 'review_step_secret', purpose: 'schema_repair' },
  ...over,
});

function openAISse(text: string, opts: StreamBodyOptions & { readonly requestId?: string } = {}): Response {
  return new Response(streamBody(sseChunks(text), opts), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...(opts.requestId === undefined ? {} : { 'x-request-id': opts.requestId }) },
  });
}

const serve = (name: string, requestId = 'req_oai_1') =>
  createMockFetch((_url, init) => openAISse(sse(name), { requestId, signal: init?.signal }));

const serveText = (text: string) => createMockFetch((_url, init) => openAISse(text, { requestId: 'req_oai_1', signal: init?.signal }));

async function run(
  fetchImpl: typeof fetch,
  over: Partial<ModelRequest> = {},
  hooks?: GenerateHooks,
  signal: AbortSignal = new AbortController().signal,
): Promise<ModelResult> {
  const adapter = createOpenAIAdapter({ clock: tickingClock(), fetch: fetchImpl });
  return adapter.generate(request(over), { apiKey: API_KEY, signal, ...(hooks === undefined ? {} : { hooks }) });
}

const bodyOf = (call: MockFetchCall | undefined): Record<string, unknown> => call?.body as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** `name`.sse with every lifecycle `response` snapshot passed through `edit` (terminal events included). */
function editedSse(name: string, edit: (resp: Record<string, unknown>) => Record<string, unknown>): string {
  return sse(name)
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data: ')) return line;
      const event = JSON.parse(line.slice(6)) as { type: string; response?: Record<string, unknown> };
      if (event.response === undefined) return line;
      return `data: ${JSON.stringify({ ...event, response: edit(event.response) })}`;
    })
    .join('\n');
}

describe('openai adapter: request', () => {
  it('streams a Responses request with strict json_schema, store, and only the two metadata ids', async () => {
    const { fetch, calls } = serve('success');

    await run(fetch, { effort: 'high' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    const body = bodyOf(calls[0]);
    expect(body).toMatchObject({
      model: MODEL,
      stream: true,
      instructions: 'You are the reviewer.',
      input: [{ role: 'user', content: 'Review the selected files.' }],
      max_output_tokens: 8000,
      store: true,
      reasoning: { effort: 'high' },
    });
    expect(body['text']).toEqual({ format: { type: 'json_schema', name: 'findings_v1', schema: STRICT_SCHEMA, strict: true } });
    expect(body['metadata']).toEqual({ relay_attempt_id: 'att_1', relay_run_id: 'run_1' });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('review_step_secret');
    expect(raw).not.toContain('schema_repair');
  });

  it('omits reasoning without effort and sends store: false when the project opts out', async () => {
    const { fetch, calls } = serve('success');

    await run(fetch, { providerOptions: { openai: { storeResponses: false } } });

    expect(bodyOf(calls[0])).not.toHaveProperty('reasoning');
    expect(bodyOf(calls[0])['store']).toBe(false);
  });

  it('ignores OPENAI_* environment overrides (base URL, org, project)', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://evil.invalid/v1');
    vi.stubEnv('OPENAI_ORG_ID', 'org_env');
    vi.stubEnv('OPENAI_PROJECT_ID', 'proj_env');
    vi.stubEnv('OPENAI_API_KEY', 'sk-env-should-not-be-used');
    const { fetch, calls } = serve('success');

    await run(fetch);

    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]!.headers.get('openai-organization')).toBeNull();
    expect(calls[0]!.headers.get('openai-project')).toBeNull();
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
  });

  it('OPENAI_CUSTOM_HEADERS can never override the key or add an organization/project', async () => {
    vi.stubEnv(
      'OPENAI_CUSTOM_HEADERS',
      ['Authorization: Bearer sk-env-attacker', 'OpenAI-Organization: org_env', 'openai-project: proj_env', 'X-Env-Extra: kept'].join('\n'),
    );
    const { fetch, calls } = serve('success');
    const countFetch = createMockFetch(() => jsonResponse(200, { object: 'response.input_tokens', input_tokens: 5 }));
    const retrieveFetch = createMockFetch(() => jsonResponse(404, { error: { type: 'x', message: 'x', code: null, param: null } }));

    await run(fetch);
    await createOpenAIAdapter({ clock: tickingClock(), fetch: countFetch.fetch }).estimate(request(), PRICES, { apiKey: API_KEY });
    await createOpenAIAdapter({ clock: tickingClock(), fetch: retrieveFetch.fetch }).reconcile!(
      { providerResponseId: 'resp_1' },
      { apiKey: API_KEY, signal: new AbortController().signal },
    );

    for (const call of [calls[0]!, countFetch.calls[0]!, retrieveFetch.calls[0]!]) {
      expect(call.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
      expect(call.headers.get('openai-organization')).toBeNull();
      expect(call.headers.get('openai-project')).toBeNull();
      expect(JSON.stringify([...call.headers.entries()])).not.toContain('sk-env-attacker');
    }
    expect(calls[0]!.headers.get('x-env-extra')).toBe('kept'); // unrelated env headers are left alone
  });

  it('requests the default service tier (catalog prices) and flags any other billed tier', async () => {
    const { fetch, calls } = serve('success');

    const plain = await run(fetch);
    const tier = (t: unknown) => serveText(editedSse('success', (r) => ({ ...r, service_tier: t }))).fetch;
    const def = await run(tier('default'));
    const priority = await run(tier('priority'));
    const flex = await run(tier('flex'));
    const truncated = await run(serveText(editedSse('incomplete-max-output', (r) => ({ ...r, service_tier: 'scale' }))).fetch);

    expect(bodyOf(calls[0])['service_tier']).toBe('default');
    expect(plain).not.toHaveProperty('priceTierMismatch');
    expect(def).not.toHaveProperty('priceTierMismatch');
    expect(priority).toMatchObject({ kind: 'success', priceTierMismatch: true });
    expect(flex).toMatchObject({ kind: 'success', priceTierMismatch: true });
    expect(truncated).toMatchObject({ kind: 'truncated', priceTierMismatch: true });
    expect(isPriceTierMismatch(undefined)).toBe(false);
    expect(isPriceTierMismatch(null)).toBe(false);
    expect(isPriceTierMismatch('auto')).toBe(true);
  });

  it('a terminal response without usage is flagged usageKnown: false (never a known $0)', async () => {
    const noUsage = (name: string) => serveText(editedSse(name, (r) => ({ ...r, usage: null }))).fetch;

    const success = await run(noUsage('success'));
    const truncated = await run(noUsage('incomplete-max-output'));
    const withUsage = await run(serve('success').fetch);

    expect(success).toMatchObject({ kind: 'success', usageKnown: false, usage: { uncachedInputTokens: 0, outputTokens: 0 } });
    expect(truncated).toMatchObject({ kind: 'truncated', usageKnown: false });
    expect(withUsage.kind).toBe('success');
    expect(withUsage).not.toHaveProperty('usageKnown');
  });

  it('honors maxRetries 0: a 500 produces exactly one fetch call and PROVIDER_UNAVAILABLE', async () => {
    const { fetch, calls } = createMockFetch(() =>
      jsonResponse(500, { error: { type: 'server_error', message: 'boom', code: null, param: null } }, { 'x-request-id': 'req_500' }),
    );

    const result = await run(fetch);

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ kind: 'error', phase: 'responded', providerRequestId: 'req_500', error: { code: 'PROVIDER_UNAVAILABLE' } });
  });

  it.each([
    [429, 'RATE_LIMITED'],
    [401, 'AUTH_REQUIRED'],
    [404, 'MODEL_UNSUPPORTED'],
    [502, 'REQUEST_OUTCOME_UNKNOWN'],
  ])('maps HTTP %i to %s after a single call', async (status, code) => {
    const { fetch, calls } = createMockFetch(() =>
      jsonResponse(status, { error: { type: 'x', message: 'nope', code: null, param: null } }, { 'retry-after': '2' }),
    );

    const result = await run(fetch);

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ kind: 'error', phase: 'responded', error: { code } });
  });

  it('maps a context-window 400 to CONTEXT_TOO_LARGE with a redacted provider error', async () => {
    const { fetch } = createMockFetch(() =>
      jsonResponse(400, { error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: `Your input exceeds the context window of this model. key ${API_KEY}`, param: 'input' } }),
    );

    const result = await run(fetch);

    expect(result).toMatchObject({ kind: 'error', error: { code: 'CONTEXT_TOO_LARGE' } });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('asserts catalog effort levels and the strict schema subset before dispatch', async () => {
    const { fetch, calls } = serve('success');
    const loose = { type: 'object', properties: { a: { type: 'string' } } };

    await expect(run(fetch, { outputSchema: { name: 'x', jsonSchema: loose } })).rejects.toThrow(/strict-compatible/);
    await expect(run(fetch, { providerId: 'anthropic' })).rejects.toThrow(/providerId anthropic/);
    expect(calls).toHaveLength(0);
    expect(() => mapEffort('max', { effortLevels: ['low'] })).toThrow(/effort max/);
    expect(mapEffort('low', { effortLevels: ['low'] })).toBe('low');
  });

  it('passes effort through for a model missing from the catalog (validation already ran)', async () => {
    const { fetch, calls } = serve('success');

    await run(fetch, { modelId: 'gpt-unlisted', effort: 'low' });

    expect(bodyOf(calls[0])['reasoning']).toEqual({ effort: 'low' });
  });

  it('reads globalThis.fetch at call time when no fetch is injected', async () => {
    const adapter = createOpenAIAdapter({ clock: tickingClock() });
    const { fetch, calls } = serve('success');
    vi.stubGlobal('fetch', fetch);

    const result = await adapter.generate(request(), { apiKey: API_KEY, signal: new AbortController().signal });

    expect(calls).toHaveLength(1);
    expect(result.kind).toBe('success');
  });
});

describe('openai adapter: results', () => {
  it('returns success with parsed JSON, disjoint usage, and both ids', async () => {
    const result = await run(serve('success').fetch);

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.json).toMatchObject({ outcome: 'no_issues', findings: [] });
    expect(result.rawText).toBe(JSON.stringify(result.json));
    expect(result.usage).toEqual({ uncachedInputTokens: 1000, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 180, reasoningTokens: 120 });
    expect(result.providerResponseId).toBe('resp_01SuccessFixture');
    expect(result.providerRequestId).toBe('req_oai_1');
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.firstByteMs).toBeGreaterThan(0);
  });

  it('subtracts cached and cache-write tokens from input_tokens (no double counting)', async () => {
    const result = await run(serve('cache-usage').fetch);

    expect(result.kind === 'success' && result.usage).toEqual({
      uncachedInputTokens: 1000,
      cacheReadInputTokens: 500,
      cacheWriteInputTokens: 200,
      outputTokens: 180,
      reasoningTokens: 120,
    });
  });

  it('returns success with json undefined when the completed text is not JSON (the SDK parse error is bypassed)', async () => {
    const text = sse('success').replaceAll('{\\"summary\\":\\"No issue', 'oops {\\"summary\\":\\"No issue');
    const result = await run(serveText(text).fetch);

    expect(result).toMatchObject({ kind: 'success', json: undefined, providerResponseId: 'resp_01SuccessFixture' });
    if (result.kind === 'success') expect(result.rawText.startsWith('oops')).toBe(true);
  });

  it('maps incomplete / max_output_tokens to truncated with the partial text', async () => {
    const result = await run(serve('incomplete-max-output').fetch);

    expect(result).toMatchObject({ kind: 'truncated', providerResponseId: 'resp_01IncompleteFixture', usage: { outputTokens: 8000 } });
    expect(result.kind === 'truncated' && result.rawText).toContain('No issues found');
  });

  it('maps incomplete / content_filter to refused', async () => {
    const text = sse('incomplete-max-output').replace('"reason":"max_output_tokens"', '"reason":"content_filter"');

    const result = await run(serveText(text).fetch);

    expect(result).toMatchObject({ kind: 'refused', category: 'content_filter', providerResponseId: 'resp_01IncompleteFixture' });
  });

  it('maps another incomplete reason to truncated with the raw reason', async () => {
    const text = sse('incomplete-max-output').replace('"reason":"max_output_tokens"', '"reason":"steered"');

    const result = await run(serveText(text).fetch);

    expect(result).toMatchObject({ kind: 'truncated', rawStopReason: 'incomplete:steered' });
  });

  it('maps a refusal content item to refused', async () => {
    const result = await run(serve('refusal').fetch);

    expect(result).toMatchObject({ kind: 'refused', category: 'refusal', providerResponseId: 'resp_01RefusalFixture', usage: { outputTokens: 12 } });
  });

  it('maps a terminal response.failed to REQUEST_OUTCOME_UNKNOWN / responded_partial with id and partial usage', async () => {
    const result = await run(serve('failed-midstream-error').fetch);

    expect(result).toMatchObject({
      kind: 'error',
      phase: 'responded_partial',
      providerResponseId: 'resp_01FailedMidstream',
      providerRequestId: 'req_oai_1',
      error: { code: 'REQUEST_OUTCOME_UNKNOWN', details: { providerResponseId: 'resp_01FailedMidstream', partialUsage: { outputTokens: 40 } } },
    });
    if (result.kind === 'error') expect(result.error.details?.['providerError']).toMatchObject({ code: 'server_error' });
  });

  it('maps an SSE error event mid-stream to REQUEST_OUTCOME_UNKNOWN / responded_partial (never PROVIDER_UNAVAILABLE)', async () => {
    const result = await run(serve('error-event-midstream-error').fetch);

    expect(result).toMatchObject({
      kind: 'error',
      phase: 'responded_partial',
      providerResponseId: 'resp_01ErrorEventMidstream',
      error: { code: 'REQUEST_OUTCOME_UNKNOWN' },
    });
  });

  it('maps a connection drop after N bytes to REQUEST_OUTCOME_UNKNOWN / responded_partial with the response id', async () => {
    const { fetch } = createMockFetch((_u, init) => openAISse(sse('success'), { errorAfterBytes: 2500, signal: init?.signal }));

    const result = await run(fetch);

    expect(result).toMatchObject({ kind: 'error', phase: 'responded_partial', providerResponseId: 'resp_01SuccessFixture', error: { code: 'REQUEST_OUTCOME_UNKNOWN' } });
  });

  it('maps a stream that ends cleanly without a terminal event to REQUEST_OUTCOME_UNKNOWN', async () => {
    const text = sse('success').split('event: response.completed')[0]!;

    const result = await run(serveText(text).fetch);

    expect(result).toMatchObject({ kind: 'error', phase: 'responded_partial', error: { code: 'REQUEST_OUTCOME_UNKNOWN' } });
  });

  it('maps a 2xx with an empty body to REQUEST_OUTCOME_UNKNOWN / responded', async () => {
    const { fetch } = createMockFetch(() => new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const result = await run(fetch);

    expect(result).toMatchObject({ kind: 'error', phase: 'responded', error: { code: 'REQUEST_OUTCOME_UNKNOWN' } });
  });

  it.each([
    ['ENOTFOUND', 'not_sent', 'PROVIDER_UNAVAILABLE'],
    ['ECONNRESET', 'sent_no_response', 'REQUEST_OUTCOME_UNKNOWN'],
  ])('maps a fetch rejection with %s to %s / %s', async (code, phase, errorCode) => {
    const { fetch } = createMockFetch(() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code } })));

    const result = await run(fetch);

    expect(result).toMatchObject({ kind: 'error', phase, error: { code: errorCode, details: { causeCode: code } } });
  });
});

describe('openai adapter: hooks and cancellation', () => {
  it('reports the response id from response.created before the stream completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { fetch } = createMockFetch((_u, init) => openAISse(sse('success'), { requestId: 'req_early', gate: { index: 1, wait: gate }, signal: init?.signal }));
    const onResponseId = vi.fn(() => {
      release();
    });
    const onDispatched = vi.fn();

    const result = await run(fetch, {}, { onResponseId, onDispatched });

    expect(onDispatched).toHaveBeenCalledTimes(1);
    expect(onResponseId).toHaveBeenCalledTimes(1);
    expect(onResponseId).toHaveBeenCalledWith({ providerResponseId: 'resp_01SuccessFixture', providerRequestId: 'req_early' });
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

  it('does not change the result when hooks throw', async () => {
    const baseline = await run(serve('success').fetch);
    const boom = (): never => {
      throw new Error('hook bug');
    };

    const result = await run(serve('success').fetch, {}, { onResponseId: boom, onProgress: boom, onDispatched: boom });

    expect(result).toMatchObject({ kind: 'success', json: (baseline as { json: unknown }).json, usage: (baseline as { usage: unknown }).usage });
  });

  it('stops the stream when the signal aborts', async () => {
    const controller = new AbortController();
    const { fetch } = createMockFetch((_u, init) => openAISse(sse('success'), { hangAfterChunks: 3, signal: init?.signal }));

    const result = await run(fetch, {}, { onResponseId: () => { controller.abort(); } }, controller.signal);

    expect(result).toMatchObject({ kind: 'error', providerResponseId: 'resp_01SuccessFixture', error: { code: 'INTERNAL', details: { aborted: true } } });
  });

  it('returns aborted/not_sent when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, calls } = serve('success');

    const result = await run(fetch, {}, undefined, controller.signal);

    expect(result).toMatchObject({ kind: 'error', phase: 'not_sent', error: { details: { aborted: true } } });
    expect(calls).toHaveLength(0);
  });
});

describe('openai adapter: reconcile', () => {
  const completedResponse = (status: string, extra: Record<string, unknown> = {}) => {
    const line = sse('cache-usage').split('\n').find((l) => l.startsWith('data: {"type":"response.completed"'))!;
    const resp = (JSON.parse(line.slice(6)) as { response: Record<string, unknown> }).response;
    return { ...resp, status, ...extra };
  };

  const reconcileWith = async (handler: () => Response | Promise<Response>) => {
    const { fetch, calls } = createMockFetch(handler);
    const adapter = createOpenAIAdapter({ clock: tickingClock(), fetch });
    const result = await adapter.reconcile!({ providerResponseId: 'resp_01CacheUsageFixture' }, { apiKey: API_KEY, signal: new AbortController().signal });
    return { result, calls };
  };

  it('retrieves the response by id; completed → json + disjoint usage', async () => {
    const { result, calls } = await reconcileWith(() => jsonResponse(200, completedResponse('completed')));

    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses/resp_01CacheUsageFixture');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(result).toMatchObject({
      kind: 'completed',
      json: { outcome: 'no_issues' },
      usage: { uncachedInputTokens: 1000, cacheReadInputTokens: 500, cacheWriteInputTokens: 200, outputTokens: 180 },
    });
  });

  it.each([
    ['failed', 'failed'],
    ['cancelled', 'failed'],
    ['incomplete', 'failed'],
    ['queued', 'in_progress'],
    ['in_progress', 'in_progress'],
  ])('status %s → %s', async (status, kind) => {
    const { result } = await reconcileWith(() => jsonResponse(200, completedResponse(status)));

    expect(result.kind).toBe(kind);
    if (result.kind === 'failed') expect(result.usage?.uncachedInputTokens).toBe(1000);
  });

  it('failed without usage carries no usage', async () => {
    const { result } = await reconcileWith(() => jsonResponse(200, completedResponse('failed', { usage: null })));

    expect(result).toEqual({ kind: 'failed', usageKnown: false });
  });

  it.each(['failed', 'cancelled', null])('status %s without usage keeps the liability (usageKnown: false, never a known $0)', async (status) => {
    const { result } = await reconcileWith(() => jsonResponse(200, completedResponse('x', { status, usage: null })));

    expect(result).toEqual({ kind: 'failed', usageKnown: false });
  });

  it('failed with usage and completed with usage report usageKnown: true', async () => {
    const failed = await reconcileWith(() => jsonResponse(200, completedResponse('failed')));
    const completed = await reconcileWith(() => jsonResponse(200, completedResponse('completed')));

    expect(failed.result).toMatchObject({ kind: 'failed', usageKnown: true, usage: { uncachedInputTokens: 1000 } });
    expect(completed.result).toMatchObject({ kind: 'completed', usageKnown: true });
  });

  it('completed without usage returns zero placeholders flagged usageKnown: false', async () => {
    const { result } = await reconcileWith(() => jsonResponse(200, completedResponse('completed', { usage: null })));

    expect(result).toMatchObject({
      kind: 'completed',
      usageKnown: false,
      usage: { uncachedInputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 },
    });
  });

  it('404 → not_found', async () => {
    const { result } = await reconcileWith(() => jsonResponse(404, { error: { type: 'invalid_request_error', message: 'No response found', code: null, param: null } }));

    expect(result).toEqual({ kind: 'not_found' });
  });

  it('other failures throw a RelayError with the mapped code (never the key)', async () => {
    const err: unknown = await reconcileWith(() => jsonResponse(401, { error: { type: 'x', message: `bad key ${API_KEY}`, code: null, param: null } })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).appError.code).toBe('AUTH_REQUIRED');
    expect(JSON.stringify((err as RelayError).appError)).not.toContain(API_KEY);
  });
});

describe('openai adapter: estimate, capabilities, testConnection, helpers', () => {
  it('uses the input_tokens count endpoint with an apiKey (provider_count)', async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse(200, { object: 'response.input_tokens', input_tokens: 1234 }));
    const adapter = createOpenAIAdapter({ clock: tickingClock(), fetch });

    const est = await adapter.estimate(request(), PRICES, { apiKey: API_KEY });

    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses/input_tokens');
    expect(bodyOf(calls[0])).toMatchObject({ model: MODEL, instructions: 'You are the reviewer.', text: { format: { strict: true } } });
    expect(bodyOf(calls[0])).not.toHaveProperty('max_output_tokens');
    expect(est).toMatchObject({ basis: 'provider_count', inputTokens: 1234, maxOutputTokens: 8000 });
    expect(est.upperAllowanceMicrousd).toBe(mulDivCeil(1234, Math.max(PRICES.input, PRICES.cacheWrite, PRICES.cacheRead)) + mulDivCeil(8000, PRICES.output) + INPUT_SPLIT_ROUNDING_SLACK_MICROUSD);
  });

  it('falls back to the local heuristic without a key or when counting fails', async () => {
    const warn = vi.fn();
    const { fetch, calls } = createMockFetch(() => jsonResponse(429, { error: { type: 'rate_limit', message: 'x', code: null, param: null } }));
    const adapter = createOpenAIAdapter({ clock: tickingClock(), fetch, logger: { warn } });

    const noKey = await adapter.estimate(request(), PRICES);
    expect(calls).toHaveLength(0);
    const failed = await adapter.estimate(request(), PRICES, { apiKey: API_KEY });

    const schemaChars = JSON.stringify(STRICT_SCHEMA).length;
    const local = Math.ceil(((21 + 26 + schemaChars) * 23) / 64) + LOCAL_REQUEST_OVERHEAD_TOKENS;
    expect(noKey).toMatchObject({ basis: 'local_estimate', inputTokens: local });
    // gpt-6.1-sol has a price cliff (maxInputTokens): a failed count falls back to 1 token per UTF-16 code unit.
    expect(failed).toMatchObject({ basis: 'local_estimate', inputTokens: 21 + 26 + schemaChars + LOCAL_REQUEST_OVERHEAD_TOKENS });
    expect(warn).toHaveBeenCalledWith('provider.count_tokens_failed', expect.objectContaining({ providerId: 'openai' }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(API_KEY);
  });

  it('returns catalog capabilities and rejects unknown models with MODEL_UNSUPPORTED', async () => {
    const adapter = createOpenAIAdapter({ clock: tickingClock(), fetch: serve('success').fetch });

    await expect(adapter.capabilities(MODEL)).resolves.toMatchObject({ supportsRequestLookup: true, structuredOutput: true, streaming: true });
    const err: unknown = await adapter.capabilities('gpt-nope').catch((e: unknown) => e);
    expect((err as RelayError).appError.code).toBe('MODEL_UNSUPPORTED');
  });

  it('a failed count for 300k CJK chars bounds input at ≥ 1 token per char, so capability validation blocks it', async () => {
    const { fetch } = createMockFetch(() => jsonResponse(500, { error: { type: 'server_error', message: 'x', code: null, param: null } }));
    const adapter = createOpenAIAdapter({ clock: tickingClock(), fetch });
    const cjk = '漢'.repeat(300_000);

    const est = await adapter.estimate(request({ messages: [{ role: 'user', content: cjk }] }), PRICES, { apiKey: API_KEY });
    const caps = await adapter.capabilities(MODEL);

    // The chars/3.2 heuristic would say ~108k tokens (under the 272k cliff); the conservative bound does not.
    expect(localTokenEstimate(300_000)).toBeLessThan(caps.maxInputTokens!);
    expect(est.basis).toBe('local_estimate');
    expect(est.inputTokens).toBeGreaterThanOrEqual(300_000);
    expect(est.inputTokens).toBeGreaterThan(caps.maxInputTokens!);
  });

  it('a failed count on a model without a price cliff keeps the chars/3.2 heuristic', async () => {
    const entry = findCatalogEntry('openai', MODEL)!;
    const caps = { ...entry.capabilities };
    delete caps.maxInputTokens;
    vi.spyOn(catalogModule, 'findCatalogEntry').mockReturnValue({ ...entry, capabilities: caps });
    const { fetch } = createMockFetch(() => jsonResponse(500, { error: { type: 'server_error', message: 'x', code: null, param: null } }));
    const adapter = createOpenAIAdapter({ clock: tickingClock(), fetch });

    const est = await adapter.estimate(request(), PRICES, { apiKey: API_KEY });

    const schemaChars = JSON.stringify(STRICT_SCHEMA).length;
    expect(est.inputTokens).toBe(localTokenEstimate(21 + 26 + schemaChars) + LOCAL_REQUEST_OVERHEAD_TOKENS);
  });

  it('testConnection sends a 256-token { ok } strict request at the lowest listed effort', async () => {
    const { fetch, calls } = serve('success');
    const adapter = createOpenAIAdapter({ clock: tickingClock(), fetch });

    const result = await adapter.testConnection({ apiKey: API_KEY, signal: new AbortController().signal, modelId: MODEL });

    const body = bodyOf(calls[0]);
    // 16 tokens can be spent entirely on reasoning even at the lowest effort; 256 lets the model finish.
    expect(body['max_output_tokens']).toBe(OPENAI_CONNECTION_TEST_MAX_OUTPUT_TOKENS);
    expect(OPENAI_CONNECTION_TEST_MAX_OUTPUT_TOKENS).toBe(256);
    expect(connectionTestRequest('openai', MODEL).maxOutputTokens).toBe(256);
    expect(connectionTestRequest('anthropic', 'claude-haiku-4-5').maxOutputTokens).toBe(CONNECTION_TEST_MAX_OUTPUT_TOKENS);
    expect(body['reasoning']).toEqual({ effort: 'low' });
    expect(body['text']).toMatchObject({ format: { name: 'connection_test', strict: true, schema: { required: ['ok'] } } });
    expect(result.kind).toBe('success');

    const other = serve('success');
    await createOpenAIAdapter({ clock: tickingClock(), fetch: other.fetch }).testConnection({ apiKey: API_KEY, signal: new AbortController().signal, modelId: 'gpt-unlisted' });
    expect(bodyOf(other.calls[0])).not.toHaveProperty('reasoning');
  });

  it('supportsRequestLookupFor honors storeResponses for OpenAI only', () => {
    expect(supportsRequestLookupFor('openai', { supportsRequestLookup: true })).toBe(true);
    expect(supportsRequestLookupFor('openai', { supportsRequestLookup: true }, { openai: { storeResponses: false } })).toBe(false);
    expect(supportsRequestLookupFor('anthropic', { supportsRequestLookup: true }, { openai: { storeResponses: false } })).toBe(true);
    expect(supportsRequestLookupFor('openai', { supportsRequestLookup: false })).toBe(false);
  });

  it('openAISchemaName maps template ids to the allowed name charset', () => {
    expect(openAISchemaName('findings.v1')).toBe('findings_v1');
    expect(openAISchemaName('')).toBe('output');
    expect(openAISchemaName('x'.repeat(80))).toHaveLength(64);
  });
});
