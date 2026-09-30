// 06 F7: retry policy (§7.6) — pure classification of a provider result, the next-attempt plan, and the run event the
// outcome causes. Limits come from the step snapshot's retryPolicy, never from constants (R3-9).
import { MAX_BACKOFF_MS, appError, errors } from '@relay/contracts';
import type { AppError, AttemptId, AttemptPurpose, EpochMs, Microusd, RetryPolicy } from '@relay/contracts';
import type { FallbackInfo, ModelResult, NormalizedUsage } from '@relay/providers';
import type { AttemptRow, StepRow } from '@relay/storage';
import type { ChargeBasis, SettleAmount } from './budget.js';
import { isOverrun } from './budget.js';
import type { AbortReason } from './ports.js';
import type { RunMachineEvent } from './run-machine.js';

/** Transport retry backoff (§7.6). */
export const TRANSPORT_BACKOFF_MS = 2_000;
/** Rate-limit wait when the provider sent no retry-after. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 2_000;

/** What happened to one attempt. */
export type OutcomeKind =
  | 'valid'
  | 'not_sent'
  | 'transport'
  | 'provider_error'
  | 'rate_limited'
  | 'auth'
  | 'unknown'
  | 'invalid_output'
  | 'refused'
  | 'artifact_failed'
  /** F10: a quality revision's patch left the approved scope (APPROVAL_STALE scope_changed). */
  | 'scope_changed';

/** Final attempt state an outcome maps to. */
export type FinalAttemptState = 'succeeded' | 'failed' | 'failed_before_dispatch' | 'unknown';

/** Classified outcome of one attempt (F7). */
export interface ClassifiedOutcome {
  readonly kind: OutcomeKind;
  readonly attemptState: FinalAttemptState;
  readonly charge: ChargeBasis;
  readonly error: AppError | null;
  /** Usage as reported (informational `partial` when observed before an abort, R4-9). */
  readonly usage: NormalizedUsage | null;
  readonly partial: boolean;
  readonly rawUsage: unknown;
  readonly stopReason: string | null;
  readonly retryAfterMs: number | null;
  readonly abortReason: AbortReason | null;
  readonly providerRequestId: string | null;
}

/** Result of the F8 validation (null when no success result was validated). */
export type Validation = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: AppError };

/** Optional result flags (04): absent ⇒ usage known, prices match (backward compatible). */
export interface ResultFlags {
  /** false: the provider did not report usage; the charge is settled at the reservation N (`estimated`). */
  readonly usageKnown?: boolean | undefined;
  /** true: billed at a price tier the snapshot prices do not describe (`estimated`). */
  readonly priceTierMismatch?: boolean | undefined;
}

/** The optional 04 flags of a result (tolerates adapters that do not set them). */
export function flagsOf(result: object): ResultFlags {
  const f = result as ResultFlags;
  return { usageKnown: f.usageKnown, priceTierMismatch: f.priceTierMismatch };
}

const known = (usage: NormalizedUsage, fallback?: FallbackInfo, flags: ResultFlags = {}): ChargeBasis => {
  if (flags.usageKnown === false) return { kind: 'at_reservation' };
  const estimated = flags.priceTierMismatch === true ? { estimated: true } : {};
  return fallback === undefined || fallback.iterations.length === 0
    ? { kind: 'known', usage, ...estimated }
    : { kind: 'known', usage, iterations: fallback.iterations, ...estimated };
};

function base(result: ModelResult, abortReason: AbortReason | null): Omit<ClassifiedOutcome, 'kind' | 'attemptState' | 'charge' | 'error'> {
  const usage = result.kind === 'error' ? (result.usage ?? null) : result.usage;
  return {
    usage,
    partial: false,
    rawUsage: result.kind === 'error' ? null : result.rawUsage,
    stopReason: result.kind === 'success' ? result.stopReason : result.kind === 'truncated' ? (result.rawStopReason ?? 'max_tokens') : result.kind === 'refused' ? 'refusal' : null,
    retryAfterMs: result.kind === 'error' ? (result.retryAfterMs ?? null) : null,
    abortReason,
    providerRequestId: result.providerRequestId ?? null,
  };
}

