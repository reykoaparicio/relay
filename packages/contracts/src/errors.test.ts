import { describe, expect, it } from 'vitest';
import { budgetBreakdownSchema } from './domain/ledger.js';
import {
  appError,
  appErrorSchema,
  ERROR_DEFINITIONS,
  errors,
  isRelayError,
  RelayError,
  toAppError,
  USER_MESSAGE_MAX,
} from './errors.js';
import type { AttemptId, CorrelationId, RunId } from './ids.js';
import { microusd } from './money.js';
import type { RelPath } from './primitives.js';
import { ERROR_CODES, NEXT_ACTIONS } from './status.js';

const BODY = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const attemptId = `att_${BODY}` as AttemptId;
const runId = `run_${BODY}` as RunId;
const correlationId = `cor_${BODY}` as CorrelationId;
const toCamel = (code: string): string => code.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe('error taxonomy', () => {
  it('every ErrorCode has a factory, a default nextAction, and retryable', () => {
    for (const code of ERROR_CODES) {
      const def = ERROR_DEFINITIONS[code];
      const factory = (errors as Record<string, unknown>)[toCamel(code)];

      expect(typeof factory).toBe('function');
      expect(NEXT_ACTIONS).toContain(def.nextAction);
      expect(typeof def.retryable).toBe('boolean');
      expect(def.userMessage.length).toBeLessThanOrEqual(USER_MESSAGE_MAX);
      expect(appErrorSchema.safeParse(appError(code)).success).toBe(true);
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
