import { describe, expect, it, vi } from 'vitest';
import { createMockFetch, jsonResponse, sseResponse, tickingClock } from './__fixtures__/mock-fetch.js';
import { causeCodeOf, createTrackedFetch, isNotSentCause } from './tracked-fetch.js';

const rejectingFetch = (cause: unknown): typeof fetch =>
  createMockFetch(() => Promise.reject(Object.assign(new TypeError('fetch failed'), cause === undefined ? {} : { cause }))).fetch;

describe('createTrackedFetch', () => {
  it('reports not_sent before the wrapped fetch is invoked', () => {
    const base = vi.fn<typeof fetch>();

    const { tracker } = createTrackedFetch(base, { clock: tickingClock() });

    expect(tracker.phase).toBe('not_sent');
    expect(base).not.toHaveBeenCalled();
  });

  it.each([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'UND_ERR_CONNECT_TIMEOUT',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ])('classifies a rejection with cause.code %s as not_sent and stores the code', async (code) => {
    const { fetch: tracked, tracker } = createTrackedFetch(rejectingFetch({ code }), { clock: tickingClock() });

    await expect(tracked('https://example.invalid/v1')).rejects.toThrow('fetch failed');

    expect(tracker.phase).toBe('not_sent');
    expect(tracker.causeCode).toBe(code);
  });

  it.each([['ECONNRESET'], ['UND_ERR_SOCKET']])('keeps sent_no_response for cause.code %s', async (code) => {
    const { fetch: tracked, tracker } = createTrackedFetch(rejectingFetch({ code }), { clock: tickingClock() });

    await expect(tracked('https://example.invalid/v1')).rejects.toThrow();

    expect(tracker.phase).toBe('sent_no_response');
    expect(tracker.causeCode).toBe(code);
  });

  it('keeps sent_no_response when the rejection has no cause', async () => {
    const { fetch: tracked, tracker } = createTrackedFetch(rejectingFetch(undefined), { clock: tickingClock() });

    await expect(tracked('https://example.invalid/v1')).rejects.toThrow();

    expect(tracker.phase).toBe('sent_no_response');
    expect(tracker.causeCode).toBeUndefined();
  });

  it('fires onDispatched exactly once, at invocation', async () => {
    const onDispatched = vi.fn();
    let seenAtCall = -1;
    const { fetch: base } = createMockFetch(() => {
      seenAtCall = onDispatched.mock.calls.length;
      return jsonResponse(200, {});
    });
    const { fetch: tracked } = createTrackedFetch(base, { clock: tickingClock(), onDispatched });

    await tracked('https://example.invalid/a');
    await tracked('https://example.invalid/b');

    expect(seenAtCall).toBe(1);
    expect(onDispatched).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing onDispatched hook', async () => {
    const warn = vi.fn();
    const { fetch: base } = createMockFetch(() => jsonResponse(200, {}));
    const { fetch: tracked, tracker } = createTrackedFetch(base, {
      clock: tickingClock(),
      logger: { warn },
      onDispatched: () => {
        throw new Error('hook bug');
      },
    });

    await tracked('https://example.invalid/a');

    expect(tracker.phase).toBe('responded');
    expect(warn).toHaveBeenCalledWith('provider.hook_failed', { hook: 'onDispatched', errorName: 'Error' });
  });

  it.each([['request-id'], ['x-request-id']])('captures the %s header and the status', async (header) => {
    const { fetch: base } = createMockFetch(() => jsonResponse(429, { error: {} }, { [header]: 'req_abc' }));
    const { fetch: tracked, tracker } = createTrackedFetch(base, { clock: tickingClock() });

    await tracked('https://example.invalid/a');

    expect(tracker.phase).toBe('responded');
    expect(tracker.status).toBe(429);
    expect(tracker.requestId).toBe('req_abc');
  });

  it('sets firstByteAt and responded_partial on the first 2xx body chunk only', async () => {
    const { fetch: base } = createMockFetch(() => sseResponse('event: ping\ndata: {}\n\nevent: ping\ndata: {}\n\n'));
    const { fetch: tracked, tracker } = createTrackedFetch(base, { clock: tickingClock() });

    const res = await tracked('https://example.invalid/a');
    expect(tracker.phase).toBe('responded');
    expect(tracker.firstByteAt).toBeUndefined();
    const reader = res.body!.getReader();
    await reader.read();
    const first = tracker.firstByteAt;
    await reader.read();

    expect(tracker.phase).toBe('responded_partial');
    expect(first).toBeDefined();
    expect(tracker.firstByteAt).toBe(first);
  });

  it('does not track the body of a 5xx response', async () => {
    const { fetch: base } = createMockFetch(() => jsonResponse(500, { error: { type: 'api_error' } }));
    const { fetch: tracked, tracker } = createTrackedFetch(base, { clock: tickingClock() });

    const res = await tracked('https://example.invalid/a');
    await res.text();

    expect(tracker.phase).toBe('responded');
    expect(tracker.firstByteAt).toBeUndefined();
  });

  it('passes a 2xx response without body through untouched', async () => {
    const { fetch: base } = createMockFetch(() => new Response(null, { status: 204 }));
    const { fetch: tracked, tracker } = createTrackedFetch(base, { clock: tickingClock() });

    const res = await tracked('https://example.invalid/a');

    expect(res.status).toBe(204);
    expect(tracker.phase).toBe('responded');
  });
});

describe('cause code helpers', () => {
  it('reads cause.code first, then code', () => {
    expect(causeCodeOf({ cause: { code: 'A' }, code: 'B' })).toBe('A');
    expect(causeCodeOf({ code: 'B' })).toBe('B');
    expect(causeCodeOf('nope')).toBeUndefined();
    expect(causeCodeOf({ cause: { code: 42 } })).toBeUndefined();
  });

  it('recognizes CERT_* / ERR_TLS_* prefixes and self-signed certificates', () => {
    expect(isNotSentCause('CERT_UNTRUSTED')).toBe(true);
    expect(isNotSentCause('ERR_TLS_HANDSHAKE_TIMEOUT')).toBe(true);
    expect(isNotSentCause('DEPTH_ZERO_SELF_SIGNED_CERT')).toBe(true);
    expect(isNotSentCause('ECONNRESET')).toBe(false);
    expect(isNotSentCause(undefined)).toBe(false);
  });
});
