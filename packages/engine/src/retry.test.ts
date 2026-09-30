import { describe, expect, it } from 'vitest';
import { appError, epochMs, errors, microusd } from '@relay/contracts';
import type { AttemptId, RetryPolicy } from '@relay/contracts';
import type { ModelResult } from '@relay/providers';
import type { AttemptRow } from '@relay/storage';
import type { ClassifiedOutcome } from './retry.js';
import { classify, eventForError, eventForFailure, nextAttemptPlan, nextPurpose, retryOfFor, runEventFor } from './retry.js';

const ID = 'att_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as AttemptId;
const USAGE = { uncachedInputTokens: 10, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5 };
const POLICY: RetryPolicy = { transport: 1, schemaRepair: 1, rateLimitWaits: 3 };
const FRESH = { transportRetriesUsed: 0, schemaRepairsUsed: 0, rateLimitWaitsUsed: 0 };
const NOW = epochMs(10_000);
const o = { aborted: false, attemptId: ID };
const errorResult = (code: Parameters<typeof appError>[0], phase: 'not_sent' | 'sent_no_response' | 'responded' | 'responded_partial', extra: object = {}): ModelResult =>
  ({ kind: 'error', error: appError(code), phase, ...extra });
const success: ModelResult = { kind: 'success', json: {}, rawText: '{}', usage: USAGE, rawUsage: {}, stopReason: 'end_turn', latencyMs: 1 };

describe('classify (F7)', () => {
  it('success: valid, invalid output, or canonical-write failure (usage always known)', () => {
    expect(classify(success, { ok: true, value: {} }, true, o)).toEqual(expect.objectContaining({ kind: 'valid', attemptState: 'succeeded', charge: { kind: 'known', usage: USAGE } }));
    expect(classify(success, { ok: false, error: errors.outputInvalid() }, true, o).kind).toBe('invalid_output');
    expect(classify(success, { ok: true, value: {} }, false, o)).toEqual(expect.objectContaining({ kind: 'artifact_failed', error: expect.objectContaining({ code: 'ARTIFACT_WRITE_FAILED' }) as unknown }));
  });

  it('truncated and refused are known failures with usage', () => {
    expect(classify({ kind: 'truncated', rawText: '{', usage: USAGE, rawUsage: {} }, null, true, o)).toEqual(expect.objectContaining({ kind: 'invalid_output', stopReason: 'max_tokens' }));
    expect(classify({ kind: 'refused', usage: USAGE, rawUsage: {} }, null, true, o)).toEqual(expect.objectContaining({ kind: 'refused', stopReason: 'refusal' }));
  });

  it('transport retry only for not_sent or a 5xx before any body byte; ambiguous phases are unknown', () => {
    expect(classify(errorResult('PROVIDER_UNAVAILABLE', 'not_sent'), null, true, o).kind).toBe('transport');
    expect(classify(errorResult('PROVIDER_UNAVAILABLE', 'responded'), null, true, o).kind).toBe('transport');
    expect(classify(errorResult('PROVIDER_UNAVAILABLE', 'sent_no_response'), null, true, o).kind).toBe('unknown');
    expect(classify(errorResult('PROVIDER_UNAVAILABLE', 'responded_partial'), null, true, o)).toEqual(expect.objectContaining({ kind: 'unknown', charge: { kind: 'unknown' } }));
    expect(classify(errorResult('RATE_LIMITED', 'responded', { retryAfterMs: 5 }), null, true, o)).toEqual(expect.objectContaining({ kind: 'rate_limited', retryAfterMs: 5 }));
    expect(classify(errorResult('AUTH_REQUIRED', 'responded'), null, true, o).kind).toBe('auth');
    expect(classify(errorResult('VALIDATION_FAILED', 'responded', { usage: USAGE }), null, true, o)).toEqual(expect.objectContaining({ kind: 'provider_error', charge: { kind: 'known', usage: USAGE } }));
  });

  it('an abort before send releases; an abort after dispatch is unknown with informational partial usage', () => {
    expect(classify(errorResult('INTERNAL', 'not_sent'), null, true, { ...o, aborted: true })).toEqual(expect.objectContaining({ kind: 'not_sent', attemptState: 'failed_before_dispatch' }));
    const after = classify(errorResult('INTERNAL', 'sent_no_response', { usage: USAGE }), null, true, { ...o, aborted: true, abortReason: { kind: 'deadline' } });
    expect(after).toEqual(expect.objectContaining({ kind: 'unknown', partial: true, abortReason: { kind: 'deadline' } }));
  });
});

