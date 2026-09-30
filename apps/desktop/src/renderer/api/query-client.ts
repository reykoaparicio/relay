import { QueryClient } from '@tanstack/react-query';
import { isRetryableAppError } from './client';

/** Max retries of a retryable query error (10 J1). */
const MAX_QUERY_RETRIES = 2;

/** The app's QueryClient with the 10 J1 defaults. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: (failureCount, error) => isRetryableAppError(error) && failureCount < MAX_QUERY_RETRIES,
        refetchOnWindowFocus: false,
      },
      // Mutations never auto-retry: a retry is a user intent and reuses the idempotency key (useIdempotentMutation).
      mutations: { retry: false },
    },
  });
}
