// F9b: the reconcile task — only `unknown` attempts with a provider response id whose provider supports request
// lookup; completed / failed with usage / failed without usage / in_progress (3 re-polls over 30 s) / not_found.
import { afterEach, describe, expect, it } from 'vitest';
import { errors } from '@relay/contracts';
import type { RunId } from '@relay/contracts';
import type { FakeReconcileAnswer, FakeScenario, ModelResult, ProviderRegistry, ReconciliationResult } from '@relay/providers';
import type { AttemptRow, Repos } from '@relay/storage';
import { isReconcilable, recordedProviderOptions, reconcileAttempt, reconcileUnknownAttempts, reconciledAmount } from './recovery.js';
import { createHarness } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';
import { drive, driveThroughApproval } from './testing/drive.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** The review call reaches the fake (so it can be looked up later) but the answer is lost: outcome unknown. */
function loseReviewAnswer(extra: (base: ProviderRegistry) => Partial<ReturnType<ProviderRegistry['get']>> = () => ({})) {
  return (base: ProviderRegistry): ProviderRegistry => ({
    list: () => base.list(),
    get: (id) => {
      const a = base.get(id);
      return {
        ...a,
        generate: async (req, gctx) => {
          const res: ModelResult = await a.generate(req, gctx);
          if (req.metadata.stepKey !== 'review' || req.metadata.purpose !== 'initial') return res;
          return { kind: 'error', error: errors.providerUnavailable(id), phase: 'sent_no_response' };
        },
        ...extra(base),
      };
    },
  });
}

const lookupScenario = (reconcile: readonly FakeReconcileAnswer[], usage?: { outputTokens: number }): FakeScenario => ({
  name: 'lookup', capabilityOverrides: { supportsRequestLookup: true },
  steps: [{ match: { stepKey: 'review' }, times: Infinity, result: { kind: 'success' }, reconcile, ...(usage === undefined ? {} : { usage }) }],
});

async function unknownReview(o: HarnessOptions): Promise<{ x: Harness; runId: RunId; a: AttemptRow }> {
  const x = await createHarness(o);
  h = x;
  const runId = await x.startRun();
  expect(await drive(x, runId, ['paused'])).toBe('paused');
  const a = x.db.repos.attempts.listForRun(runId)[0];
  if (a === undefined) throw new Error('no attempt');
  expect([a.state, a.providerResponseId === null]).toEqual(['unknown', false]);
  return { x, runId, a };
}

const types = (r: Repos, runId: RunId, attemptId: string) => {
  const page = r.ledger.list(runId, { limit: 100, sort: 'created_asc' });
  return (page.ok ? page.value.items : []).filter((e) => e.attemptId === attemptId).map((e) => [e.type, e.bucket, e.deltaMicrousd, e.certainty]);
};

