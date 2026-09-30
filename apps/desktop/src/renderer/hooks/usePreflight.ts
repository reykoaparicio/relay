import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { InputOf } from '@relay/contracts';
import { call } from '../api/client';
import { qk } from '../api/keys';
import { canonicalJson } from './useIdempotentMutation';

export type PreflightInput = InputOf<'relay/v1/runs.preflight'>;

/**
 * `runs.preflight` for a (debounced) form input; null disables it. The previous result stays visible while the next
 * one loads, so the summary panel does not jump (ui-ux-pro-max `content-jumping`).
 */
export function usePreflight(input: PreflightInput | null) {
  const fingerprint = input === null ? '' : canonicalJson(input);
  return useQuery({
    queryKey: qk.preflight(fingerprint),
    queryFn: () => call('relay/v1/runs.preflight', input as PreflightInput),
    enabled: input !== null,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0,
  });
}
