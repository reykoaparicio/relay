import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { errors, runStartInputSchema, toValidationIssues } from '@relay/contracts';
import type { InputOf } from '@relay/contracts';
import { AppErrorException, call } from '../api/client';
import { qk } from '../api/keys';

export type PreflightInput = InputOf<'relay/v1/runs.preflight'>;

const preflightInputSchema = runStartInputSchema.omit({ idempotencyKey: true });

/**
 * The canonical key back to the input (built by `canonicalJson` from a typed input). A typed input can still break a
 * schema refinement (e.g. more than 50 `memoryRecordIds`): that is reported exactly as the runner would, as
 * `VALIDATION_FAILED` with field paths (shown at the field), never as a thrown ZodError (an `INTERNAL` system error).
 */
function parsePreflightKey(key: string): PreflightInput {
  const parsed = preflightInputSchema.safeParse(JSON.parse(key));
  if (!parsed.success) throw new AppErrorException(errors.validationFailed(toValidationIssues(parsed.error.issues)));
  return parsed.data;
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
