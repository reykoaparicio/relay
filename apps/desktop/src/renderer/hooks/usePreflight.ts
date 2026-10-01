import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { runStartInputSchema } from '@relay/contracts';
import type { InputOf } from '@relay/contracts';
import { call } from '../api/client';
import { qk } from '../api/keys';

export type PreflightInput = InputOf<'relay/v1/runs.preflight'>;

const preflightInputSchema = runStartInputSchema.omit({ idempotencyKey: true });

/** The canonical key back to the input (built by `canonicalJson` from a typed input, so parsing it cannot fail). */
function parsePreflightKey(key: string): PreflightInput {
  return preflightInputSchema.parse(JSON.parse(key));
}

/**
 * `runs.preflight` for a (debounced) canonical input key (`canonicalJson(input)`); null disables it. Taking the key
 * keeps the query key stable without re-serialising the input on every render. The previous result stays visible while
 * the next one loads, so the summary panel does not jump (ui-ux-pro-max `content-jumping`).
 */
export function usePreflight(canonicalKey: string | null) {
  return useQuery({
    queryKey: qk.preflight(canonicalKey ?? ''),
    queryFn: () => call('relay/v1/runs.preflight', parsePreflightKey(canonicalKey ?? '')),
    enabled: canonicalKey !== null,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0,
  });
}
