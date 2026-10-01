import { readFileSync } from 'node:fs';
import { ApiError, setDefaultBaseUrls } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayError, catalogFileSchema } from '@relay/contracts';
import type { ModelPrices } from '@relay/contracts';
import testCatalog from '../catalog/test-fixture.json' with { type: 'json' };
import { createMockFetch, jsonResponse, streamBody, tickingClock } from './__fixtures__/mock-fetch.js';
import type { MockFetchCall, StreamBodyOptions } from './__fixtures__/mock-fetch.js';
import { GEMINI_CONNECTION_TEST_MAX_OUTPUT_TOKENS } from './connection-test.js';
import * as catalogModule from './catalog.js';
import { LOCAL_REQUEST_OVERHEAD_TOKENS, conservativeInputTokens, localInputTokens } from './estimate.js';
import { createGeminiAdapter, isGeminiPriceTierMismatch, mapGeminiEffort, toTypedGeminiError } from './gemini.js';
import type { GenerateHooks, ModelError, ModelRequest, ModelResult } from './types.js';

const raw = (name: string): string => readFileSync(new URL(`./__fixtures__/gemini/${name}.sse`, import.meta.url), 'utf8');

const PRICES: ModelPrices = catalogFileSchema.parse(testCatalog).entries[0]!.prices;
const API_KEY = 'AIzaSy-test-key-not-real-000000000000000';
const MODEL = 'gemini-3.5-flash';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const STREAM_URL = `${BASE}/${MODEL}:streamGenerateContent?alt=sse`;

const SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, findings: { type: 'array', items: { type: 'string' } } },
  required: ['summary', 'findings'],
};

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  providerId: 'gemini',
  modelId: MODEL,
  system: 'You are the reviewer.',
  messages: [{ role: 'user', content: 'Review the selected files.' }],
  outputSchema: { name: 'findings.v1', jsonSchema: SCHEMA },
  maxOutputTokens: 8000,
  refusalFallback: 'off',
  metadata: { attemptId: 'att_1', runId: 'run_1', stepKey: 'review_step_secret', purpose: 'schema_repair' },
  ...over,
});

/** Gemini SSE events are delimited by CRLF CRLF; one chunk per event. */
const geminiChunks = (text: string): string[] => text.split(/(?<=\r\n\r\n)/).filter((c) => c.length > 0);

function geminiSse(chunks: readonly string[], opts: StreamBodyOptions & { readonly requestId?: string } = {}): Response {
  return new Response(streamBody(chunks, opts), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...(opts.requestId === undefined ? {} : { 'x-request-id': opts.requestId }) },
  });
}

const serveChunks = (chunks: readonly string[], opts: StreamBodyOptions = {}) =>
  createMockFetch((_url, init) => geminiSse(chunks, { requestId: 'req_gem_1', signal: init?.signal, ...opts }));
const serve = (name: string, opts: StreamBodyOptions = {}) => serveChunks(geminiChunks(raw(name)), opts);

/** An SSE chunk from a JSON object. */
const event = (o: unknown): string => `data: ${JSON.stringify(o)}\r\n\r\n`;

async function run(
  fetchImpl: typeof fetch,
  over: Partial<ModelRequest> = {},
  hooks?: GenerateHooks,
  signal: AbortSignal = new AbortController().signal,
): Promise<ModelResult> {
  const adapter = createGeminiAdapter({ clock: tickingClock(), fetch: fetchImpl });
  return adapter.generate(request(over), { apiKey: API_KEY, signal, ...(hooks === undefined ? {} : { hooks }) });
}

const bodyOf = (call: MockFetchCall | undefined): Record<string, unknown> => call?.body as Record<string, unknown>;

function asError(r: ModelResult): ModelError {
  if (r.kind !== 'error') throw new Error(`expected error, got ${r.kind}`);
  return r;
}

