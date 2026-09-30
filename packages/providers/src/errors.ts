// 04 §D3 mapping chain: specific-first, evaluated top to bottom, first match wins. Classification uses instanceof and
// the tracker's mechanically recorded phase — never error-message matching (except row 10a, "prompt too long").
import { appError, redactDeep } from '@relay/contracts';
import type { Clock, ErrorCode, ProviderId } from '@relay/contracts';
import type { DispatchTracker } from './tracked-fetch.js';
import type { DispatchPhase, ModelError, NormalizedUsage } from './types.js';

type ErrorClass = abstract new (...args: never[]) => unknown;

/** The SDK error classes the chain needs. The Anthropic and OpenAI TypeScript SDKs export the same names. */
export interface SdkErrorClasses {
  readonly APIError: ErrorClass;
  readonly APIUserAbortError: ErrorClass;
  /** `APIConnectionTimeoutError` is a subclass, so it is covered too. */
  readonly APIConnectionError: ErrorClass;
  readonly RateLimitError: ErrorClass;
  readonly AuthenticationError: ErrorClass;
  readonly PermissionDeniedError: ErrorClass;
  readonly NotFoundError: ErrorClass;
  readonly BadRequestError: ErrorClass;
  readonly UnprocessableEntityError: ErrorClass;
  readonly InternalServerError: ErrorClass;
}

/** Everything the chain needs besides the error itself. */
export interface MapErrorContext {
  readonly providerId: ProviderId;
  readonly tracker: DispatchTracker;
  readonly classes: SdkErrorClasses;
  readonly clock: Clock;
  /** Our AbortSignal fired (row 1 even when the SDK surfaced a different class). */
  readonly aborted?: boolean;
  readonly providerResponseId?: string;
  readonly partialUsage?: NormalizedUsage;
}

/** §7.6 cap on honoring `retry-after`. */
export const RETRY_AFTER_CAP_MS = 60_000;

const MS_PER_SECOND = 1000;

/** Structural view of an SDK `APIError`. */
interface ApiErrorView {
  readonly status: number | undefined;
  readonly headers: Headers | undefined;
  readonly body: unknown;
  readonly requestId: string | undefined;
  readonly type: string | undefined;
  readonly message: string;
}

function view(err: object): ApiErrorView {
  const e = err as {
    status?: unknown;
    headers?: unknown;
    error?: unknown;
    requestID?: unknown;
    type?: unknown;
    message?: unknown;
  };
  return {
    status: typeof e.status === 'number' ? e.status : undefined,
    headers: e.headers instanceof Headers ? e.headers : undefined,
    body: e.error,
    requestId: typeof e.requestID === 'string' ? e.requestID : undefined,
    type: typeof e.type === 'string' ? e.type : undefined,
    message: typeof e.message === 'string' ? e.message : '',
  };
}

/**
 * `retry-after` (seconds or HTTP date) → ms, capped at {@link RETRY_AFTER_CAP_MS}; `undefined` when absent/invalid.
 */
export function parseRetryAfterMs(headers: Headers | undefined, clock: Clock): number | undefined {
  const raw = headers?.get('retry-after')?.trim();
  if (raw === undefined || raw === '') return undefined;
  const seconds = Number(raw);
  let ms: number;
  if (Number.isFinite(seconds)) {
    ms = Math.ceil(seconds * MS_PER_SECOND);
  } else {
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return undefined;
    ms = at - clock.now();
  }
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, ms));
}

const PROMPT_TOO_LONG = /prompt is too long|too many (input )?tokens|context (length|window)|maximum context/i;

interface Mapped {
  readonly code: ErrorCode;
  readonly phase: DispatchPhase;
  readonly details?: Record<string, unknown>;
  readonly retryAfterMs?: number;
}

function isInstance(err: unknown, cls: ErrorClass): boolean {
  return err instanceof cls;
}

