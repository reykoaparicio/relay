import { ApiError } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { GeminiApiError, rpcStatusOf, toTypedGeminiError } from './gemini-errors.js';
import { sseErrorOf } from './gemini-sse.js';

describe('rpcStatusOf (untrusted google.rpc.Status bodies)', () => {
  it('reads only correctly typed fields and drops malformed details', () => {
    const body = {
      error: {
        code: 429,
        message: 'slow down',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }, 'junk', null, { reason: 7 }],
      },
    };

    expect(rpcStatusOf(body)).toEqual({
      code: 429,
      message: 'slow down',
      status: 'RESOURCE_EXHAUSTED',
      details: [{ type: 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }, {}],
    });
  });

  it.each([[undefined], [null], ['text'], [[]], [{ error: 'x' }], [{ error: [] }]])('has no status for %j', (body) => {
    expect(rpcStatusOf(body)).toBeUndefined();
  });

  it('wrong-typed fields are ignored instead of trusted', () => {
    expect(rpcStatusOf({ error: { message: 1, status: {}, details: 'nope', code: '429' } })).toEqual({ details: [] });
  });
});

describe('toTypedGeminiError with hostile bodies', () => {
  it('a non-string status or message never becomes the error type or message', () => {
    const e = toTypedGeminiError(new ApiError({ message: JSON.stringify({ error: { message: { x: 1 }, status: 5 } }), status: 400 }));

    expect(e).toBeInstanceOf(GeminiApiError);
    expect((e as GeminiApiError).type).toBeUndefined();
    expect(typeof (e as GeminiApiError).message).toBe('string');
  });

  it('an API-key ErrorInfo reason maps to the authentication class; a RetryInfo delay becomes retry-after', () => {
    const auth = toTypedGeminiError(
      new ApiError({ message: JSON.stringify({ error: { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }), status: 400 }),
    ) as GeminiApiError;
    const limited = toTypedGeminiError(
      new ApiError({ message: JSON.stringify({ error: { details: [{ '@type': 'x/google.rpc.RetryInfo', retryDelay: '1.5s' }] } }), status: 429 }),
    ) as GeminiApiError;

    expect(auth.constructor.name).toBe('GeminiAuthenticationError');
    expect(limited.headers?.get('retry-after')).toBe('1.5');
  });
});

describe('sseErrorOf', () => {
  it('keeps typed code/status/message of an SSE error event and ignores other data', () => {
    expect(sseErrorOf('data: {"error":{"code":500,"status":"INTERNAL","message":"m","extra":1}}')).toEqual({ code: 500, status: 'INTERNAL', message: 'm' });
    expect(sseErrorOf('data: {"error":{"code":"500"}}')).toEqual({});
    expect(sseErrorOf('data: {"candidates":[]}')).toBeUndefined();
    expect(sseErrorOf('data: {"error": not json')).toBeUndefined();
  });
});