function classifySuccess(result: ModelResult & { kind: 'success' }, validated: Validation | null, canonicalOk: boolean, b: ReturnType<typeof base>): ClassifiedOutcome {
  const charge = known(result.usage, result.fallback, flagsOf(result));
  if (validated !== null && !validated.ok) {
    const kind = validated.error.code === 'APPROVAL_STALE' ? 'scope_changed' : 'invalid_output';
    return { ...b, kind, attemptState: 'failed', charge, error: validated.error };
  }
  if (!canonicalOk) return { ...b, kind: 'artifact_failed', attemptState: 'failed', charge, error: errors.artifactWriteFailed() };
  return { ...b, kind: 'valid', attemptState: 'succeeded', charge, error: null };
}

const ERROR_KINDS: Readonly<Partial<Record<AppError['code'], OutcomeKind>>> = {
  RATE_LIMITED: 'rate_limited',
  AUTH_REQUIRED: 'auth',
  PROVIDER_UNAVAILABLE: 'transport',
  REQUEST_OUTCOME_UNKNOWN: 'unknown',
};

function errorKind(code: AppError['code']): OutcomeKind {
  return ERROR_KINDS[code] ?? 'provider_error';
}

function classifyError(result: ModelResult & { kind: 'error' }, aborted: boolean, attemptId: AttemptId, b: ReturnType<typeof base>): ClassifiedOutcome {
  const sentAmbiguous = result.phase === 'sent_no_response' || result.phase === 'responded_partial';
  if (aborted && result.phase === 'not_sent') {
    return { ...b, kind: 'not_sent', attemptState: 'failed_before_dispatch', charge: { kind: 'not_charged' }, error: null };
  }
  const kind = aborted || sentAmbiguous ? 'unknown' : errorKind(result.error.code);
  if (kind === 'unknown') {
    // Abort after dispatch or an ambiguous phase: the FULL N becomes unknown; observed usage is informational (R4-9).
    const partial = (result.error.details?.['partialUsage'] as NormalizedUsage | undefined) ?? result.usage ?? null;
    return {
      ...b,
      kind,
      attemptState: 'unknown',
      charge: { kind: 'unknown' },
      usage: partial,
      partial: partial !== null,
      error: errors.requestOutcomeUnknown(attemptId),
    };
  }
  const charge: ChargeBasis = result.usage === undefined ? { kind: 'not_charged' } : known(result.usage, undefined, flagsOf(result));
  return { ...b, kind, attemptState: 'failed', charge, error: result.error };
}

/** F7 `classify`: maps a provider result (+ validation + canonical-output write) to an outcome. */
export function classify(
  result: ModelResult,
  validated: Validation | null,
  canonicalOk: boolean,
  o: { readonly aborted: boolean; readonly abortReason?: AbortReason | undefined; readonly attemptId: AttemptId },
): ClassifiedOutcome {
  const b = base(result, o.aborted ? (o.abortReason ?? { kind: 'cancel' }) : null);
  switch (result.kind) {
    case 'success':
      return classifySuccess(result, validated, canonicalOk, b);
    case 'truncated':
      return {
        ...b,
        kind: 'invalid_output',
        attemptState: 'failed',
        charge: known(result.usage, result.fallback, flagsOf(result)),
        error: errors.outputInvalid([{ path: '', message: 'The response was cut off at the output allowance.', code: 'truncated' }]),
      };
    case 'refused':
      return { ...b, kind: 'refused', attemptState: 'failed', charge: known(result.usage, result.fallback, flagsOf(result)), error: errors.modelRefused() };
    case 'error':
      return classifyError(result, o.aborted, o.attemptId, b);
  }
}

/** Which step counter a retry consumes. */
export type RetryCounter = 'transport' | 'schema_repair' | 'rate_limit';

