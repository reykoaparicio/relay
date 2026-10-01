import { describe, expect, it } from 'vitest';
import { budgetBreakdownSchema } from './domain/ledger.js';
import {
  appError,
  appErrorSchema,
  ERROR_DEFINITIONS,
  errnoDetails,
  errnoOf,
  errors,
  INTERNAL_REASON_MESSAGES,
  INTERNAL_REASONS,
  isRelayError,
  RelayError,
  toAppError,
  USER_MESSAGE_MAX,
} from './errors.js';
import type { AppError, ErrorContext } from './errors.js';
import type { AttemptId, CorrelationId, RunId } from './ids.js';
import { microusd } from './money.js';
import type { RelPath } from './primitives.js';
import { ERROR_CODES, NEXT_ACTIONS } from './status.js';

const BODY = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const attemptId = `att_${BODY}` as AttemptId;
const runId = `run_${BODY}` as RunId;
const correlationId = `cor_${BODY}` as CorrelationId;
const toCamel = (code: string): string =>
  code.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe('error taxonomy', () => {
  it('every ErrorCode has a factory, a default nextAction, and retryable', () => {
    for (const code of ERROR_CODES) {
      const def = ERROR_DEFINITIONS[code];
      const factory = (errors as Record<string, unknown>)[toCamel(code)];

      expect(typeof factory).toBe('function');
      expect(NEXT_ACTIONS).toContain(def.nextAction);
      expect(typeof def.retryable).toBe('boolean');
      expect(def.userMessage.length).toBeLessThanOrEqual(USER_MESSAGE_MAX);
      expect(appErrorSchema.safeParse(code === 'INTERNAL' ? errors.internal(undefined) : appError(code)).success).toBe(true);
    }
    expect(Object.keys(errors)).toHaveLength(ERROR_CODES.length);
  });

  it('every factory produces a schema-valid error with its own code', () => {
    const made = [
      errors.authRequired('anthropic'),
      errors.modelUnsupported({ modelId: 'x' }),
      errors.modelUnsupported(),
      errors.rateLimited(1500),
      errors.contextTooLarge({ estimatedInputTokens: 10, budgetTokens: 5 }),
      errors.outputInvalid([{ path: 'a', message: 'm', code: 'c' }], { attemptId }),
      errors.outputInvalid(),
      errors.approvalStale('plan_changed'),
      errors.projectChanged(['src/a.ts' as RelPath]),
      errors.projectChanged(),
      errors.requestOutcomeUnknown(attemptId, { runId }),
      errors.artifactWriteFailed(),
      errors.runnerUnavailable(),
      errors.providerUnavailable('openai'),
      errors.providerUnavailable(),
      errors.validationFailed([{ path: 'goal', message: 'required', code: 'invalid_type' }]),
      errors.notFound('run', { purged: true }),
      errors.notFound('run'),
      errors.conflict({ currentRevision: 3 }),
      errors.conflict(),
      errors.limitReached('attempts'),
      errors.permissionDenied('outside_root'),
      errors.secureStorageUnavailable(),
      errors.modelRefused('anthropic'),
      errors.modelRefused(),
      errors.internal(correlationId),
    ];

    for (const e of made) expect(appErrorSchema.safeParse(e).success).toBe(true);
    expect(errors.requestOutcomeUnknown(attemptId).attemptId).toBe(attemptId);
    expect(errors.internal(correlationId).correlationId).toBe(correlationId);
    expect(errors.notFound('artifact', { purged: true }).details).toMatchObject({ purged: true });
    expect(errors.rateLimited(1500).details).toEqual({ retryAfterMs: 1500 });
  });

  it('budgetBlocked details parse with budgetBreakdownSchema, including scope setup', () => {
    const breakdown = budgetBreakdownSchema.parse({
      L: 50_000,
      C: 40_000,
      R: 0,
      U: 0,
      N: 20_000,
      scope: 'setup',
      total: 60_000,
      allowed: false,
    });

    const e = errors.budgetBlocked(breakdown);

    expect(e.code).toBe('BUDGET_BLOCKED');
    expect(e.alternatives).toEqual(['choose_profile', 'stop']);
    expect(budgetBreakdownSchema.parse(e.details)).toEqual(breakdown);
    expect(e.details?.['total']).toBe(microusd(60_000));
  });

  it('internal carries only the correlation id, ignoring userMessage, details, and ids from ctx (B13)', () => {
    const internalWithCtx = errors.internal as unknown as (c: CorrelationId, ctx: ErrorContext) => AppError;

    const e = internalWithCtx(correlationId, {
      userMessage: 'SQLITE_CONSTRAINT at /Users/me/secret.db',
      details: { stack: 'Error: boom\n    at /Users/me/x.ts:1' },
      runId,
      attemptId,
    });

    expect(e).toEqual({
      code: 'INTERNAL',
      userMessage: ERROR_DEFINITIONS.INTERNAL.userMessage,
      retryable: false,
      nextAction: 'report_bug',
      alternatives: [],
      correlationId,
    });
  });

  it('internal accepts a closed InternalReason and nothing else', () => {
    const asUnknown = errors.internal as (c: CorrelationId | undefined, reason?: unknown) => AppError;

    expect(errors.internal(correlationId, 'snapshot_hash_mismatch').details).toEqual({ reason: 'snapshot_hash_mismatch' });
    expect(errors.internal(undefined, 'aborted')).toEqual(expect.objectContaining({ code: 'INTERNAL', details: { reason: 'aborted', aborted: true } }));
    expect(errors.internal(undefined, 'aborted').correlationId).toBeUndefined();
    expect(asUnknown(correlationId, 'SQLITE_CONSTRAINT at /Users/me/x').details).toBeUndefined();
    expect(INTERNAL_REASONS).toContain('not_implemented');
  });

  it('internal gives a curated static userMessage for not_implemented and integrity_check_failed only', () => {
    expect(errors.internal(correlationId, 'not_implemented').userMessage).toBe(INTERNAL_REASON_MESSAGES.not_implemented);
    expect(errors.internal(undefined, 'integrity_check_failed').userMessage).toMatch(/backup/);
    expect(errors.internal(correlationId, 'artifact_invalid').userMessage).toBe(ERROR_DEFINITIONS.INTERNAL.userMessage);
  });

  it('appError refuses INTERNAL: the type excludes it, and a cast is routed through errors.internal (B13)', () => {
    const unsafe = appError as unknown as (code: string, ctx: ErrorContext) => AppError;
    // @ts-expect-error -- INTERNAL is built only by errors.internal
    appError('INTERNAL');

    const e = unsafe('INTERNAL', { userMessage: 'SQLITE at /Users/me/x.db', details: { reason: 'not_implemented', path: '/Users/me' }, correlationId, runId });

    expect(e).toEqual(errors.internal(correlationId, 'not_implemented'));
  });

  it('typed factory fields win over ctx.details (B13)', () => {
    const auth = errors.authRequired('anthropic', { details: { providerId: 'openai', extra: 1 } });
    const limit = errors.limitReached('attempts', { details: { limit: 'deadline' } });
    const perm = errors.permissionDenied('outside_root', { details: { reason: 'excluded' } });
    const stale = errors.approvalStale('plan_changed', { details: { reason: 'scope_changed' } });
    const rate = errors.rateLimited(1500, { details: { retryAfterMs: 1 } });
    const invalid = errors.outputInvalid([], { details: { issues: 'overridden' } });
    const conflict = errors.conflict({ currentRevision: 3 }, { details: { currentRevision: 1 } });

    expect(auth.details).toEqual({ providerId: 'anthropic', extra: 1 });
    expect(limit.details).toEqual({ limit: 'attempts' });
    expect(perm.details).toEqual({ reason: 'outside_root' });
    expect(stale.details).toEqual({ reason: 'plan_changed' });
    expect(rate.details).toEqual({ retryAfterMs: 1500 });
    expect(invalid.details).toEqual({ issues: [] });
    expect(conflict.details).toEqual({ currentRevision: 3 });
  });

  it('budgetBlocked merges ctx.details under the breakdown (B13)', () => {
    const breakdown = budgetBreakdownSchema.parse({
      L: 10,
      C: 5,
      R: 0,
      U: 0,
      N: 10,
      scope: 'run',
      total: 15,
      allowed: false,
    });

    const e = errors.budgetBlocked(breakdown, { details: { stepKey: 'plan', total: 0 } });

    expect(e.details).toEqual({ ...breakdown, stepKey: 'plan' });
  });

  it('appError applies context overrides and truncates long messages', () => {
    const e = appError('CONFLICT', { userMessage: 'x'.repeat(1000), runId, details: { a: 1 } });

    expect(e.userMessage).toHaveLength(USER_MESSAGE_MAX);
    expect(e.runId).toBe(runId);
    expect(e.details).toEqual({ a: 1 });
    expect(e.retryable).toBe(false);
    expect(e.nextAction).toBe('reload');
  });
});