const errorBody = (code: number, status: string, message: string, details: unknown[] = []) => ({
  error: { code, message, status, details },
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('gemini adapter: request', () => {
  it('streams generateContent with systemInstruction, JSON schema output, thinking level, and the pinned key', async () => {
    const { fetch, calls } = serve('success');

    await run(fetch, { effort: 'high' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(STREAM_URL);
    expect(calls[0]!.headers.get('x-goog-api-key')).toBe(API_KEY);
    expect(calls[0]!.headers.get('authorization')).toBeNull();
    const body = bodyOf(calls[0]);
    expect(body['serviceTier']).toBe('standard'); // catalog prices are the Standard tier (G3)
    expect(body['contents']).toEqual([{ role: 'user', parts: [{ text: 'Review the selected files.' }] }]);
    expect(body['systemInstruction']).toMatchObject({ parts: [{ text: 'You are the reviewer.' }] });
    expect(body['generationConfig']).toEqual({
      maxOutputTokens: 8000,
      responseMimeType: 'application/json',
      responseJsonSchema: SCHEMA,
      thinkingConfig: { thinkingLevel: 'HIGH' },
    });
    const rawBody = JSON.stringify(body);
    expect(rawBody).not.toContain('review_step_secret');
    expect(rawBody).not.toContain('schema_repair');
    expect(rawBody).not.toContain('att_1');
    expect(rawBody).not.toContain(API_KEY);
    expect(calls[0]!.url).not.toContain(API_KEY);
  });

  it('omits thinkingConfig without effort', async () => {
    const { fetch, calls } = serve('success');

    await run(fetch);

    expect(bodyOf(calls[0])['generationConfig']).not.toHaveProperty('thinkingConfig');
  });

  it('ignores GOOGLE_API_KEY / GEMINI_API_KEY / base-URL / Vertex environment overrides', async () => {
    vi.stubEnv('GOOGLE_API_KEY', 'env-google-key');
    vi.stubEnv('GEMINI_API_KEY', 'env-gemini-key');
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://evil.example/');
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fetch, calls } = serve('success');

    const r = await run(fetch);

    expect(r.kind).toBe('success');
    expect(calls[0]!.url).toBe(STREAM_URL);
    expect(calls[0]!.headers.get('x-goog-api-key')).toBe(API_KEY);
    expect(JSON.stringify([...calls[0]!.headers])).not.toContain('env-');
  });

  it('ignores a module-global setDefaultBaseUrls override', async () => {
    setDefaultBaseUrls({ geminiUrl: 'https://evil.example/' });
    try {
      const { fetch, calls } = serve('success');
      await run(fetch);
      expect(calls[0]!.url).toBe(STREAM_URL);
    } finally {
      setDefaultBaseUrls({});
    }
  });

  it('rejects a request for another provider and an effort Gemini cannot express', async () => {
    const { fetch } = serve('success');
    const adapter = createGeminiAdapter({ clock: tickingClock(), fetch });
    const ctx = { apiKey: API_KEY, signal: new AbortController().signal };

    await expect(adapter.generate(request({ providerId: 'openai' }), ctx)).rejects.toThrow(/providerId openai/);
    await expect(adapter.generate(request({ effort: 'xhigh' }), ctx)).rejects.toThrow(/not supported/);
    await expect(adapter.generate(request({ modelId: 'gemini-unknown', effort: 'max' }), ctx)).rejects.toThrow(/not supported/);
  });

  it('maps an effort for a model missing from the catalog when Gemini has the level', async () => {
    const { fetch, calls } = serve('success');

    await run(fetch, { modelId: 'gemini-unknown', effort: 'low' });

    expect(bodyOf(calls[0])['generationConfig']).toMatchObject({ thinkingConfig: { thinkingLevel: 'LOW' } });
  });
});

describe('gemini adapter: stream results', () => {
  it('success: parses JSON, maps usage disjointly (thoughts billed as output), captures ids early', async () => {
    const { fetch } = serve('success');
    const order: string[] = [];
    const progress: number[] = [];

    const r = await run(fetch, {}, {
      onDispatched: () => order.push('dispatched'),
      onResponseId: (ids) => order.push(`id:${ids.providerResponseId ?? ''}:${ids.providerRequestId ?? ''}`),
      onProgress: (p) => progress.push(p.outputTokensSoFar),
    });

    expect(order).toEqual(['dispatched', 'id:gem_resp_success_01:req_gem_1']);
    expect(progress.length).toBe(2);
    expect(r).toMatchObject({
      kind: 'success',
      json: { summary: 'No issues found', findings: [] },
      stopReason: 'end_turn',
      providerResponseId: 'gem_resp_success_01',
      providerRequestId: 'req_gem_1',
      usage: { uncachedInputTokens: 1000, cacheReadInputTokens: 200, cacheWriteInputTokens: 0, outputTokens: 180, reasoningTokens: 120 },
    });
    expect(r).not.toHaveProperty('usageKnown');
    expect(r).not.toHaveProperty('priceTierMismatch');
    if (r.kind !== 'success') return;
    expect(r.latencyMs).toBeGreaterThan(0);
    expect(r.firstByteMs).toBeGreaterThan(0);
    expect(r.rawUsage).toMatchObject({ promptTokenCount: 1200, candidatesTokenCount: 60 });
  });

  it('MAX_TOKENS → truncated with the partial text', async () => {
    const r = await run(serve('max-tokens').fetch);

    expect(r).toMatchObject({ kind: 'truncated', rawText: '{"summary":"Partial', providerResponseId: 'gem_resp_maxtok_01' });
    expect(r).toMatchObject({ usage: { uncachedInputTokens: 1000, outputTokens: 120, reasoningTokens: 100 } });
    expect(r).not.toHaveProperty('rawStopReason');
  });

  it('SAFETY finish → refused with the reason as category', async () => {
    const r = await run(serve('safety-block').fetch);

    expect(r).toMatchObject({ kind: 'refused', category: 'SAFETY', usage: { uncachedInputTokens: 800, outputTokens: 40 } });
  });

  it('a blocked prompt (promptFeedback.blockReason) → refused', async () => {
    const r = await run(serve('prompt-blocked').fetch);

    expect(r).toMatchObject({ kind: 'refused', category: 'prompt_blocked:PROHIBITED_CONTENT', usage: { uncachedInputTokens: 40, outputTokens: 0 } });
    expect(r).not.toHaveProperty('usageKnown'); // promptTokenCount present and no text: known (the bill is the prompt)
  });

  it.each(['PROHIBITED_CONTENT', 'RECITATION', 'BLOCKLIST', 'SPII'])('%s finish → refused', async (reason) => {
    const chunk = event({ candidates: [{ finishReason: reason, index: 0 }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 }, responseId: 'r1' });
    const r = await run(serveChunks([chunk]).fetch);

    expect(r).toMatchObject({ kind: 'refused', category: reason });
  });

  it('any other finish reason → truncated with the raw reason', async () => {
    const chunk = event({ candidates: [{ content: { parts: [{ text: '{"a"' }] }, finishReason: 'OTHER' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 }, responseId: 'r1' });
    const r = await run(serveChunks([chunk]).fetch);

    expect(r).toMatchObject({ kind: 'truncated', rawText: '{"a"', rawStopReason: 'OTHER' });
  });

  it('ignores thought parts in the answer text and tolerates malformed JSON (json undefined)', async () => {
    const chunk = event({
      candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'not json' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 3 },
      responseId: 'r1',
    });
    const r = await run(serveChunks([chunk]).fetch);

    expect(r).toMatchObject({ kind: 'success', rawText: 'not json', json: undefined, usage: { outputTokens: 5, reasoningTokens: 3 } });
  });

  it('missing usage → usageKnown: false (zero placeholders, never a known $0)', async () => {
    const r = await run(serve('missing-usage').fetch);

    expect(r).toMatchObject({ kind: 'success', usageKnown: false, json: { summary: 'ok', findings: [] } });
    expect(r).toMatchObject({ usage: { uncachedInputTokens: 0, outputTokens: 0 } });
  });

  it('usage without candidatesTokenCount for a non-empty answer → usageKnown: false', async () => {
    const chunk = event({ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5 }, responseId: 'r1' });

    expect(await run(serveChunks([chunk]).fetch)).toMatchObject({ kind: 'success', usageKnown: false });
  });

  it('usage only on an earlier chunk (none on/after the finishReason chunk) → usageKnown: false (stale running count)', async () => {
    const r = await run(serve('stale-usage').fetch);

    expect(r).toMatchObject({ kind: 'success', usageKnown: false, json: { summary: 'ok', findings: [] }, providerResponseId: 'gem_resp_stale_01' });
    if (r.kind !== 'success') return;
    expect(r.rawUsage).toMatchObject({ promptTokenCount: 1200, candidatesTokenCount: 5 });
  });

  it('a usage-only chunk after the finishReason chunk is final → usage known', async () => {
    const chunks = [
      event({ candidates: [{ content: { parts: [{ text: '{}' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 }, responseId: 'r1' }),
      event({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], responseId: 'r1' }),
      event({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9 }, responseId: 'r1' }),
    ];
    const r = await run(serveChunks(chunks).fetch);

    expect(r).toMatchObject({ kind: 'success', usage: { outputTokens: 9 } });
    expect(r).not.toHaveProperty('usageKnown');
  });

  it.each(['flex', 'priority', 'FLEX', 'SERVICE_TIER_PRIORITY'])('a reported serviceTier %s sets priceTierMismatch', async (serviceTier) => {
    const chunk = event({
      candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, serviceTier },
      responseId: 'r1',
    });

    expect(await run(serveChunks([chunk]).fetch)).toMatchObject({ kind: 'success', priceTierMismatch: true });
  });

  it.each(['standard', 'unspecified', 'SERVICE_TIER_STANDARD'])('a reported serviceTier %s is the catalog tier (no mismatch)', async (serviceTier) => {
    const chunk = event({
      candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, serviceTier },
      responseId: 'r1',
    });
    const r = await run(serveChunks([chunk]).fetch);

    expect(r.kind).toBe('success');
    expect(r).not.toHaveProperty('priceTierMismatch');
  });

  it('a non-standard traffic type sets priceTierMismatch', async () => {
    const chunk = event({
      candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, trafficType: 'ON_DEMAND_PRIORITY' },
      responseId: 'r1',
    });

    expect(await run(serveChunks([chunk]).fetch)).toMatchObject({ kind: 'success', priceTierMismatch: true });
  });

  it('a throwing hook never changes the result', async () => {
    const warn = vi.fn();
    const adapter = createGeminiAdapter({ clock: tickingClock(), fetch: serve('success').fetch, logger: { warn } });
    const boom = (): never => {
      throw new Error('hook failed');
    };

    const r = await adapter.generate(request(), {
      apiKey: API_KEY,
      signal: new AbortController().signal,
      hooks: { onDispatched: boom, onResponseId: boom, onProgress: boom },
    });

    expect(r).toMatchObject({ kind: 'success', providerResponseId: 'gem_resp_success_01' });
    expect(warn).toHaveBeenCalled();
  });
});

describe('gemini adapter: mid-stream failures are never "not executed"', () => {
  it('an SSE error payload after the first chunk → REQUEST_OUTCOME_UNKNOWN / responded_partial with id + partial usage', async () => {
    const e = asError(await run(serve('midstream-error').fetch));

    expect(e.phase).toBe('responded_partial');
    expect(e.error.code).toBe('REQUEST_OUTCOME_UNKNOWN');
    expect(e.providerResponseId).toBe('gem_resp_midstream_01');
    expect(e.error.details?.['partialUsage']).toMatchObject({ uncachedInputTokens: 1000, cacheReadInputTokens: 200, outputTokens: 120 });
    // The SDK drops the `data: {"error":…}` event; the adapter recovers it from the raw stream for diagnosis (G4).
    expect(e.error.details?.['providerError']).toEqual({
      error: { code: 500, status: 'INTERNAL', message: expect.stringContaining('An internal error has occurred') as unknown },
    });
    expect(e.error.details?.['errorType']).toBe('INTERNAL');
  });

  it('an SSE error event is redacted, split across byte chunks, and never changes the classification', async () => {
    const first = geminiChunks(raw('success'))[0]!;
    const errEvent = event(errorBody(503, 'UNAVAILABLE', `overloaded for key ${API_KEY}`, [{ '@type': 'x.DebugInfo', detail: 'stack' }]));
    const mid = Math.floor(errEvent.length / 2);
    const e = asError(await run(serveChunks([first, errEvent.slice(0, mid), errEvent.slice(mid)]).fetch));

    expect(e).toMatchObject({ phase: 'responded_partial', providerResponseId: 'gem_resp_success_01' });
    expect(e.error.code).toBe('REQUEST_OUTCOME_UNKNOWN');
    expect(e.error.details?.['errorType']).toBe('UNAVAILABLE');
    expect(e.error.details?.['providerError']).toMatchObject({ error: { code: 503, status: 'UNAVAILABLE' } });
    expect(JSON.stringify(e.error.details?.['providerError'])).not.toContain('DebugInfo');
    expect(JSON.stringify(e)).not.toContain(API_KEY);
  });

  it('a malformed or non-object SSE error event attaches nothing', async () => {
    const first = geminiChunks(raw('success'))[0]!;
    const e = asError(await run(serveChunks([first, 'data: {"error": "boom"}\r\n\r\n', 'data: {"error": {not json\r\n\r\n']).fetch));

    expect(e.error.code).toBe('REQUEST_OUTCOME_UNKNOWN');
    expect(e.error.details).not.toHaveProperty('providerError');
  });

  it('a raw JSON error chunk (SDK ApiError mid-stream, even a 5xx) → unknown, never PROVIDER_UNAVAILABLE', async () => {
    const chunks = [geminiChunks(raw('success'))[0]!, JSON.stringify(errorBody(503, 'UNAVAILABLE', 'overloaded'))];
    const e = asError(await run(serveChunks(chunks).fetch));

    expect(e).toMatchObject({ phase: 'responded_partial', providerResponseId: 'gem_resp_success_01' });
    expect(e.error.code).toBe('REQUEST_OUTCOME_UNKNOWN');
  });

  it('a dropped connection after the first chunk → unknown / responded_partial', async () => {
    const text = raw('success');
    const firstLen = new TextEncoder().encode(geminiChunks(text)[0]).length;
    const e = asError(await run(serve('success', { errorAfterBytes: firstLen }).fetch));

    expect(e.phase).toBe('responded_partial');
    expect(e.error.code).toBe('REQUEST_OUTCOME_UNKNOWN');
    expect(e.providerResponseId).toBe('gem_resp_success_01');
  });

  it('a 2xx with an empty body → unknown / responded (accepted, outcome unknown)', async () => {
    const e = asError(await run(serveChunks([]).fetch));

    expect(e.phase).toBe('responded');
    expect(e.error.code).toBe('REQUEST_OUTCOME_UNKNOWN');
  });

  it('abort mid-stream → cancellation (details.aborted)', async () => {
    const ac = new AbortController();
    const { fetch } = serve('success', { hangAfterChunks: 1 });
    const pending = run(fetch, {}, { onResponseId: () => { setTimeout(() => { ac.abort(); }, 5); } }, ac.signal);

    const e = asError(await pending);

    expect(e.error.code).toBe('INTERNAL');
    expect(e.error.details?.['aborted']).toBe(true);
    expect(e.phase).toBe('responded_partial');
  });

  it('an already-aborted signal → cancellation, not_sent, never dispatched (the SDK still calls fetch)', async () => {
    const ac = new AbortController();
    ac.abort();
    // Like undici: an already-aborted signal rejects the fetch before anything is sent.
    const { fetch, calls } = createMockFetch((_url, init) => {
      if (init?.signal?.aborted === true) throw new DOMException('This operation was aborted', 'AbortError');
      return geminiSse(geminiChunks(raw('success')));
    });
    const onDispatched = vi.fn();
    const e = asError(await run(fetch, {}, { onDispatched }, ac.signal));

    expect(e.error.code).toBe('INTERNAL');
    expect(e.error.details?.['aborted']).toBe(true);
    expect(e.phase).toBe('not_sent');
    expect(onDispatched).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe('gemini adapter: HTTP and network errors (D3 table, no SDK retries)', () => {
  const failWith = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    createMockFetch(() => jsonResponse(status, body, headers));

  it.each([
    [500, 'INTERNAL', 'PROVIDER_UNAVAILABLE'],
    [503, 'UNAVAILABLE', 'PROVIDER_UNAVAILABLE'],
    [502, 'BAD_GATEWAY', 'REQUEST_OUTCOME_UNKNOWN'],
    [504, 'DEADLINE_EXCEEDED', 'REQUEST_OUTCOME_UNKNOWN'],
    [401, 'UNAUTHENTICATED', 'AUTH_REQUIRED'],
    [403, 'PERMISSION_DENIED', 'AUTH_REQUIRED'],
    [404, 'NOT_FOUND', 'MODEL_UNSUPPORTED'],
    [422, 'INVALID_ARGUMENT', 'MODEL_UNSUPPORTED'],
    [400, 'INVALID_ARGUMENT', 'MODEL_UNSUPPORTED'],
    [409, 'ABORTED', 'MODEL_UNSUPPORTED'],
  ])('%i → %s and exactly one fetch (no SDK retry)', async (status, rpcStatus, code) => {
    const { fetch, calls } = failWith(status, errorBody(status, rpcStatus, 'nope'));

    const e = asError(await run(fetch));

    expect(calls).toHaveLength(1);
    expect(e.phase).toBe('responded');
    expect(e.error.code).toBe(code);
    expect(e.error.details?.['status']).toBe(status);
    expect(e.error.details?.['errorType']).toBe(rpcStatus);
    if (status === 502 || status === 504) expect(e.error.details?.['gateway']).toBe(true);
  });

  it('429 → RATE_LIMITED with retryAfterMs from RetryInfo.retryDelay, one fetch', async () => {
    const body = errorBody(429, 'RESOURCE_EXHAUSTED', 'quota', [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12.5s' },
    ]);
    const { fetch, calls } = failWith(429, body);

    const e = asError(await run(fetch));

    expect(calls).toHaveLength(1);
    expect(e).toMatchObject({ phase: 'responded', retryAfterMs: 12_500 });
    expect(e.error.code).toBe('RATE_LIMITED');
  });

  it('429 without RetryInfo → RATE_LIMITED without retryAfterMs', async () => {
    const e = asError(await run(failWith(429, errorBody(429, 'RESOURCE_EXHAUSTED', 'quota', [{ '@type': 'x.RetryInfo', retryDelay: 'soon' }])).fetch));

    expect(e.error.code).toBe('RATE_LIMITED');
    expect(e).not.toHaveProperty('retryAfterMs');
  });

  it('400 API_KEY_INVALID → AUTH_REQUIRED (structured ErrorInfo reason), redacted, key never echoed', async () => {
    const body = errorBody(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' },
    ]);
    const e = asError(await run(failWith(400, body).fetch));

    expect(e.error.code).toBe('AUTH_REQUIRED');
    expect(e.error.details?.['providerError']).toBeDefined();
    expect(JSON.stringify(e)).not.toContain(API_KEY);
  });

  it('400 input token count exceeded → CONTEXT_TOO_LARGE', async () => {
    const msg = 'The input token count (2000000) exceeds the maximum number of tokens allowed (1048576).';
    const e = asError(await run(failWith(400, errorBody(400, 'INVALID_ARGUMENT', msg)).fetch));

    expect(e.error.code).toBe('CONTEXT_TOO_LARGE');
  });

  it('a non-JSON error body is still mapped by status', async () => {
    const { fetch } = createMockFetch(() => new Response('upstream exploded', { status: 500, statusText: 'Internal Server Error' }));

    const e = asError(await run(fetch));

    expect(e.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(e.phase).toBe('responded');
  });

  it('a DNS failure (ENOTFOUND) → PROVIDER_UNAVAILABLE / not_sent with causeCode', async () => {
    const { fetch } = createMockFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) });
    });

    const e = asError(await run(fetch));

    expect(e).toMatchObject({ phase: 'not_sent' });
    expect(e.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(e.error.details?.['causeCode']).toBe('ENOTFOUND');
  });

  it('a reset after sending (ECONNRESET) → REQUEST_OUTCOME_UNKNOWN / sent_no_response', async () => {
    const { fetch } = createMockFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    });

    const e = asError(await run(fetch));

    expect(e).toMatchObject({ phase: 'sent_no_response' });
    expect(e.error.code).toBe('REQUEST_OUTCOME_UNKNOWN');
  });
});

