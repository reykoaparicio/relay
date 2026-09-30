// Provider connection flows shared by onboarding (connect-provider) and Settings → Providers (10 J6, J10).
// The API key goes straight to `providers.connect` (main keeps it; §6.3) and is never stored in React state after
// submit: callers clear their input before awaiting.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CredentialStorageMode, ProviderId, ProviderStatus, ProviderTestResult } from '@relay/contracts';
import { call } from '../../api/client';
import { isNotImplemented } from '../../api/errors';
import { qk } from '../../api/keys';

/** Result of the small connection test that follows a connect (FR-02). */
export type TestOutcome =
  | { readonly kind: 'passed'; readonly result: ProviderTestResult }
  /** The test ran and failed (`result.error`), or the call itself failed (`error`: AUTH_REQUIRED, RATE_LIMITED, …). */
  | { readonly kind: 'failed'; readonly result: ProviderTestResult | null; readonly error: unknown }
  /** `providers.test` is still stubbed in this build: the key is saved but was not tested. */
  | { readonly kind: 'not_tested'; readonly error: unknown };

export interface ConnectInput {
  readonly providerId: ProviderId;
  readonly apiKey: string;
  readonly storage: CredentialStorageMode;
}

export interface ConnectOutcome {
  readonly status: ProviderStatus;
  readonly test: TestOutcome;
}

/** Runs `providers.test` and folds every answer (including not-implemented) into a {@link TestOutcome}. */
export async function runProviderTest(providerId: ProviderId): Promise<TestOutcome> {
  try {
    const result = await call('relay/v1/providers.test', { providerId });
    return result.ok ? { kind: 'passed', result } : { kind: 'failed', result, error: null };
  } catch (e) {
    return isNotImplemented(e)
      ? { kind: 'not_tested', error: e }
      : { kind: 'failed', result: null, error: e };
  }
}

function useInvalidateProviderViews() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: qk.providers() });
    // Missing-credential warnings are engine-computed per profile (06 F14).
    void queryClient.invalidateQueries({ queryKey: qk.profiles() });
  };
}

/** `providers.connect` then `providers.test`. */
export function useConnectProvider() {
  const invalidate = useInvalidateProviderViews();
  return useMutation<ConnectOutcome, unknown, ConnectInput>({
    mutationFn: async ({ providerId, apiKey, storage }) => {
      const status = await call('relay/v1/providers.connect', { providerId, apiKey, storage });
      return { status, test: await runProviderTest(providerId) };
    },
    onSettled: invalidate,
  });
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