/** What happens to the step after an attempt. */
export type AttemptPlan =
  | { readonly kind: 'succeed' }
  | { readonly kind: 'release' }
  | { readonly kind: 'retry'; readonly purpose: AttemptPurpose; readonly counter: RetryCounter; readonly notBeforeAt: EpochMs }
  | { readonly kind: 'fail'; readonly error: AppError }
  | { readonly kind: 'hold'; readonly error: AppError }
  | { readonly kind: 'unknown'; readonly error: AppError };

function retryOr(
  used: number,
  limit: number,
  retry: Omit<AttemptPlan & { kind: 'retry' }, 'kind'>,
  otherwise: AttemptPlan,
): AttemptPlan {
  return used < limit ? { kind: 'retry', ...retry } : otherwise;
}

/** F7 `nextAttemptPlan`: the step's next move for `outcome` under the snapshot `policy`. */
export function nextAttemptPlan(
  step: Pick<StepRow, 'transportRetriesUsed' | 'schemaRepairsUsed' | 'rateLimitWaitsUsed'>,
  outcome: ClassifiedOutcome,
  policy: RetryPolicy,
  now: EpochMs,
  purpose: AttemptPurpose,
): AttemptPlan {
  const error = outcome.error ?? errors.providerUnavailable();
  switch (outcome.kind) {
    case 'valid':
      return { kind: 'succeed' };
    case 'not_sent':
      return { kind: 'release' };
    case 'transport':
      return retryOr(step.transportRetriesUsed, policy.transport,
        { purpose: 'transport_retry', counter: 'transport', notBeforeAt: (now + TRANSPORT_BACKOFF_MS) as EpochMs },
        { kind: 'fail', error });
    case 'rate_limited': {
      const wait = Math.min(outcome.retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS, MAX_BACKOFF_MS);
      return retryOr(step.rateLimitWaitsUsed, policy.rateLimitWaits,
        { purpose, counter: 'rate_limit', notBeforeAt: (now + wait) as EpochMs }, { kind: 'hold', error });
    }
    case 'auth':
    case 'scope_changed':
      return { kind: 'hold', error };
    case 'unknown':
      return { kind: 'unknown', error };
    case 'invalid_output':
      return retryOr(step.schemaRepairsUsed, policy.schemaRepair,
        { purpose: 'schema_repair', counter: 'schema_repair', notBeforeAt: now }, { kind: 'fail', error });
    case 'provider_error':
    case 'refused':
    case 'artifact_failed':
      return { kind: 'fail', error };
  }
}

/** F7 `nextPurpose`: derived from the step's latest attempt. */
export function nextPurpose(step: Pick<StepRow, 'retryIndex'>, attempts: readonly AttemptRow[]): AttemptPurpose {
  const latest = attempts.at(-1);
  if (latest === undefined) return step.retryIndex > 0 ? 'user_retry' : 'initial';
  if (latest.state === 'abandoned') return 'user_retry';
  const code = latest.error?.code;
  if (code === 'PROVIDER_UNAVAILABLE') return 'transport_retry';
  if (code === 'OUTPUT_INVALID') return 'schema_repair';
  return latest.purpose;
}

/** The attempt a non-initial attempt retries (`retry_of_attempt_id`). */
export function retryOfFor(purpose: AttemptPurpose, prior: readonly AttemptRow[]): AttemptId | null {
  return purpose === 'initial' ? null : (prior.at(-1)?.id ?? null);
}