describe('nextAttemptPlan (F7 table, limits from the snapshot retryPolicy)', () => {
  const at = (kind: ClassifiedOutcome['kind'], extra: Partial<ClassifiedOutcome> = {}): ClassifiedOutcome =>
    ({ kind, attemptState: 'failed', charge: { kind: 'not_charged' }, error: errors.providerUnavailable(), usage: null, partial: false, rawUsage: null,
      stopReason: null, retryAfterMs: null, abortReason: null, providerRequestId: null, ...extra });

  it('retries transport once with a 2 s backoff, then fails; a step with transport: 0 never retries', () => {
    expect(nextAttemptPlan(FRESH, at('transport'), POLICY, NOW, 'initial')).toEqual({ kind: 'retry', purpose: 'transport_retry', counter: 'transport', notBeforeAt: 12_000 });
    expect(nextAttemptPlan({ ...FRESH, transportRetriesUsed: 1 }, at('transport'), POLICY, NOW, 'initial').kind).toBe('fail');
    expect(nextAttemptPlan(FRESH, at('transport'), { ...POLICY, transport: 0 }, NOW, 'initial').kind).toBe('fail');
  });

  it('caps the rate-limit wait at 60 s, keeps the purpose, and holds when exhausted', () => {
    expect(nextAttemptPlan(FRESH, at('rate_limited', { retryAfterMs: 120_000 }), POLICY, NOW, 'schema_repair')).toEqual({ kind: 'retry', purpose: 'schema_repair', counter: 'rate_limit', notBeforeAt: 70_000 });
    expect(nextAttemptPlan(FRESH, at('rate_limited'), POLICY, NOW, 'initial')).toEqual(expect.objectContaining({ notBeforeAt: 12_000 }));
    expect(nextAttemptPlan({ ...FRESH, rateLimitWaitsUsed: 3 }, at('rate_limited'), POLICY, NOW, 'initial').kind).toBe('hold');
  });

  it('maps the remaining classes', () => {
    expect(nextAttemptPlan(FRESH, at('valid'), POLICY, NOW, 'initial').kind).toBe('succeed');
    expect(nextAttemptPlan(FRESH, at('not_sent'), POLICY, NOW, 'initial').kind).toBe('release');
    expect(nextAttemptPlan(FRESH, at('auth'), POLICY, NOW, 'initial').kind).toBe('hold');
    expect(nextAttemptPlan(FRESH, at('unknown'), POLICY, NOW, 'initial').kind).toBe('unknown');
    expect(nextAttemptPlan(FRESH, at('invalid_output'), POLICY, NOW, 'initial')).toEqual(expect.objectContaining({ kind: 'retry', purpose: 'schema_repair' }));
    expect(nextAttemptPlan({ ...FRESH, schemaRepairsUsed: 1 }, at('invalid_output'), POLICY, NOW, 'initial').kind).toBe('fail');
    for (const k of ['provider_error', 'refused', 'artifact_failed'] as const) expect(nextAttemptPlan(FRESH, at(k), POLICY, NOW, 'initial').kind).toBe('fail');
    expect(nextAttemptPlan(FRESH, at('transport', { error: null }), POLICY, NOW, 'initial')).toEqual(expect.objectContaining({ kind: 'retry' }));
  });

  it('never auto-retries unknown; maps run events with overrun precedence', () => {
    const cost = { kind: 'known' as const, microusd: microusd(900), certainty: 'calculated' as const };
    expect(runEventFor(at('valid'), { kind: 'succeed' }, cost, microusd(500), ID)?.type).toBe('BUDGET_OVERRUN');
    expect(runEventFor(at('valid'), { kind: 'succeed' }, { kind: 'not_charged' }, microusd(500), ID)).toBeNull();
    expect(runEventFor(at('unknown'), { kind: 'unknown', error: errors.requestOutcomeUnknown(ID) }, { kind: 'unknown' }, microusd(5), ID)?.type).toBe('UNKNOWN_OUTCOME');
    expect(runEventFor(at('unknown', { abortReason: { kind: 'deadline' } }), { kind: 'unknown', error: errors.requestOutcomeUnknown(ID) }, { kind: 'unknown' }, microusd(5), ID))
      .toEqual(expect.objectContaining({ type: 'LIMIT_REACHED', reason: 'deadline' }));
    expect(runEventFor(at('auth'), { kind: 'hold', error: errors.authRequired('anthropic') }, { kind: 'not_charged' }, microusd(5), ID)?.type).toBe('AUTH_FAILED');
    expect(runEventFor(at('rate_limited'), { kind: 'hold', error: errors.rateLimited(1) }, { kind: 'not_charged' }, microusd(5), ID)?.type).toBe('RATE_LIMIT_EXHAUSTED');
    expect(runEventFor(at('refused'), { kind: 'fail', error: errors.modelRefused() }, { kind: 'not_charged' }, microusd(5), ID)?.type).toBe('MODEL_REFUSED');
  });
});

