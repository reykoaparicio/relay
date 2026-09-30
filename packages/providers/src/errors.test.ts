import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { epochMs } from '@relay/contracts';
import { manualClock } from './__fixtures__/mock-fetch.js';
import { RETRY_AFTER_CAP_MS, mapProviderError, parseRetryAfterMs } from './errors.js';
import type { MapErrorContext, SdkErrorClasses } from './errors.js';
import type { DispatchTracker } from './tracked-fetch.js';

const CLASSES: SdkErrorClasses = {
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

const clock = manualClock(1_000_000);
const notSent: DispatchTracker = { phase: 'not_sent' };
const sent: DispatchTracker = { phase: 'sent_no_response', dispatchedAt: epochMs(1) };
const responded = (status: number, requestId = 'req_hdr'): DispatchTracker => ({ phase: 'responded', status, requestId });
const partial: DispatchTracker = { phase: 'responded_partial', status: 200, firstByteAt: epochMs(5), requestId: 'req_hdr' };

const ctx = (tracker: DispatchTracker, extra: Partial<MapErrorContext> = {}): MapErrorContext => ({
  providerId: 'anthropic',
  tracker,
  classes: CLASSES,
  clock,
  ...extra,
});

const headers = (h: Record<string, string> = {}): Headers => new Headers(h);
const body = (type: string, message: string) => ({ type: 'error', error: { type, message } });
const statusError = (status: number, type: string, message: string, h: Record<string, string> = {}) =>
  Anthropic.APIError.generate(status, body(type, message), message, headers(h));

describe('mapProviderError — D3 rows in order', () => {
  it('row 1: our abort → INTERNAL with details.aborted and the tracker phase', () => {
    const r = mapProviderError(new Anthropic.APIUserAbortError(), ctx(partial));

    expect(r.error.code).toBe('INTERNAL');
    expect(r.error.details?.['aborted']).toBe(true);
    expect(r.phase).toBe('responded_partial');
  });

  it('row 1 wins even when the SDK surfaced another error while our signal was aborted', () => {
    const r = mapProviderError(new Error('boom'), ctx(sent, { aborted: true }));

    expect(r.error.code).toBe('INTERNAL');
    expect(r.phase).toBe('sent_no_response');
  });

  it.each([
    ['overloaded_error SSE event', new Anthropic.APIError(undefined, body('overloaded_error', 'Overloaded'), undefined, headers(), 'overloaded_error')],
    ['api_error SSE event', new Anthropic.APIError(undefined, body('api_error', 'Internal'), undefined, headers(), 'api_error')],
    ['mid-stream connection drop', new Anthropic.AnthropicError('terminated')],
    ['a 529-looking status after the first byte', statusError(529, 'overloaded_error', 'Overloaded')],
  ])('row 2: %s after firstByteAt → REQUEST_OUTCOME_UNKNOWN / responded_partial, never PROVIDER_UNAVAILABLE', (_n, err) => {
    const partialUsage = { uncachedInputTokens: 10, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 3 };

    const r = mapProviderError(err, ctx(partial, { providerResponseId: 'msg_1', partialUsage }));

    expect(r.error.code).toBe('REQUEST_OUTCOME_UNKNOWN');
    expect(r.phase).toBe('responded_partial');
    expect(r.providerResponseId).toBe('msg_1');
    expect(r.error.details?.['partialUsage']).toEqual(partialUsage);
    expect(r.error.retryable).toBe(false);
  });

  it('row 3: 2xx status line but the stream failed before any body byte → unknown / responded', () => {
    const r = mapProviderError(new Anthropic.AnthropicError('request ended without sending any chunks'), ctx(responded(200)));

    expect(r.error.code).toBe('REQUEST_OUTCOME_UNKNOWN');
    expect(r.phase).toBe('responded');
  });

  it('row 4: connection error with tracker not_sent → PROVIDER_UNAVAILABLE with causeCode', () => {
    const tracker: DispatchTracker = { phase: 'not_sent', causeCode: 'ENOTFOUND', dispatchedAt: epochMs(1) };

    const r = mapProviderError(new Anthropic.APIConnectionError({ message: 'Connection error.' }), ctx(tracker));

    expect(r.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(r.phase).toBe('not_sent');
    expect(r.error.details?.['causeCode']).toBe('ENOTFOUND');
    expect(r.error.retryable).toBe(true);
  });

  it('row 5: connection error (or timeout) after dispatch → REQUEST_OUTCOME_UNKNOWN with causeCode', () => {
    const tracker: DispatchTracker = { phase: 'sent_no_response', causeCode: 'ECONNRESET', dispatchedAt: epochMs(1) };

    const reset = mapProviderError(new Anthropic.APIConnectionError({ message: 'Connection error.' }), ctx(tracker));
    const timeout = mapProviderError(new Anthropic.APIConnectionTimeoutError(), ctx(sent));

    expect(reset.error.code).toBe('REQUEST_OUTCOME_UNKNOWN');
    expect(reset.phase).toBe('sent_no_response');
    expect(reset.error.details?.['causeCode']).toBe('ECONNRESET');
    expect(timeout.error.code).toBe('REQUEST_OUTCOME_UNKNOWN');
  });

  it('row 6: HTTP 529 → RATE_LIMITED (checked before InternalServerError) with capped retry-after', () => {
    const err = statusError(529, 'overloaded_error', 'Overloaded', { 'retry-after': '120' });
    expect(err).toBeInstanceOf(Anthropic.InternalServerError);

    const r = mapProviderError(err, ctx(responded(529)));

    expect(r.error.code).toBe('RATE_LIMITED');
    expect(r.phase).toBe('responded');
    expect(r.retryAfterMs).toBe(RETRY_AFTER_CAP_MS);
  });

  it('row 7: 429 → RATE_LIMITED with retryAfterMs = retry-after × 1000', () => {
    const r = mapProviderError(statusError(429, 'rate_limit_error', 'slow down', { 'retry-after': '7' }), ctx(responded(429)));

    expect(r.error.code).toBe('RATE_LIMITED');
    expect(r.retryAfterMs).toBe(7000);
    expect(r.error.details?.['retryAfterMs']).toBe(7000);
    expect(r.providerRequestId).toBe('req_hdr');
  });

  it('row 7: 429 without retry-after leaves retryAfterMs unset', () => {
    const r = mapProviderError(statusError(429, 'rate_limit_error', 'slow down'), ctx(responded(429)));

    expect(r.retryAfterMs).toBeUndefined();
  });

  it.each([
    [401, 'authentication_error'],
    [403, 'permission_error'],
  ])('row 8: %i → AUTH_REQUIRED (pause immediately)', (status, type) => {
    const r = mapProviderError(statusError(status, type, 'invalid x-api-key'), ctx(responded(status)));

    expect(r.error.code).toBe('AUTH_REQUIRED');
    expect(r.error.retryable).toBe(false);
  });

  it('row 9: 404 → MODEL_UNSUPPORTED', () => {
    const r = mapProviderError(statusError(404, 'not_found_error', 'model: claude-nope'), ctx(responded(404)));

    expect(r.error.code).toBe('MODEL_UNSUPPORTED');
  });

  it('row 10a: 400 prompt too long → CONTEXT_TOO_LARGE', () => {
    const r = mapProviderError(
      statusError(400, 'invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'),
      ctx(responded(400)),
    );

    expect(r.error.code).toBe('CONTEXT_TOO_LARGE');
  });

  it('row 10b: other 400 and 422 → MODEL_UNSUPPORTED with the provider body redacted', () => {
    const leaky = statusError(400, 'invalid_request_error', 'bad key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA1234');

    const r400 = mapProviderError(leaky, ctx(responded(400)));
    const r422 = mapProviderError(statusError(422, 'invalid_request_error', 'unprocessable'), ctx(responded(422)));

    expect(r400.error.code).toBe('MODEL_UNSUPPORTED');
    expect(r422.error.code).toBe('MODEL_UNSUPPORTED');
    const serialized = JSON.stringify(r400.error.details?.['providerError']);
    expect(serialized).toContain('[REDACTED');
    expect(serialized).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('row 11: other 5xx before any body byte → PROVIDER_UNAVAILABLE (transport-retryable)', () => {
    const r = mapProviderError(statusError(500, 'api_error', 'Internal server error'), ctx(responded(500)));

    expect(r.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(r.phase).toBe('responded');
    expect(r.error.retryable).toBe(true);
  });

  it('maps 413 to CONTEXT_TOO_LARGE and 402 billing to AUTH_REQUIRED', () => {
    expect(mapProviderError(statusError(413, 'request_too_large', 'too large'), ctx(responded(413))).error.code).toBe('CONTEXT_TOO_LARGE');
    expect(mapProviderError(statusError(402, 'billing_error', 'billing'), ctx(responded(402))).error.code).toBe('AUTH_REQUIRED');
  });

  it('maps a non-SDK error before dispatch to INTERNAL/not_sent and after dispatch to unknown', () => {
    expect(mapProviderError(new TypeError('bug'), ctx(notSent))).toMatchObject({ phase: 'not_sent', error: { code: 'INTERNAL' } });
    expect(mapProviderError('weird', ctx(sent))).toMatchObject({ phase: 'sent_no_response', error: { code: 'REQUEST_OUTCOME_UNKNOWN' } });
  });

  it('prefers the header request id and falls back to the SDK requestID', () => {
    const err = statusError(500, 'api_error', 'x', { 'request-id': 'req_sdk' });

    expect(mapProviderError(err, ctx({ phase: 'responded', status: 500 })).providerRequestId).toBe('req_sdk');
    expect(mapProviderError(err, ctx(responded(500, 'req_hdr'))).providerRequestId).toBe('req_hdr');
  });

  it('never puts provider text into userMessage', () => {
    const r = mapProviderError(statusError(400, 'invalid_request_error', 'secret-ish detail'), ctx(responded(400)));

    expect(r.error.userMessage).not.toContain('secret-ish');
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds, HTTP dates, and caps at 60 s', () => {
    const c = manualClock(Date.parse('2026-09-30T00:00:00Z'));

    expect(parseRetryAfterMs(headers({ 'retry-after': '1.5' }), c)).toBe(1500);
    expect(parseRetryAfterMs(headers({ 'retry-after': 'Wed, 30 Sep 2026 00:00:10 GMT' }), c)).toBe(10_000);
    expect(parseRetryAfterMs(headers({ 'retry-after': 'Wed, 30 Sep 2026 00:05:00 GMT' }), c)).toBe(RETRY_AFTER_CAP_MS);
    expect(parseRetryAfterMs(headers({ 'retry-after': '-5' }), c)).toBe(0);
    expect(parseRetryAfterMs(headers({ 'retry-after': 'soon' }), c)).toBeUndefined();
    expect(parseRetryAfterMs(headers(), c)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, c)).toBeUndefined();
  });
});