/** Run event caused by a settled attempt. BUDGET_OVERRUN takes precedence (F5 / §9.5). */
export function runEventFor(
  outcome: ClassifiedOutcome,
  plan: AttemptPlan,
  cost: SettleAmount,
  N: Microusd,
  attemptId: AttemptId,
): RunMachineEvent | null {
  if (isOverrun(cost, N)) {
    const X = cost.kind === 'known' ? cost.microusd : N;
    return { type: 'BUDGET_OVERRUN', attemptId, error: overrunError(attemptId, N, X) };
  }
  switch (plan.kind) {
    case 'succeed':
    case 'retry':
    case 'release':
      return null;
    case 'unknown':
      return outcome.abortReason?.kind === 'deadline'
        ? { type: 'LIMIT_REACHED', reason: 'deadline', error: errors.limitReached('deadline') }
        : { type: 'UNKNOWN_OUTCOME', attemptId, error: plan.error };
    case 'hold':
      if (outcome.kind === 'auth') return { type: 'AUTH_FAILED', error: plan.error };
      if (outcome.kind === 'scope_changed') return { type: 'APPROVAL_STALE', error: plan.error };
      return { type: 'RATE_LIMIT_EXHAUSTED', error: plan.error };
    case 'fail':
      return eventForFailure(plan.error);
  }
}

/** §9.5 overrun: the recorded cost X exceeded the reservation N (never capped). */
export function overrunError(attemptId: AttemptId, N: Microusd, X: Microusd): AppError {
  return appError('BUDGET_BLOCKED', {
    userMessage: 'The last request cost more than Relay reserved for it. Review the cost before continuing.',
    attemptId,
    details: { overrun: true, N, X },
  });
}

/** Maps a failed step's error to the pause event (F13 `eventForFailedStep`). */
export function eventForFailure(error: AppError): RunMachineEvent {
  const code = error.code;
  if (code === 'OUTPUT_INVALID' || code === 'ARTIFACT_WRITE_FAILED') return { type: 'OUTPUT_INVALID_EXHAUSTED', error };
  if (code === 'MODEL_REFUSED') return { type: 'MODEL_REFUSED', error };
  if (code === 'REQUEST_OUTCOME_UNKNOWN' && error.attemptId !== undefined) return { type: 'UNKNOWN_OUTCOME', attemptId: error.attemptId, error };
  if (code === 'MODEL_UNSUPPORTED' || code === 'CONTEXT_TOO_LARGE') return { type: 'SETUP_BLOCKED', reason: 'setup_blocked', error };
  return { type: 'TRANSPORT_EXHAUSTED', error };
}

/** F6 #5/#6/#7/#9 → the matching run event. */
function eventForLimit(error: AppError): RunMachineEvent {
  const limit = error.details?.['limit'];
  if (limit === 'deadline') return { type: 'LIMIT_REACHED', reason: 'deadline', error };
  if (limit === 'tool_calls') return { type: 'SETUP_BLOCKED', reason: 'setup_blocked', error };
  if (error.details?.['reason'] === 'retry_policy') {
    const purpose = error.details['purpose'];
    if (purpose === 'transport_retry') return { type: 'TRANSPORT_EXHAUSTED', error };
    if (purpose === 'schema_repair') return { type: 'OUTPUT_INVALID_EXHAUSTED', error };
    return { type: 'RATE_LIMIT_EXHAUSTED', error };
  }
  return { type: 'LIMIT_REACHED', reason: 'limit_attempts', error };
}

/** Maps a pre-dispatch error (context assembly, policy) to the run event; null = no event (the loop re-reads). */
export function eventForError(error: AppError): RunMachineEvent | null {
  const code = error.code;
  if (code === 'CONFLICT') return null;
  if (code === 'CONTEXT_TOO_LARGE' || code === 'MODEL_UNSUPPORTED' || code === 'PERMISSION_DENIED' || code === 'NOT_FOUND') {
    return { type: 'SETUP_BLOCKED', reason: 'setup_blocked', error };
  }
  if (code === 'AUTH_REQUIRED') return { type: 'AUTH_FAILED', error };
  if (code === 'LIMIT_REACHED') return eventForLimit(error);
  if (code === 'APPROVAL_STALE' || code === 'PROJECT_CHANGED') return { type: 'APPROVAL_STALE', error };
  return { type: 'UNRECOVERABLE', error };
}
