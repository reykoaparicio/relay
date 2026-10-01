// 04 §D10: mid-stream SSE `{"error":…}` events. The Gemini SDK parses such an event into an empty chunk (its converter
// keeps only known response fields), so the error would be lost; this module watches the raw body for them.
import { rpcStatusOf } from './gemini-errors.js';
import { tryParseJson } from './json.js';

/** The `google.rpc.Status` fields kept from a mid-stream SSE error event (redacted before storage). */
export interface SseErrorPayload {
  readonly code?: number;
  readonly status?: string;
  readonly message?: string;
}

const SSE_EVENT_DELIMITER = /\r\n\r\n|\n\n|\r\r/;
const SSE_ERROR_DATA = /^\{\s*"error"\s*:/;

/** Parses one SSE event; returns its error payload when the `data:` is a `{"error":{…}}` object. */
export function sseErrorOf(eventText: string): SseErrorPayload | undefined {
  const data = eventText
    .split(/\r\n|\n|\r/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n');
  if (!SSE_ERROR_DATA.test(data)) return undefined;
  const rpc = rpcStatusOf(tryParseJson(data));
  if (rpc === undefined) return undefined;
  return {
    ...(rpc.code === undefined ? {} : { code: rpc.code }),
    ...(rpc.status === undefined ? {} : { status: rpc.status }),
    ...(rpc.message === undefined ? {} : { message: rpc.message }),
  };
}

/**
 * Passes a 2xx stream body through unchanged while watching for SSE `data: {"error":…}` events and reporting each to
 * `onError`. Non-2xx responses and bodiless responses are returned as is.
 */
export function watchSseErrors(response: Response, onError: (e: SseErrorPayload) => void): Response {
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

/** The mapper's `streamError`: the redacted `{code,status,message}` body plus the RPC status as `errorType`. */
export function streamErrorOf(e: SseErrorPayload): { readonly providerError: unknown; readonly errorType?: string } {
  return { providerError: { error: e }, ...(e.status === undefined ? {} : { errorType: e.status }) };
}
