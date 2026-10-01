// Provider connection flows shared by onboarding (connect-provider) and Settings → Providers (10 J6, J10).
// The API key goes straight to `providers.connect` (main keeps it; §6.3) and is never stored in React state after
// submit: callers clear their input before awaiting, and the connect call keeps it out of every cache.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CredentialStorageMode, ProviderId, ProviderStatus, ProviderTestResult } from '@relay/contracts';
import { call } from '../../api/client';
import { qk } from '../../api/keys';

/** Result of the small connection test that follows a connect (FR-02). */
export type TestOutcome =
  | { readonly kind: 'passed'; readonly result: ProviderTestResult }
  /** The test ran and failed (`result.error`), or the call itself failed (`error`: AUTH_REQUIRED, RATE_LIMITED, …). */
  | { readonly kind: 'failed'; readonly result: ProviderTestResult | null; readonly error: unknown };

export interface ConnectInput {
  readonly providerId: ProviderId;
  readonly apiKey: string;
  readonly storage: CredentialStorageMode;
}

export interface ConnectOutcome {
  readonly status: ProviderStatus;
  readonly test: TestOutcome;
}

/** Runs `providers.test` and folds every answer (including a failed call) into a {@link TestOutcome}. */
async function runProviderTest(providerId: ProviderId): Promise<TestOutcome> {
  try {
    const result = await call('relay/v1/providers.test', { providerId });
    return result.ok ? { kind: 'passed', result } : { kind: 'failed', result, error: null };
  } catch (e) {
    return { kind: 'failed', result: null, error: e };
  }
}

function useInvalidateProviderViews() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: qk.providers() });
    // Missing-credential warnings are engine-computed per profile (06 F14).
    void queryClient.invalidateQueries({ queryKey: qk.profiles() });
  }, [queryClient]);
}

export interface ConnectCallbacks {
  readonly onSuccess?: (outcome: ConnectOutcome) => void;
  readonly onError?: (error: unknown) => void;
}

export interface ConnectProvider {
  /** Sends the key to main. Ignored while a connect is in flight. The key is never kept after this call. */
  readonly mutate: (input: ConnectInput, callbacks?: ConnectCallbacks) => void;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly reset: () => void;
}

/**
 * `providers.connect` then `providers.test`. Deliberately **not** a TanStack mutation: mutation variables live in the
 * query client's MutationCache (and devtools), so the API key would outlive the submit (FR-02, §6.3). The key is only
 * a local of this async call; the hook keeps nothing but pending/error state.
 */
export function useConnectProvider(): ConnectProvider {
  const invalidate = useInvalidateProviderViews();
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mutate = useCallback(
    (input: ConnectInput, callbacks: ConnectCallbacks = {}) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      setError(null);
      const { providerId, apiKey, storage } = input;
      const run = async (): Promise<ConnectOutcome> => {
        const status = await call('relay/v1/providers.connect', { providerId, apiKey, storage });
        return { status, test: await runProviderTest(providerId) };
      };
      run().then(
        (outcome) => {
          inFlight.current = false;
          invalidate();
          if (!mounted.current) return;
          setPending(false);
          callbacks.onSuccess?.(outcome);
        },
        (e: unknown) => {
          inFlight.current = false;
          invalidate();
          if (!mounted.current) return;
          setPending(false);
          setError(e);
          callbacks.onError?.(e);
        },
      );
    },
    [invalidate],
  );
  const reset = useCallback(() => {
    setError(null);
  }, []);
  return { mutate, isPending, error, reset };
}

/** `providers.test` for an already connected provider. */
export function useTestProvider() {
  const invalidate = useInvalidateProviderViews();
  return useMutation<TestOutcome, unknown, ProviderId>({
    mutationFn: runProviderTest,
    onSettled: invalidate,
  });
}

/** `providers.disconnect` (removes the stored key). */
export function useDisconnectProvider() {
  const invalidate = useInvalidateProviderViews();
  return useMutation<ProviderStatus, unknown, ProviderId>({
    mutationFn: (providerId) => call('relay/v1/providers.disconnect', { providerId }),
    onSettled: invalidate,
  });
}
