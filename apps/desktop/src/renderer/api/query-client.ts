import { QueryClient } from '@tanstack/react-query';
import { isRetryableAppError } from './client';
import { isDatabaseBusy } from './errors';

/** Max retries of a retryable query error (10 J1). */
const MAX_QUERY_RETRIES = 2;

/**
 * E2 #2: a busy database (another program holds the lock) usually clears within seconds, so queries retry it more
 * often and sooner than other retryable errors: 0.5 s, 1 s, 2 s, 4 s, 4 s, 4 s (~15 s) before the page shows it.
 */
export const DATABASE_BUSY_MAX_RETRIES = 6;
const DATABASE_BUSY_BASE_DELAY_MS = 500;
const DATABASE_BUSY_MAX_DELAY_MS = 4_000;

/** Query retry predicate (10 J1 + E2 #2). */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isDatabaseBusy(error)) return failureCount < DATABASE_BUSY_MAX_RETRIES;
  return isRetryableAppError(error) && failureCount < MAX_QUERY_RETRIES;
}

/** Retry delay: a short backoff for a busy database, TanStack's default exponential backoff otherwise. */
export function queryRetryDelay(failureCount: number, error: unknown): number {
  if (isDatabaseBusy(error)) return Math.min(DATABASE_BUSY_BASE_DELAY_MS * 2 ** failureCount, DATABASE_BUSY_MAX_DELAY_MS);
  return Math.min(1_000 * 2 ** failureCount, 30_000);
}

/** The app's QueryClient with the 10 J1 defaults. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
        refetchOnWindowFocus: false,
      },
      // Mutations never auto-retry: a retry is a user intent and reuses the idempotency key (useIdempotentMutation).
      mutations: { retry: false },
    },
  });
}