describe('purposes and error mapping', () => {
  const attempt = (over: Partial<AttemptRow>): AttemptRow => ({ id: ID, purpose: 'initial', state: 'failed', error: null, ...over }) as AttemptRow;

  it('nextPurpose derives from the latest attempt (user_retry for a fresh retry row)', () => {
    expect(nextPurpose({ retryIndex: 0 }, [])).toBe('initial');
    expect(nextPurpose({ retryIndex: 1 }, [])).toBe('user_retry');
    expect(nextPurpose({ retryIndex: 0 }, [attempt({ state: 'abandoned' })])).toBe('user_retry');
    expect(nextPurpose({ retryIndex: 0 }, [attempt({ error: errors.providerUnavailable() })])).toBe('transport_retry');
    expect(nextPurpose({ retryIndex: 0 }, [attempt({ error: errors.outputInvalid() })])).toBe('schema_repair');
    expect(nextPurpose({ retryIndex: 0 }, [attempt({ purpose: 'schema_repair', error: errors.rateLimited(1) })])).toBe('schema_repair');
    expect(retryOfFor('initial', [attempt({})])).toBeNull();
    expect(retryOfFor('schema_repair', [attempt({})])).toBe(ID);
    expect(retryOfFor('schema_repair', [])).toBeNull();
  });

  it('eventForFailure and eventForError map every class (failed is only UNRECOVERABLE)', () => {
    expect(eventForFailure(errors.artifactWriteFailed()).type).toBe('OUTPUT_INVALID_EXHAUSTED');
    expect(eventForFailure(errors.requestOutcomeUnknown(ID)).type).toBe('UNKNOWN_OUTCOME');
    expect(eventForFailure(errors.contextTooLarge({ estimatedInputTokens: 1, budgetTokens: 0 })).type).toBe('SETUP_BLOCKED');
    expect(eventForFailure(appError('VALIDATION_FAILED')).type).toBe('TRANSPORT_EXHAUSTED');
    expect(eventForError(errors.conflict())).toBeNull();
    expect(eventForError(errors.permissionDenied('provider_not_allowed'))?.type).toBe('SETUP_BLOCKED');
    expect(eventForError(errors.authRequired('anthropic'))?.type).toBe('AUTH_FAILED');
    expect(eventForError(errors.limitReached('deadline'))).toEqual(expect.objectContaining({ type: 'LIMIT_REACHED', reason: 'deadline' }));
    expect(eventForError(errors.limitReached('attempts'))).toEqual(expect.objectContaining({ reason: 'limit_attempts' }));
    expect(eventForError(errors.projectChanged())?.type).toBe('APPROVAL_STALE');
    expect(eventForError(appError('INTERNAL'))?.type).toBe('UNRECOVERABLE');
  });
});