describe('toTypedGeminiError / helpers', () => {
  it('passes non-SDK errors through and types SDK ApiErrors by status', () => {
    const other = new Error('x');
    expect(toTypedGeminiError(other)).toBe(other);
    const typed = toTypedGeminiError(new ApiError({ message: 'not json', status: 418 })) as { status: number; message: string; error: unknown };
    expect(typed).toMatchObject({ status: 418, message: 'not json', error: { error: { message: 'not json' } } });
  });

  it('isGeminiPriceTierMismatch: only an explicit non-standard service tier or traffic type', () => {
    expect(isGeminiPriceTierMismatch(undefined)).toBe(false);
    expect(isGeminiPriceTierMismatch({})).toBe(false);
    expect(isGeminiPriceTierMismatch({ trafficType: 'ON_DEMAND' })).toBe(false);
    expect(isGeminiPriceTierMismatch({ trafficType: 'TRAFFIC_TYPE_UNSPECIFIED' })).toBe(false);
    expect(isGeminiPriceTierMismatch({ trafficType: 'ON_DEMAND_FLEX' })).toBe(true);
    expect(isGeminiPriceTierMismatch({ serviceTier: 'standard' })).toBe(false);
    expect(isGeminiPriceTierMismatch({ serviceTier: 'unspecified' })).toBe(false);
    expect(isGeminiPriceTierMismatch({ serviceTier: 'flex' })).toBe(true);
    expect(isGeminiPriceTierMismatch({ serviceTier: 'priority' })).toBe(true);
    expect(isGeminiPriceTierMismatch({ serviceTier: 'standard', trafficType: 'ON_DEMAND_PRIORITY' })).toBe(true);
  });

  it('mapGeminiEffort maps listed levels and throws otherwise', () => {
    expect(mapGeminiEffort('medium', { effortLevels: ['low', 'medium', 'high'] })).toBe('MEDIUM');
    expect(() => mapGeminiEffort('medium', { effortLevels: ['low'] })).toThrow(/not supported/);
    expect(() => mapGeminiEffort('max', { effortLevels: ['max'] })).toThrow(/not supported/);
  });
});