/** Rows 6–11 (an HTTP error status line arrived; phase `responded`). */
function mapStatusError(err: object, v: ApiErrorView, ctx: MapErrorContext): Mapped | undefined {
  const c = ctx.classes;
  const providerError = v.body === undefined ? undefined : redactDeep(v.body);
  const withBody = providerError === undefined ? {} : { providerError };
  if (v.status === 529 || isInstance(err, c.RateLimitError)) {
    const retryAfterMs = parseRetryAfterMs(v.headers, ctx.clock);
    return {
      code: 'RATE_LIMITED',
      phase: 'responded',
      details: { retryAfterMs: retryAfterMs ?? null, overloaded: v.status === 529 },
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  if (isInstance(err, c.AuthenticationError) || isInstance(err, c.PermissionDeniedError) || v.status === 402) {
    return { code: 'AUTH_REQUIRED', phase: 'responded', details: { ...withBody } };
  }
  if (isInstance(err, c.NotFoundError)) return { code: 'MODEL_UNSUPPORTED', phase: 'responded', details: withBody };
  if (v.status === 413 || (isInstance(err, c.BadRequestError) && PROMPT_TOO_LONG.test(v.message))) {
    return { code: 'CONTEXT_TOO_LARGE', phase: 'responded', details: withBody };
  }
  if (isInstance(err, c.InternalServerError) || (v.status !== undefined && v.status >= 500)) {
    return { code: 'PROVIDER_UNAVAILABLE', phase: 'responded', details: withBody };
  }
  if (v.status !== undefined && v.status >= 400) {
    return { code: 'MODEL_UNSUPPORTED', phase: 'responded', details: withBody }; // 400, 422, other 4xx (row 10b)
  }
  return undefined;
}

function classify(err: unknown, ctx: MapErrorContext): Mapped {
  const { tracker, classes: c } = ctx;
  // Row 1: our AbortSignal. The engine treats details.aborted as cancellation, not as an error.
  if (ctx.aborted === true || isInstance(err, c.APIUserAbortError)) {
    return { code: 'INTERNAL', phase: tracker.phase, details: { aborted: true } };
  }
  // Row 2: any failure after the first body byte of a 2xx stream (SSE error event, drop, parse failure).
  if (tracker.firstByteAt !== undefined) return { code: 'REQUEST_OUTCOME_UNKNOWN', phase: 'responded_partial' };
  const status = tracker.status;
  // Row 3: the provider accepted the request (2xx) but the stream failed before any body byte.
  if (status !== undefined && status >= 200 && status < 300) {
    return { code: 'REQUEST_OUTCOME_UNKNOWN', phase: 'responded' };
  }
  // Rows 4–5: connection errors are classified by the tracker, never by message.
  if (isInstance(err, c.APIConnectionError)) {
    return tracker.phase === 'not_sent'
      ? { code: 'PROVIDER_UNAVAILABLE', phase: 'not_sent' }
      : { code: 'REQUEST_OUTCOME_UNKNOWN', phase: 'sent_no_response' };
  }
  if (typeof err === 'object' && err !== null && isInstance(err, c.APIError)) {
    const mapped = mapStatusError(err, view(err), ctx);
    if (mapped !== undefined) return mapped;
  }
  // Anything else (a non-SDK error). Before dispatch nothing left the machine; after dispatch the outcome is unknown.
  const errorName = err instanceof Error ? err.name : typeof err;
  if (tracker.phase === 'not_sent') return { code: 'INTERNAL', phase: 'not_sent', details: { errorName } };
  return { code: 'REQUEST_OUTCOME_UNKNOWN', phase: tracker.phase, details: { errorName } };
}

/**
 * Maps anything a provider call threw to a `kind: 'error'` result with an accurate {@link DispatchPhase}.
 * Only rows 4 (`not_sent`) and 11 (5xx before any body byte) are transport-retryable; `sent_no_response` and
 * `responded_partial` always map to `REQUEST_OUTCOME_UNKNOWN` (06 §F7). Provider error bodies are redacted.
 */
export function mapProviderError(err: unknown, ctx: MapErrorContext): ModelError {
  const mapped = classify(err, ctx);
  const apiView = typeof err === 'object' && err !== null && isInstance(err, ctx.classes.APIError) ? view(err) : undefined;
  const details: Record<string, unknown> = { providerId: ctx.providerId, ...mapped.details };
  if (ctx.tracker.causeCode !== undefined) details['causeCode'] = ctx.tracker.causeCode;
  if (apiView?.status !== undefined) details['status'] = apiView.status;
  if (apiView?.type !== undefined) details['errorType'] = apiView.type;
  if (mapped.code === 'REQUEST_OUTCOME_UNKNOWN' && apiView?.body !== undefined && !('providerError' in details)) {
    details['providerError'] = redactDeep(apiView.body); // e.g. the SSE `error` event body
  }
  if (ctx.partialUsage !== undefined && mapped.phase === 'responded_partial') details['partialUsage'] = ctx.partialUsage;
  if (ctx.providerResponseId !== undefined) details['providerResponseId'] = ctx.providerResponseId;
  const providerRequestId = ctx.tracker.requestId ?? apiView?.requestId;
  return {
    kind: 'error',
    error: appError(mapped.code, { details }),
    phase: mapped.phase,
    ...(mapped.retryAfterMs === undefined ? {} : { retryAfterMs: mapped.retryAfterMs }),
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
    ...(ctx.providerResponseId === undefined ? {} : { providerResponseId: ctx.providerResponseId }),
  };
}
