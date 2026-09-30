// Offline tests for the live-test spend accounting (04 §D9 / §D9b). No network, no keys: pure helper checks.
import { describe, expect, it } from 'vitest';
import { errors, microusd } from '@relay/contracts';
import type { ModelPrices } from '@relay/contracts';
import { computeCost } from '@relay/providers';
import type { ModelResult, NormalizedUsage } from '@relay/providers';
import { LiveCapError, createLiveBudget, createWorkflowSpend, liveChargeMicrousd } from './live-budget.js';

const PRICES: ModelPrices = { input: microusd(1_000_000), output: microusd(10_000_000), cacheRead: microusd(100_000), cacheWrite: microusd(1_250_000) };
const USAGE: NormalizedUsage = { uncachedInputTokens: 1_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100 };
const COST = computeCost(USAGE, PRICES).microusd; // 1000 + 1000 = 2000 µUSD
const N = 50_000;

const success = (over: Partial<Extract<ModelResult, { kind: 'success' }>> = {}): ModelResult => ({
  kind: 'success',
  json: {},
  rawText: '{}',
  usage: USAGE,
  rawUsage: null,
  stopReason: 'end_turn',
  latencyMs: 1,
  ...over,
});

const unknownError = (phase: Extract<ModelResult, { kind: 'error' }>['phase'], details: Record<string, unknown> = {}): ModelResult => ({
  kind: 'error',
  error: { ...errors.providerUnavailable('openai'), details },
  phase,
});

describe('liveChargeMicrousd', () => {
  it('charges the computed cost of known usage', () => {
    expect(COST).toBe(2_000);
    expect(liveChargeMicrousd(success(), PRICES, N)).toBe(COST);
    expect(liveChargeMicrousd({ kind: 'truncated', rawText: '', usage: USAGE, rawUsage: null }, PRICES, N)).toBe(COST);
  });

  it('charges N when usage is not known (a zero placeholder is not a known $0)', () => {
    const zero: NormalizedUsage = { uncachedInputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 };
    expect(liveChargeMicrousd(success({ usage: zero, usageKnown: false }), PRICES, N)).toBe(N);
  });

  it('charges at least N on a price-tier mismatch', () => {
    expect(liveChargeMicrousd(success({ priceTierMismatch: true }), PRICES, N)).toBe(N);
    expect(liveChargeMicrousd(success({ priceTierMismatch: true }), PRICES, 10)).toBe(COST);
  });

  it('charges nothing for a request that was provably never sent', () => {
    expect(liveChargeMicrousd(unknownError('not_sent'), PRICES, N)).toBe(0);
  });

  it.each(['sent_no_response', 'responded', 'responded_partial'] as const)('charges N for an unknown outcome in phase %s', (phase) => {
    expect(liveChargeMicrousd(unknownError(phase), PRICES, N)).toBe(N);
  });

  it('charges partial usage when it exceeds N (from details.partialUsage or error.usage)', () => {
    const big: NormalizedUsage = { ...USAGE, outputTokens: 10_000 }; // 1000 + 100 000 µUSD
    const bigCost = computeCost(big, PRICES).microusd;
    expect(liveChargeMicrousd(unknownError('responded_partial', { partialUsage: big }), PRICES, N)).toBe(bigCost);
    expect(liveChargeMicrousd({ ...unknownError('responded_partial'), usage: big }, PRICES, N)).toBe(bigCost);
    expect(liveChargeMicrousd(unknownError('responded_partial', { partialUsage: USAGE }), PRICES, N)).toBe(N);
    expect(liveChargeMicrousd(unknownError('responded_partial', { partialUsage: { bogus: 1 } }), PRICES, N)).toBe(N);
  });
});

describe('createLiveBudget', () => {
  it('pre-checks the upper bound before a call and shares one cumulative total', () => {
    const budget = createLiveBudget(100_000);

    budget.admit(N, 'anthropic testConnection');
    budget.charge(success(), PRICES, N);
    budget.charge(unknownError('responded'), PRICES, N); // another provider, same total
    expect(budget.spent()).toBe(COST + N);

    expect(() => { budget.admit(N, 'openai generate'); }).toThrow(LiveCapError);
    expect(() => { budget.admit(100_000 - COST - N, 'fits exactly'); }).not.toThrow();
    expect(() => { budget.admit(Number.NaN, 'nan'); }).toThrow(/invalid upper allowance/);
    expect(() => { budget.admit(-1, 'negative'); }).toThrow(/invalid upper allowance/);
  });

  it('throws once a charge pushes the cumulative spend past the cap', () => {
    const budget = createLiveBudget(N);

    expect(budget.charge(unknownError('sent_no_response'), PRICES, N)).toBe(N);
    expect(() => budget.charge(success(), PRICES, N)).toThrow(/exceeds the cap/);
    expect(budget.spent()).toBe(N + COST);
  });
});

describe('createWorkflowSpend', () => {
  it('adds C + U + R of every run and reports the remaining cap', () => {
    const spend = createWorkflowSpend(1_500_000);

    expect(spend.record({ C: 100_000, U: 20_000, R: 5_000 })).toBe(125_000);
    expect(spend.spent()).toBe(125_000);
    expect(spend.remaining()).toBe(1_375_000);
    expect(() => { spend.assertWithinCap(); }).not.toThrow();
  });

  it('halts the remaining providers after a failure (first reason wins)', () => {
    const spend = createWorkflowSpend(1_000);

    expect(spend.haltedReason()).toBeUndefined();
    spend.halt('anthropic workflow failed');
    spend.halt('second');
    expect(spend.haltedReason()).toBe('anthropic workflow failed');
    expect(() => { spend.assertWithinCap(); }).not.toThrow();
  });

  it('fails and halts when the cumulative spend exceeds the cap', () => {
    const spend = createWorkflowSpend(1_000);

    spend.record({ C: 900, U: 0, R: 200 });
    expect(spend.remaining()).toBe(0);
    expect(() => { spend.assertWithinCap(); }).toThrow(LiveCapError);
    expect(spend.haltedReason()).toBe('workflow cap exceeded');
  });

  it('an unreadable run ledger halts and fails the cap assertion (spend unknown)', () => {
    const spend = createWorkflowSpend(1_000);

    spend.recordUnreadable('openai: run ledger unreadable');
    expect(spend.haltedReason()).toBe('openai: run ledger unreadable');
    expect(() => { spend.assertWithinCap(); }).toThrow(/spend is unknown/);
  });
});
