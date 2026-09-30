import type { AppError, Channel, InputOf, OutputOf } from '@relay/contracts';
import { getBridge } from './bridge';

/** Thrown by {@link call} so TanStack Query's error channel carries the boundary {@link AppError}. */
export class AppErrorException extends Error {
  readonly appError: AppError;

  constructor(appError: AppError) {
    super(appError.userMessage);
    this.name = 'AppErrorException';
    this.appError = appError;
  }
}

/** Type guard for {@link AppErrorException}. */
export function isAppErrorException(e: unknown): e is AppErrorException {
  return e instanceof AppErrorException;
}

/** QueryClient retry predicate input: only errors the contracts mark `retryable` are retried (10 J1). */
export function isRetryableAppError(e: unknown): boolean {
  return isAppErrorException(e) && e.appError.retryable;
}

/** Typed IPC call. Resolves with the channel's output; rejects with {@link AppErrorException} on `ok: false`. */
export async function call<C extends Channel>(channel: C, input: InputOf<C>): Promise<OutputOf<C>> {
  const result = await getBridge().invoke(channel, input);
  if (!result.ok) throw new AppErrorException(result.error);
  return result.data;
}