describe('RelayError', () => {
  it('carries the AppError and maps at boundaries', () => {
    const inner = errors.conflict();
    const thrown = new RelayError(inner);

    expect(thrown.message).toBe(inner.userMessage);
    expect(thrown.name).toBe('RelayError');
    expect(isRelayError(thrown)).toBe(true);
    expect(toAppError(thrown, correlationId)).toBe(inner);
  });

  it('maps unknown throwables to INTERNAL without leaking the message', () => {
    const e = toAppError(new Error('/Users/me/secret path sk-ant-api03-xxxxxxxxxxxx'), correlationId);

    expect(e.code).toBe('INTERNAL');
    expect(e.correlationId).toBe(correlationId);
    expect(JSON.stringify(e)).not.toContain('/Users/me');
    expect(isRelayError('nope')).toBe(false);
  });
});

describe('errnoOf / errnoDetails', () => {
  it('returns only the errno code of a Node system error, never its message or path', () => {
    const e = Object.assign(new Error("EACCES: permission denied, open '/Users/someone/secret'"), {
      code: 'EACCES',
      path: '/Users/someone/secret',
    });

    expect(errnoOf(e)).toBe('EACCES');
    expect(errnoDetails(e)).toEqual({ errno: 'EACCES' });
    expect(JSON.stringify(errnoDetails(e))).not.toContain('/Users');
  });

  it('ignores values without an errno-shaped code', () => {
    expect(errnoOf(new Error('x'))).toBeUndefined();
    expect(errnoOf({ code: 'ERR_INVALID_ARG_TYPE' })).toBeUndefined();
    expect(errnoOf({ code: 42 })).toBeUndefined();
    expect(errnoOf(null)).toBeUndefined();
    expect(errnoOf('ENOENT')).toBeUndefined();
    expect(errnoDetails(undefined)).toEqual({});
  });
});

describe('RelayError cause', () => {
  it('keeps the cause in-process but toAppError serializes only the AppError', () => {
    const cause = Object.assign(new Error('401 from upstream'), { headers: { authorization: 'Bearer x' } });
    const appErr = errors.providerUnavailable('openai');

    const e = new RelayError(appErr, { cause });

    expect(e.cause).toBe(cause);
    expect(toAppError(e, 'cor_01J9ZZZZZZZZZZZZZZZZZZZZZZ' as CorrelationId)).toBe(appErr);
    expect(JSON.stringify(toAppError(e, 'cor_01J9ZZZZZZZZZZZZZZZZZZZZZZ' as CorrelationId))).not.toContain('upstream');
    expect(new RelayError(appErr).cause).toBeUndefined();
  });
});
