// Test-only helpers: an injected mock fetch that serves recorded SSE streams (no network, no globalThis.fetch).
import { epochMs } from '@relay/contracts';
import type { Clock } from '@relay/contracts';

/** One recorded invocation of the mock fetch. */
export interface MockFetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
  readonly headers: Headers;
  readonly body: unknown;
}

/** Splits an SSE file into one chunk per event (each chunk keeps its trailing blank line). */
export function sseChunks(text: string): string[] {
  return text.split(/(?<=\n\n)/).filter((c) => c.length > 0);
}

/** Options of {@link streamBody}. */
export interface StreamBodyOptions {
  /** Error the stream (connection drop) once at least this many bytes were delivered. */
  readonly errorAfterBytes?: number;
  /** Before delivering chunk `index`, wait for this promise (lets a test observe mid-stream state). */
  readonly gate?: { readonly index: number; readonly wait: Promise<void> };
  /** Stop after this many chunks and never close (until aborted). */
  readonly hangAfterChunks?: number;
  readonly signal?: AbortSignal | null | undefined;
}

/** Builds a pull-based body from chunks; honors the request signal like undici does. */
export function streamBody(chunks: readonly string[], opts: StreamBodyOptions = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      opts.signal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('This operation was aborted', 'AbortError'));
        } catch {
          // already closed
        }
      }, { once: true });
    },
    async pull(controller) {
      if (opts.gate !== undefined && i === opts.gate.index) await opts.gate.wait;
      if (opts.hangAfterChunks !== undefined && i >= opts.hangAfterChunks) {
        await new Promise<void>(() => undefined); // never resolves; the abort listener errors the stream
        return;
      }
      if (opts.errorAfterBytes !== undefined && sent >= opts.errorAfterBytes) {
        controller.error(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }));
        return;
      }
      const chunk = chunks[i];
      i += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      const bytes = enc.encode(chunk);
      sent += bytes.length;
      controller.enqueue(bytes);
    },
  });
}

/** An SSE `Response` with a request id header. */
export function sseResponse(text: string, opts: StreamBodyOptions & { readonly requestId?: string } = {}): Response {
  return new Response(streamBody(sseChunks(text), opts), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...(opts.requestId === undefined ? {} : { 'request-id': opts.requestId }) },
  });
}

/** A JSON `Response`. */
export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Wraps a handler as an injected fetch that records every call. */
export function createMockFetch(
  handler: (url: string, init: RequestInit | undefined, call: MockFetchCall) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: MockFetchCall[] } {
  const calls: MockFetchCall[] = [];
  const mock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rawBody = init?.body;
    const body = typeof rawBody === 'string' ? (JSON.parse(rawBody) as unknown) : undefined;
    const call: MockFetchCall = { url, init, headers: new Headers(init?.headers), body };
    calls.push(call);
    return handler(url, init, call);
  };
  return { fetch: mock, calls };
}

/** Deterministic clock advancing 1 ms per read. */
export function tickingClock(start = 1_000_000): Clock {
  let t = start;
  return {
    now: () => {
      t += 1;
      return epochMs(t);
    },
  };
}

/** Clock whose time only changes via `advance`. */
export function manualClock(start = 1_000_000): Clock & { advance(ms: number): void } {
  let t = start;
  return {
    now: () => epochMs(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}
