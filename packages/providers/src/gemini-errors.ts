// 04 §D10 / §D3: the Gemini SDK has a single `ApiError { status, message }` whose message is the JSON-stringified
// `google.rpc.Status` body. The D3 chain needs status families as classes, so this module re-types it. Bodies are
// untrusted provider JSON and are read only through the guards below.
import { ApiError } from '@google/genai';
import type { SdkErrorClasses } from './errors.js';
import { tryParseJson } from './json.js';

const MS_PER_SECOND = 1000;

/** A Gemini HTTP error status, normalized for the D3 chain (`status`, `error` = parsed body, `headers`, `type`). */
export class GeminiApiError extends Error {
  readonly status: number;
  readonly error: unknown;
  readonly headers: Headers | undefined;
  readonly type: string | undefined;
  constructor(status: number, message: string, body: unknown, type: string | undefined, headers: Headers | undefined) {
    super(message);
    this.name = 'GeminiApiError';
    this.status = status;
    this.error = body;
    this.type = type;
    this.headers = headers;
  }
}
class GeminiBadRequestError extends GeminiApiError {}
class GeminiAuthenticationError extends GeminiApiError {}
class GeminiPermissionDeniedError extends GeminiApiError {}
class GeminiNotFoundError extends GeminiApiError {}
class GeminiUnprocessableEntityError extends GeminiApiError {}
class GeminiRateLimitError extends GeminiApiError {}
class GeminiInternalServerError extends GeminiApiError {}
/** The base fetch rejected (DNS, refused, TLS, reset, …); phase comes from the tracker (D3 rows 4–5). */
export class GeminiConnectionError extends Error {
  constructor(cause: unknown) {
    super('connection error', { cause });
    this.name = 'GeminiConnectionError';
  }
}
/** Never thrown: aborts are detected through our own `AbortSignal` (row 1 via `aborted`). */
class GeminiUserAbortError extends Error {}

/** The D3 chain's classes for Gemini. */
export const GEMINI_ERRORS: SdkErrorClasses = {
  APIError: GeminiApiError,
  APIUserAbortError: GeminiUserAbortError,
  APIConnectionError: GeminiConnectionError,
  RateLimitError: GeminiRateLimitError,
  AuthenticationError: GeminiAuthenticationError,
  PermissionDeniedError: GeminiPermissionDeniedError,
  NotFoundError: GeminiNotFoundError,
  BadRequestError: GeminiBadRequestError,
  UnprocessableEntityError: GeminiUnprocessableEntityError,
  InternalServerError: GeminiInternalServerError,
};

/** The fields of a `google.rpc.Status` error object Relay reads (`{ error: { message, status, details } }`). */
export interface RpcStatus {
  readonly code?: number;
  readonly message?: string;
  readonly status?: string;
  readonly details: readonly RpcDetail[];
}
/** One `google.rpc.Status.details[]` entry (ErrorInfo, RetryInfo, …), fields narrowed to the types Relay reads. */
export interface RpcDetail {
  readonly type?: string;
  readonly reason?: string;
  readonly retryDelay?: string;
}

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v);
const stringOrNone = (v: unknown): { readonly value?: string } => (typeof v === 'string' ? { value: v } : {});

function toDetail(v: unknown): RpcDetail | null {
  if (!isRecord(v)) return null;
  const type = stringOrNone(v['@type']).value;
  const reason = stringOrNone(v['reason']).value;
  const retryDelay = stringOrNone(v['retryDelay']).value;
  return {
    ...(type === undefined ? {} : { type }),
    ...(reason === undefined ? {} : { reason }),
    ...(retryDelay === undefined ? {} : { retryDelay }),
  };
}

/** The `error` object of a parsed body, typed field by field; `undefined` when the body has none. */
export function rpcStatusOf(body: unknown): RpcStatus | undefined {
  if (!isRecord(body) || !isRecord(body['error'])) return undefined;
  const e = body['error'];
  const message = stringOrNone(e['message']).value;
  const status = stringOrNone(e['status']).value;
  const rawDetails = e['details'];
  const details = Array.isArray(rawDetails) ? rawDetails.map(toDetail).filter((d): d is RpcDetail => d !== null) : [];
  const code = e['code'];
  return {
    ...(typeof code === 'number' ? { code } : {}),
    ...(message === undefined ? {} : { message }),
    ...(status === undefined ? {} : { status }),
    details,
  };
}

/** Google API-key rejections arrive as HTTP 400 INVALID_ARGUMENT with this structured `ErrorInfo.reason`. */
const API_KEY_REASONS: ReadonlySet<string> = new Set(['API_KEY_INVALID', 'API_KEY_EXPIRED']);

/** `RetryInfo.retryDelay` ("12s", "1.5s") as a `retry-after` header, so the D3 chain can honor it. */
function retryAfterHeaders(details: readonly RpcDetail[]): Headers | undefined {
  for (const d of details) {
    if (d.type?.endsWith('RetryInfo') !== true || d.retryDelay === undefined) continue;
    const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay.trim());
    if (m?.[1] !== undefined) return new Headers({ 'retry-after': String(Math.ceil(Number(m[1]) * MS_PER_SECOND) / MS_PER_SECOND) });
  }
  return undefined;
}

function classFor(status: number, details: readonly RpcDetail[]): typeof GeminiApiError {
  if (details.some((d) => d.reason !== undefined && API_KEY_REASONS.has(d.reason))) return GeminiAuthenticationError;
  if (status === 400) return GeminiBadRequestError;
  if (status === 401) return GeminiAuthenticationError;
  if (status === 403) return GeminiPermissionDeniedError;
  if (status === 404) return GeminiNotFoundError;
  if (status === 422) return GeminiUnprocessableEntityError;
  if (status === 429) return GeminiRateLimitError;
  if (status >= 500) return GeminiInternalServerError;
  return GeminiApiError;
}

/** Converts the SDK's `ApiError` into the typed family above; anything else passes through unchanged. */
export function toTypedGeminiError(err: unknown): unknown {
  if (!(err instanceof ApiError)) return err;
  const body = tryParseJson(err.message) ?? { error: { message: err.message } };
  const rpc = rpcStatusOf(body);
  const details = rpc?.details ?? [];
  const Cls = classFor(err.status, details);
  return new Cls(err.status, rpc?.message ?? err.message, body, rpc?.status, retryAfterHeaders(details));
}
