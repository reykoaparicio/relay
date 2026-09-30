import { describe, expect, it } from 'vitest';
import { epochMs } from '@relay/contracts';
import type { ApprovalRow, ProjectRow, RunRow, StepRow } from '@relay/storage';
import type { DispatchCheckInput } from './policy.js';
import { checkDispatch, checkDispatchAll } from './policy.js';
import type { ModelStepSnapshot } from './ports.js';

const caps = { structuredOutput: true, streaming: true, tools: false, maxInputTokens: 10_000, maxOutputTokens: 4_000, supportsRequestLookup: false,
  supportsTokenCounting: false, effortLevels: ['low' as const], thinkingAlwaysOn: false };
const approval = { decision: 'approved', invalidatedAt: null, planHash: 'p'.repeat(64), contextHash: 'c'.repeat(64), requestedPermissions: { providers: ['anthropic'] } } as unknown as ApprovalRow;

function input(over: Partial<DispatchCheckInput> = {}): DispatchCheckInput {
  return {
    run: { status: 'running', attemptCount: 0, limits: { maxAttempts: 10, executionTimeoutSeconds: 60 }, executionMsUsed: 0, runningSince: epochMs(0) } as unknown as RunRow,
    step: { state: 'ready', transportRetriesUsed: 0, schemaRepairsUsed: 0, rateLimitWaitsUsed: 0 } as unknown as StepRow,
    stepSnap: { profile: { providerId: 'anthropic', modelId: 'm', capabilities: caps }, retryPolicy: { transport: 1, schemaRepair: 1, rateLimitWaits: 3 } } as unknown as ModelStepSnapshot,
    request: { maxOutputTokens: 1_000 },
    estimate: { inputTokens: 1_000 },
    credentialOk: true,
    binding: null,
    project: { providerPolicy: { allowedProviderIds: ['anthropic'] } } as unknown as ProjectRow,
    now: epochMs(1_000),
    ...over,
  };
}
const codeOf = (i: DispatchCheckInput) => {
  const r = checkDispatch(i);
  return r.ok ? null : [r.error.code, r.error.details?.['reason'] ?? r.error.details?.['limit'] ?? null];
};

describe('checkDispatch (F6)', () => {
  it('passes a dispatchable attempt', () => {
    expect(checkDispatch(input()).ok).toBe(true);
  });

  it('evaluates each check in isolation', () => {
    expect(codeOf(input({ run: { ...input().run, status: 'paused' } }))).toEqual(['CONFLICT', 'not_dispatchable']);
    expect(codeOf(input({ project: { providerPolicy: { allowedProviderIds: [] } } as unknown as ProjectRow }))).toEqual(['PERMISSION_DENIED', 'provider_not_allowed']);
    expect(codeOf(input({ credentialOk: false }))?.[0]).toBe('AUTH_REQUIRED');
    const snap = (c: object) => ({ ...input().stepSnap, profile: { ...input().stepSnap.profile, capabilities: { ...caps, ...c } } }) as ModelStepSnapshot;
    expect(codeOf(input({ stepSnap: snap({ structuredOutput: false }) }))).toEqual(['MODEL_UNSUPPORTED', 'structured_output']);
    expect(codeOf(input({ request: { maxOutputTokens: 5_000 } }))).toEqual(['MODEL_UNSUPPORTED', 'max_output_tokens']);
    expect(codeOf(input({ request: { maxOutputTokens: 1_000, effort: 'max' } }))).toEqual(['MODEL_UNSUPPORTED', 'effort']);
    expect(codeOf(input({ estimate: { inputTokens: 9_500 } }))?.[0]).toBe('CONTEXT_TOO_LARGE');
    expect(codeOf(input({ run: { ...input().run, attemptCount: 10 } }))).toEqual(['LIMIT_REACHED', 'attempts']);
    expect(codeOf(input({ now: epochMs(60_000) }))).toEqual(['LIMIT_REACHED', 'deadline']);
    expect(codeOf(input({ step: { ...input().step, transportRetriesUsed: 2 } }))).toEqual(['LIMIT_REACHED', 'attempts']);
  });

  it('binds implement/verify to a valid approval: plan hash, context hash, and provider (R3-11)', () => {
    const bind = (over: object) => input({ binding: { approval, currentPlanHash: 'p'.repeat(64), runContextHash: 'c'.repeat(64), providerId: 'anthropic', ...over } });

    expect(checkDispatch(bind({})).ok).toBe(true);
    expect(codeOf(bind({ approval: undefined }))).toEqual(['APPROVAL_STALE', 'plan_changed']);
    expect(codeOf(bind({ currentPlanHash: 'x'.repeat(64) }))).toEqual(['APPROVAL_STALE', 'plan_changed']);
    expect(codeOf(bind({ runContextHash: 'x'.repeat(64) }))).toEqual(['APPROVAL_STALE', 'plan_changed']);
    expect(codeOf(bind({ providerId: 'openai' }))).toEqual(['APPROVAL_STALE', 'provider_changed']);
    expect(codeOf(bind({ approval: { ...approval, requestedPermissions: null } }))).toEqual(['APPROVAL_STALE', 'provider_changed']);
  });

  it('reports the first failure in F6 order and lists all of them for preflight', () => {
    const bad = input({ credentialOk: false, run: { ...input().run, attemptCount: 10 }, project: { providerPolicy: { allowedProviderIds: [] } } as unknown as ProjectRow });

    expect(codeOf(bad)?.[0]).toBe('PERMISSION_DENIED');
    expect(checkDispatchAll(bad).map((e) => e.code)).toEqual(['PERMISSION_DENIED', 'AUTH_REQUIRED', 'LIMIT_REACHED']);
  });
});
