// 04 §D3: dispatch phase is decided mechanically from what the fetch actually did, never guessed from error text.
import type { Clock, EpochMs } from '@relay/contracts';
import { NOOP_LOGGER, safeHook } from './safe-hook.js';
import type { DispatchPhase, Logger } from './types.js';

/** What one tracked request has done so far. */
export interface DispatchTracker {
  readonly phase: DispatchPhase;
  /** `err.cause?.code` when the base fetch rejected. */
  readonly causeCode?: string;
  /** From the `request-id` / `x-request-id` response header. */
  readonly requestId?: string;
  readonly status?: number;
  /** First body chunk of a 2xx response. */
  readonly firstByteAt?: EpochMs;
  /** When the fetch was invoked. */
  readonly dispatchedAt?: EpochMs;
}

/** Cause codes proving the request never reached the provider (DNS, refused, connect timeout, TLS, unreachable). */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);

/** True when a fetch rejection with this cause code provably never carried the request. */
export function isNotSentCause(code: string | undefined): boolean {
  if (code === undefined) return false;
  return NOT_SENT_CODES.has(code) || code.startsWith('CERT_') || code.startsWith('ERR_TLS_');
}

function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined;
  const code = (value).code;
  return typeof code === 'string' ? code : undefined;
}

/** `err.cause.code` (undici's shape), falling back to `err.code`. */
export function causeCodeOf(err: unknown): string | undefined {
  const cause = typeof err === 'object' && err !== null && 'cause' in err ? (err).cause : undefined;
  return codeOf(cause) ?? codeOf(err);
}

interface MutableTracker {
  phase: DispatchPhase;
  causeCode?: string;
  requestId?: string;
  status?: number;
  firstByteAt?: EpochMs;
  dispatchedAt?: EpochMs;
}

function trackBody(response: Response, onFirstChunk: () => void): Response {
  if (response.body === null) return response;
  let seen = false;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!seen) {
          seen = true;
          onFirstChunk();
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** True when the request's signal (from `init`, else from a `Request` input) is already aborted. */
export function isSignalAborted(input: string | URL | Request, init?: RequestInit): boolean {
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  return signal?.aborted === true;
}

/** The `AbortError` fetch rejects with for an aborted signal. */
export function abortError(): DOMException {
  return new DOMException('This operation was aborted', 'AbortError');
}

/**
 * Wraps an injected base fetch so every request records its {@link DispatchPhase}. One tracker per
 * `generate` / `testConnection` / `reconcile` / count call; `onDispatched` fires once, at the first invocation.
 */
export function createTrackedFetch(
  baseFetch: typeof fetch,
  opts: { readonly clock: Clock; readonly onDispatched?: () => void; readonly logger?: Logger },
): { fetch: typeof fetch; tracker: DispatchTracker } {
  const tracker: MutableTracker = { phase: 'not_sent' };
  const logger = opts.logger ?? NOOP_LOGGER;
  const tracked = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // A request whose signal is already aborted is never sent (fetch rejects before opening a connection), so it must
    // not be marked dispatched: the phase stays `not_sent` and `onDispatched` does not fire.
    if (isSignalAborted(input, init)) throw abortError();
    if (tracker.dispatchedAt === undefined) {
      tracker.dispatchedAt = opts.clock.now();
      safeHook('onDispatched', opts.onDispatched, logger);
    }
    tracker.phase = 'sent_no_response';
    let response: Response;
    try {
      response = await baseFetch(input, init);
    } catch (err) {
      const code = causeCodeOf(err);
      if (code !== undefined) tracker.causeCode = code;
      if (isNotSentCause(code)) tracker.phase = 'not_sent';
      throw err;
    }
    tracker.phase = 'responded';
    tracker.status = response.status;
    const requestId = response.headers.get('request-id') ?? response.headers.get('x-request-id');
    if (requestId !== null) tracker.requestId = requestId;
    if (response.status < 200 || response.status >= 300) return response; // complete error response; not tracked
    return trackBody(response, () => {
      tracker.firstByteAt = opts.clock.now();
      tracker.phase = 'responded_partial';
    });
  };
  return { fetch: tracked, tracker };
}