describe('F9b reconcile task', () => {
  it('reconcile-completed: resolve_unknown −N + settle +X (calculated), attempt reconciled_succeeded, step succeeded with no new call; the run resumes', async () => {
    const { x, runId, a } = await unknownReview({ scenario: 'reconcile-completed', providers: loseReviewAnswer() });
    const calls = x.callLog.entries().length;

    const out = await reconcileUnknownAttempts(x.ctx, new AbortController().signal);

    const r = x.db.repos;
    expect(out.get(a.id)).toBe('completed');
    expect(r.attempts.get(a.id).state).toBe('reconciled_succeeded');
    const X = r.ledger.attemptBalances(a.id).settled;
    expect(X).toBeGreaterThan(0);
    expect(types(r, runId, a.id)).toEqual([
      ['reserve', 'reserved', a.reservationMicrousd, null], ['move_to_unknown', 'reserved', 0 - a.reservationMicrousd, null],
      ['move_to_unknown', 'unknown', a.reservationMicrousd, 'unknown'], ['resolve_unknown', 'unknown', 0 - a.reservationMicrousd, null], ['settle', 'settled', X, 'calculated'],
    ]);
    expect(r.steps.get(a.stepRunId)).toEqual(expect.objectContaining({ state: 'succeeded', outcome: 'findings' }));
    expect(r.artifacts.listForRun(runId, ['findings', 'raw_response']).filter((art) => art.attemptId === a.id)).toHaveLength(2);
    expect(x.callLog.entries()).toHaveLength(calls); // no new generate call
    expect(r.runs.get(runId).status).toBe('queued');
    expect(await driveThroughApproval(x, runId, ['completed'])).toBe('completed');
  });

  it('reconcile-slow: in_progress is re-polled every 10 s (injected timers) until completed', async () => {
    const x = await createHarness({ scenario: 'reconcile-slow' });
    h = x;
    const runId = await x.startRun();
    expect(await driveThroughApproval(x, runId, ['paused'])).toBe('paused');
    const a = x.db.repos.attempts.listForRun(runId).find((att) => att.state === 'unknown');
    if (a === undefined) throw new Error('no unknown attempt');

    const p = reconcileUnknownAttempts(x.ctx, new AbortController().signal);
    for (const n of [1, 2]) {
      await x.waitFor(() => x.callLog.reconcileEntries().length >= n);
      await x.waitFor(() => x.timers.pending() > 0);
      x.timers.advance(10_000);
    }
    const out = await p;

    expect(out.get(a.id)).toBe('completed');
    expect(x.callLog.reconcileEntries()).toHaveLength(3);
    expect(x.db.repos.steps.get(a.stepRunId).state).toBe('succeeded');
    expect(x.db.repos.runs.get(runId).status).toBe('queued');
  });

  it('in_progress forever: 3 re-polls, then left unknown; an abort stops the wait', async () => {
    const { x, a } = await unknownReview({ scenario: lookupScenario(['in_progress']), providers: loseReviewAnswer() });

    const p = reconcileAttempt(x.ctx, a, new AbortController().signal);
    for (const n of [1, 2, 3]) {
      await x.waitFor(() => x.callLog.reconcileEntries().length >= n);
      await x.waitFor(() => x.timers.pending() > 0);
      x.timers.advance(10_000);
    }
    expect(await p).toBe('in_progress');
    expect(x.callLog.reconcileEntries()).toHaveLength(4);
    expect(x.db.repos.attempts.get(a.id).state).toBe('unknown');

    const ac = new AbortController();
    const q = reconcileAttempt(x.ctx, a, ac.signal);
    await x.waitFor(() => x.callLog.reconcileEntries().length >= 5);
    ac.abort();
    expect(await q).toBe('in_progress');
  });

  it('failed with usage: settle +X calculated, attempt reconciled_failed, step ready (transport budget left), run resumes', async () => {
    const { x, runId, a } = await unknownReview({ scenario: lookupScenario(['failed'], { outputTokens: 50 }), providers: loseReviewAnswer() });

    expect((await reconcileUnknownAttempts(x.ctx, new AbortController().signal)).get(a.id)).toBe('failed');

    const r = x.db.repos;
    expect(r.attempts.get(a.id).state).toBe('reconciled_failed');
    expect(r.ledger.attemptBalances(a.id)).toEqual(expect.objectContaining({ unknown: 0, reserved: 0 }));
    expect(r.ledger.attemptBalances(a.id).settled).toBeGreaterThan(0);
    expect(r.steps.get(a.stepRunId)).toEqual(expect.objectContaining({ state: 'ready', transportRetriesUsed: 1 }));
    expect(r.runs.get(runId).status).toBe('queued');
  });

  it('failed without usage: settle +0 (calculated); a spent transport budget fails the step (run stays paused, retry_step offered)', async () => {
    const { x, runId, a } = await unknownReview({ scenario: lookupScenario(['failed']), providers: loseReviewAnswer() });
    x.db.tx('immediate', (r) => r.steps.transition(a.stepRunId, ['unknown'], 'unknown', { transportRetriesUsed: 1 }));

    await reconcileUnknownAttempts(x.ctx, new AbortController().signal);

    const r = x.db.repos;
    expect(types(r, runId, a.id).slice(-2)).toEqual([['resolve_unknown', 'unknown', 0 - a.reservationMicrousd, null], ['settle', 'settled', 0, 'calculated']]);
    expect(r.steps.get(a.stepRunId).state).toBe('failed');
    const detail = await x.engine.handle('relay/v1/runs.get', { runId });
    expect(detail.ok && [detail.data.status, detail.data.availableActions]).toEqual(['paused', ['retry_step', 'choose_profile', 'stop']]);
  });

  it('not_found and missing lookup support leave the attempt unknown; an unknown attempt of an interrupted run stays interrupted', async () => {
    const { x, runId, a } = await unknownReview({ scenario: lookupScenario([]), providers: loseReviewAnswer() });

    expect((await reconcileUnknownAttempts(x.ctx, new AbortController().signal)).get(a.id)).toBe('not_found');
    expect(x.db.repos.attempts.get(a.id).state).toBe('unknown');
    expect(isReconcilable(x.ctx, { ...a, profileSnapshot: { ...a.profileSnapshot, capabilities: { ...a.profileSnapshot.capabilities, supportsRequestLookup: false } } })).toBe(false);
    expect(isReconcilable(x.ctx, { ...a, providerResponseId: null })).toBe(false);
    expect(x.db.repos.runs.get(runId).status).toBe('paused');
  });

  it('N1: eligibility uses the provider options recorded on the attempt (OpenAI store=false never looks up)', async () => {
    const { x, a } = await unknownReview({ scenario: lookupScenario([]), providers: loseReviewAnswer() });

    const openai = { ...a, providerId: 'openai' as const };
    const recorded = (store: boolean) => ({ ...openai, estimate: { ...(a.estimate as object), providerOptions: { openai: { storeResponses: store } } } });

    expect(recordedProviderOptions(a)).toEqual({ openai: { storeResponses: true } });
    expect(isReconcilable(x.ctx, recorded(false))).toBe(false);
    expect(isReconcilable(x.ctx, recorded(true))).toBe(true);
    expect(recordedProviderOptions({ estimate: null })).toBeUndefined();
    const p = x.db.repos.projects.get(x.projectId);
    x.db.repos.projects.update(x.projectId, { providerPolicy: { ...p.providerPolicy, providerOptions: { openai: { storeResponses: false } } } }, p.updatedAt);
    expect(isReconcilable(x.ctx, { ...openai, estimate: {} })).toBe(false); // legacy row: the project's current options
    expect(isReconcilable(x.ctx, recorded(true))).toBe(true); // the recorded value wins
  });

  it('usageKnown=false: completed settles the full N as estimated; failed keeps the unknown liability (attempt abandoned)', async () => {
    const withFlag = (kind: 'completed' | 'failed') => (base: ProviderRegistry) => ({
      reconcile: async (ids: { providerResponseId: string }, c: { apiKey: string; signal: AbortSignal }): Promise<ReconciliationResult> => {
        const res = await base.get('anthropic').reconcile?.(ids, c);
        if (res === undefined) throw new Error('no reconcile');
        return { ...res, kind, usageKnown: false } as ReconciliationResult;
      },
    });
    const done = await unknownReview({ scenario: lookupScenario(['completed']), providers: loseReviewAnswer(withFlag('completed')) });
    await reconcileUnknownAttempts(done.x.ctx, new AbortController().signal);
    expect(done.x.db.repos.ledger.settledByCertainty(done.runId).estimated).toBe(done.a.reservationMicrousd);
    await done.x.cleanup();
    h = undefined;

    const failed = await unknownReview({ scenario: lookupScenario(['failed'], { outputTokens: 5 }), providers: loseReviewAnswer(withFlag('failed')) });
    await reconcileUnknownAttempts(failed.x.ctx, new AbortController().signal);
    expect(failed.x.db.repos.attempts.get(failed.a.id).state).toBe('abandoned');
    expect(failed.x.db.repos.ledger.attemptBalances(failed.a.id)).toEqual(expect.objectContaining({ unknown: failed.a.reservationMicrousd, settled: 0 }));
  });

  it('reconciledAmount prices usage, falls back to N when usage is unknown, and marks a price-tier mismatch estimated', () => {
    const prices = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } as never;
    const usage = { uncachedInputTokens: 10, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10 };

    expect(reconciledAmount({ kind: 'failed', usage: null, flags: {} }, prices, 99 as never)).toEqual({ X: 0, certainty: 'calculated' });
    expect(reconciledAmount({ kind: 'failed', usage, flags: { priceTierMismatch: true } }, prices, 99 as never)).toEqual({ X: 20, certainty: 'estimated' });
    expect(reconciledAmount({ kind: 'completed', json: {}, usage, rawUsage: null, flags: { usageKnown: false } }, prices, 99 as never)).toEqual({ X: 99, certainty: 'estimated' });
  });

  it('engine.start() runs the reconcile task after recovery', async () => {
    const { x, a } = await unknownReview({ scenario: 'reconcile-completed', providers: loseReviewAnswer() });

    await x.engine.start();
    await x.waitFor(() => x.db.repos.attempts.get(a.id).state === 'reconciled_succeeded');

    expect(x.db.repos.steps.get(a.stepRunId).state).toBe('succeeded');
  });
});
