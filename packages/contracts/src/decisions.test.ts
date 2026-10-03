// Contract shapes of founder decisions 1–3 (renderer-facing): estimates instead of unknown charges, per-step output
// limits, and additive report fields that keep older stored reports readable.
import { describe, expect, it } from 'vitest';
import { MAX_OUTPUT_TOKENS_CEILING, MIN_OUTPUT_TOKEN_OVERRIDE } from './defaults.js';
import { attemptViewSchema } from './domain/attempt.js';
import { costSummarySchema } from './domain/ledger.js';
import { outputTokenOverridesSchema, runStartInputSchema } from './domain/run.js';
import { runOps } from './ipc/runs.js';
import { reportV1Schema } from './outputs/report.v1.js';
import { costSummaryFixture, fakeId, reportFixture } from './test-fixtures.js';

describe('decision 1 contracts', () => {
  it('CostSummary requires hasEstimates; AttemptView requires mayNotHaveBeenCharged and accepts an estimated cost', () => {
    const noFlag = costSummaryFixture();
    delete noFlag['hasEstimates'];
    expect(costSummarySchema.safeParse(noFlag).success).toBe(false);
    expect(costSummarySchema.safeParse({ ...costSummaryFixture(), hasEstimates: true }).success).toBe(true);
    const view = {
      id: fakeId('attempt'), stepRunId: fakeId('stepRun'), stepKey: 'implement', seq: 1, purpose: 'initial', state: 'unknown', providerId: 'anthropic',
      modelId: 'claude-opus-5-5', usage: null, cost: { microusd: 30_000, certainty: 'estimated' }, providerLatencyMs: null, appElapsedMs: 10,
      providerRequestId: null, startedAt: 1, finishedAt: 2, mayNotHaveBeenCharged: true,
    };
    expect(attemptViewSchema.safeParse(view).success).toBe(true);
    const without: Record<string, unknown> = { ...view };
    delete without['mayNotHaveBeenCharged'];
    expect(attemptViewSchema.safeParse(without).success).toBe(false);
  });

  it('report.v1: unknownLiabilities is optional, estimatedCharges is additive, and a stored report without totals.hasEstimates derives it', () => {
    const legacy = { ...reportFixture(), totals: { ...costSummaryFixture(), settledEstimated: 5 }, unknownLiabilities: [] } as Record<string, unknown>;
    delete (legacy['totals'] as Record<string, unknown>)['hasEstimates'];
    const parsed = reportV1Schema.parse(legacy);
    expect(parsed.totals.hasEstimates).toBe(true);
    expect(parsed.estimatedCharges).toBeUndefined();
    const noEstimate = reportV1Schema.parse({ ...legacy, totals: { ...(legacy['totals'] as object), settledEstimated: 0 } });
    expect(noEstimate.totals.hasEstimates).toBe(false);
    const current = { ...reportFixture(), estimatedCharges: [{ attemptId: fakeId('attempt'), stepKey: 'plan', amountMicrousd: 1_234, mayNotHaveBeenCharged: false }] };
    expect(reportV1Schema.parse(current).estimatedCharges).toHaveLength(1);
    expect(reportV1Schema.safeParse({ ...current, estimatedCharges: [{ attemptId: fakeId('attempt'), stepKey: 'plan', amountMicrousd: 1 }] }).success).toBe(false);
  });

  it('runs.decideUnknown stays declared (older renderers) and can answer CONFLICT', () => {
    expect(runOps['runs.decideUnknown'].errors).toContain('CONFLICT');
  });
});

describe('decision 3 contracts', () => {
  it('outputTokenOverrides: integers from 256 up to the global ceiling, keyed by step key; optional on runs.start', () => {
    expect(outputTokenOverridesSchema.safeParse({ review: MIN_OUTPUT_TOKEN_OVERRIDE, implement: MAX_OUTPUT_TOKENS_CEILING }).success).toBe(true);
    expect(outputTokenOverridesSchema.safeParse({ review: 255 }).success).toBe(false);
    expect(outputTokenOverridesSchema.safeParse({ review: 1000.5 }).success).toBe(false);
    expect(outputTokenOverridesSchema.safeParse({ review: MAX_OUTPUT_TOKENS_CEILING + 1 }).success).toBe(false);
    expect(outputTokenOverridesSchema.safeParse({}).success).toBe(true);
    const input = { idempotencyKey: 'abcdefgh-0001', projectId: fakeId('project'), workflowId: fakeId('workflow'), workflowVersion: 1, goal: 'g',
      input: { kind: 'files', relPaths: ['a.ts'] } };
    expect(runStartInputSchema.safeParse(input).success).toBe(true);
    expect(runStartInputSchema.safeParse({ ...input, outputTokenOverrides: { review: 4_000 } }).success).toBe(true);
  });

  it('runs.preflight output requires stepLimits with minMaxOutputTokens fixed at 256', () => {
    const out = runOps['runs.preflight'].output;
    const base = {
      inputSummary: { files: 1, bytes: 2, estimatedInputTokens: 3, memoryRecords: [], providersReceivingContext: ['anthropic'] },
      firstReservation: { N: 10, basis: 'local_estimate' },
      budget: { L: 100, C: 0, R: 0, U: 0, N: 10, scope: 'run', total: 10, allowed: true },
      issues: [],
    };
    const limit = { stepKey: 'review', defaultMaxOutputTokens: 8_000, minMaxOutputTokens: 256, modelMaxOutputTokens: 64_000 };
    expect(out.safeParse({ ...base, stepLimits: [limit] }).success).toBe(true);
    expect(out.safeParse(base).success).toBe(false);
    expect(out.safeParse({ ...base, stepLimits: [{ ...limit, minMaxOutputTokens: 100 }] }).success).toBe(false);
  });
});
