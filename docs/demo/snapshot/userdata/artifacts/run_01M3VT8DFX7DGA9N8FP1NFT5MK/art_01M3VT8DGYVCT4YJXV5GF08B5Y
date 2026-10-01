import type { ServerResponse } from 'node:http';

/** Stable error codes that clients may switch on (see docs/api.md). */
export type ErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'METHOD_NOT_ALLOWED' | 'UNAUTHORIZED' | 'INTERNAL';

/** An error that already knows which HTTP status and public code it maps to. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, 'VALIDATION_FAILED', message);
}

export function notFound(what: string): HttpError {
  return new HttpError(404, 'NOT_FOUND', `${what} not found`);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Success shape: `{ data }`. */
export function sendData(res: ServerResponse, data: unknown, status = 200): void {
  writeJson(res, status, { data });
}

/** Failure shape: `{ error: { code, message } }`. Unknown errors become 500 INTERNAL. */
export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    writeJson(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }
  console.error('unhandled error', err);
  writeJson(res, 500, { error: { code: 'INTERNAL', message: 'Something went wrong' } });
}