describe('gemini adapter: estimate', () => {
  it('with a key: countTokens over contents + system + schema, plus the framing allowance (provider_count)', async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse(200, { totalTokens: 900 }));
    const adapter = createGeminiAdapter({ clock: tickingClock(), fetch });

    const est = await adapter.estimate(request(), PRICES, { apiKey: API_KEY, signal: new AbortController().signal, priceCatalogVersion: 'v1' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/${MODEL}:countTokens`);
    expect(calls[0]!.headers.get('x-goog-api-key')).toBe(API_KEY);
    const rawBody = JSON.stringify(calls[0]!.body);
    expect(rawBody).toContain('You are the reviewer.');
    expect(rawBody).toContain('Review the selected files.');
    expect(rawBody).toContain('findings');
    expect(est).toMatchObject({ basis: 'provider_count', inputTokens: 900 + LOCAL_REQUEST_OVERHEAD_TOKENS, maxOutputTokens: 8000, priceCatalogVersion: 'v1' });
  });

  it('without a key: local estimate, no fetch', async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse(200, { totalTokens: 1 }));
    const est = await createGeminiAdapter({ clock: tickingClock(), fetch }).estimate(request(), PRICES);

    expect(calls).toHaveLength(0);
    expect(est).toMatchObject({ basis: 'local_estimate', inputTokens: localInputTokens(request()) });
  });

  it('count failure on a model without a price tier (gemini-3.5-flash) → the chars/3.2 heuristic, logged', async () => {
    const warn = vi.fn();
    const { fetch } = createMockFetch(() => jsonResponse(500, errorBody(500, 'INTERNAL', 'x')));
    const est = await createGeminiAdapter({ clock: tickingClock(), fetch, logger: { warn } }).estimate(request(), PRICES, { apiKey: API_KEY });

    expect(est).toMatchObject({ basis: 'local_estimate', inputTokens: localInputTokens(request()) });
    expect(warn).toHaveBeenCalledWith('provider.count_tokens_failed', expect.objectContaining({ providerId: 'gemini' }));
  });

  it('count failure on a model with a price tier → conservative one-token-per-code-unit bound', async () => {
    const entry = catalogModule.findCatalogEntry('gemini', MODEL)!;
    vi.spyOn(catalogModule, 'findCatalogEntry').mockReturnValue({ ...entry, capabilities: { ...entry.capabilities, priceCliffInputTokens: 200_000 } });
    const { fetch } = createMockFetch(() => jsonResponse(500, errorBody(500, 'INTERNAL', 'x')));
    const est = await createGeminiAdapter({ clock: tickingClock(), fetch }).estimate(request(), PRICES, { apiKey: API_KEY });

    expect(est).toMatchObject({ basis: 'local_estimate', inputTokens: conservativeInputTokens(request()) });
    expect(est.inputTokens).toBeGreaterThanOrEqual(localInputTokens(request()));
  });

  it('a count response without totalTokens is a count failure', async () => {
    const { fetch } = createMockFetch(() => jsonResponse(200, {}));
    const est = await createGeminiAdapter({ clock: tickingClock(), fetch }).estimate(request(), PRICES, { apiKey: API_KEY });

    expect(est.basis).toBe('local_estimate');
  });

  it('a model not in the catalog never calls countTokens', async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse(200, { totalTokens: 1 }));
    const est = await createGeminiAdapter({ clock: tickingClock(), fetch }).estimate(request({ modelId: 'gemini-unknown' }), PRICES, { apiKey: API_KEY });

    expect(calls).toHaveLength(0);
    expect(est.basis).toBe('local_estimate');
  });
});

describe('gemini adapter: capabilities and testConnection', () => {
  it('reports catalog capabilities and rejects unknown models', async () => {
    const adapter = createGeminiAdapter({ clock: tickingClock() });

    await expect(adapter.capabilities(MODEL)).resolves.toMatchObject({ structuredOutput: true, streaming: true, supportsRequestLookup: false });
    await expect(adapter.capabilities('nope')).rejects.toBeInstanceOf(RelayError);
    expect('reconcile' in adapter).toBe(false);
    expect(adapter.providerId).toBe('gemini');
  });

  it('testConnection: tiny schema, lowest thinking level, 256-token allowance', async () => {
    const { fetch, calls } = serve('success');
    const adapter = createGeminiAdapter({ clock: tickingClock(), fetch });

    const r = await adapter.testConnection({ apiKey: API_KEY, signal: new AbortController().signal, modelId: MODEL });

    expect(r.kind).toBe('success');
    expect(bodyOf(calls[0])['generationConfig']).toMatchObject({
      maxOutputTokens: GEMINI_CONNECTION_TEST_MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingLevel: 'LOW' },
      responseJsonSchema: { required: ['ok'] },
    });
  });

  it('testConnection for an unknown model sends no thinking level', async () => {
    const { fetch, calls } = serve('success');
    await createGeminiAdapter({ clock: tickingClock(), fetch }).testConnection({ apiKey: API_KEY, signal: new AbortController().signal, modelId: 'gemini-x' });

    expect(bodyOf(calls[0])['generationConfig']).not.toHaveProperty('thinkingConfig');
  });

  it('reads globalThis.fetch at call time when no fetch is injected', async () => {
    const { fetch, calls } = serve('success');
    vi.stubGlobal('fetch', fetch);
    try {
      const r = await createGeminiAdapter({ clock: tickingClock() }).generate(request(), { apiKey: API_KEY, signal: new AbortController().signal });
      expect(r.kind).toBe('success');
      expect(calls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
