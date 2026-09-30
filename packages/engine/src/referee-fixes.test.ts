// Regression tests for the Referee-confirmed engine bugs B3–B9 (B1/B2 live in recovery/run-machine/approvals tests,
// B5's pure pricing in budget.test.ts, B8's escaping in prompt-render.test.ts). Each fails on the pre-fix code.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeCost, maxPrices, ok } from '@relay/contracts';
import type { ModelPrices, RunId, StepKey, StepRunId } from '@relay/contracts';
import type { ModelResult, ModelSuccess, ProviderRegistry } from '@relay/providers';
import type { Repos } from '@relay/storage';
import { decideApproval } from './approvals.js';
import { executeModelAttempt } from './checkpoints.js';
import { applyRunEvent } from './run-machine.js';
import { createEngineContext, createEngineFromContext, stepsToPromote, tick } from './runner.js';
import { snapshotOf } from './snapshot.js';
import { applyStepEvent } from './step-machine.js';
import { createHarness, sleep } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const REVIEW = 'review' as StepKey;

async function readyReview(o: HarnessOptions = {}): Promise<{ harness: Harness; runId: RunId; stepRunId: StepRunId }> {
  const harness = await createHarness(o);
  h = harness;
  const runId = await harness.startRun();
  await tick(harness.ctx); // runChecks → running
  await tick(harness.ctx); // intake
  harness.db.tx('immediate', (r) => {
    for (const s of stepsToPromote(r.steps.latestPerStepKey(runId), snapshotOf(r.runs.get(runId)))) applyStepEvent(r, [], s, 'DEPS_MET');
  });
  const step = harness.db.repos.steps.latestFor(runId, REVIEW);
  if (step?.state !== 'ready') throw new Error('review not ready');
  return { harness, runId, stepRunId: step.id };
}

function ledgerOf(r: Repos, runId: RunId) {
  const page = r.ledger.list(runId, { limit: 200, sort: 'created_asc' });
  if (!page.ok) throw new Error('ledger');
  return page.value.items;
}

/** Wraps every adapter's `generate`. */
function wrapGenerate(f: (base: ProviderRegistry, ...a: Parameters<ReturnType<ProviderRegistry['get']>['generate']>) => Promise<ModelResult>) {
  return (base: ProviderRegistry): ProviderRegistry => ({
    list: () => base.list(),
    get: (id) => ({ ...base.get(id), generate: (req, gctx) => f(base, req, gctx) }),
  });
}

/** Consumes a wake-up left pending by earlier commits, so the next sleep really sleeps. */
async function drainWake(harness: Harness): Promise<void> {
  const d = harness.ctx.wake.wait(0);
  harness.timers.advance(0);
  await d;
}

/** Resolves with 'resolved' or 'timeout' after `ms` of real time. */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<'resolved' | 'timeout'> {
  return Promise.race([p.then(() => 'resolved' as const), sleep(ms).then(() => 'timeout' as const)]);
}

describe('B3: settlement is CAS-first and stops after the lease is released', () => {
  it('an attempt moved to unknown by recovery while in flight is never settled again (no ledger writes, R never negative)', async () => {
    const box: { harness?: Harness } = {};
    const { harness, runId, stepRunId } = await readyReview({
      hooks: {
        afterProviderResponse: (c) => {
          // Another owner's recovery (or forceUnknown) moved the attempt to unknown before this settlement.
          const x = box.harness;
          if (x === undefined || c.attemptId === undefined) return;
          const attemptId = c.attemptId;
          x.db.tx('immediate', (r) => {
            const a = r.attempts.get(attemptId);
            r.attempts.transition(attemptId, ['dispatching'], 'unknown', { finishedAt: x.clock.now() });
            r.ledger.append([
              { scope: 'run', type: 'move_to_unknown', bucket: 'reserved', deltaMicrousd: 0 - a.reservationMicrousd, attemptId, runId, projectId: x.projectId, priceCatalogVersion: 'v', createdAt: x.clock.now() },
              { scope: 'run', type: 'move_to_unknown', bucket: 'unknown', deltaMicrousd: a.reservationMicrousd, certainty: 'unknown', attemptId, runId, projectId: x.projectId, priceCatalogVersion: 'v', createdAt: x.clock.now() },
            ] as never);
          });
        },
      },
    });
    box.harness = harness;

    const out = await executeModelAttempt(harness.ctx, runId, stepRunId);

    const [attempt] = harness.db.repos.attempts.listForRun(runId);
    expect(out).toEqual({ kind: 'blocked', why: 'conflict' });
    expect(attempt?.state).toBe('unknown');
    expect(ledgerOf(harness.db.repos, runId).filter((e) => e.attemptId === attempt?.id).map((e) => e.type)).toEqual(['reserve', 'move_to_unknown', 'move_to_unknown']);
    expect(harness.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: attempt?.reservationMicrousd, C: 0 }));
    expect(harness.logger.entries.some((e) => e.event === 'attempt.settle_skipped')).toBe(true);
  });

  it('stop() + restart while a call is in flight: the new owner recovers it, the old loop never settles (balances consistent)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await createHarness({
      providers: wrapGenerate(async (base, req, gctx) => {
        await gate;
        return base.get(req.providerId).generate(req, gctx);
      }),
    });
    h = harness;
    const runId = await harness.startRun();
    await harness.engine.start();
    await harness.waitFor(() => harness.db.repos.attempts.listForRun(runId).some((a) => a.state === 'dispatching'));

    const stopping = harness.engine.stop({ graceMs: 0 });
    harness.timers.advance(1);
    await stopping;
    const b = createEngineFromContext(createEngineContext({ ...harness.ctx }));
    await b.start(); // lease → recovery: dispatching → unknown (move_to_unknown N), running → interrupted
    release(); // the old loop's provider call now returns a normal success
    await harness.waitFor(() => harness.logger.entries.some((e) => e.event === 'attempt.settle_skipped'));

    const [attempt] = harness.db.repos.attempts.listForRun(runId);
    expect(attempt?.state).toBe('unknown');
    const entries = ledgerOf(harness.db.repos, runId).filter((e) => e.attemptId === attempt?.id);
    expect(entries.map((e) => e.type)).toEqual(['reserve', 'move_to_unknown', 'move_to_unknown']); // settled exactly once
    const bal = harness.db.repos.ledger.runBalances(runId);
    expect(bal.R).toBe(0);
    expect(bal.U).toBe(attempt?.reservationMicrousd);
    expect(harness.db.repos.runs.get(runId).status).toBe('interrupted');
    const stoppingB = b.stop({ graceMs: 0 });
    harness.timers.advance(1);
    await stoppingB;
  });
});

describe('B4: PROJECT_CHANGED before implement invalidates the approval', () => {
  async function approvedAndRunning(): Promise<{ harness: Harness; runId: RunId; approvalId: string }> {
    const harness = await createHarness();
    h = harness;
    const runId = await harness.startRun();
    for (let i = 0; i < 20 && harness.db.repos.runs.get(runId).status !== 'awaiting_approval'; i += 1) await tick(harness.ctx);
    const pending = harness.db.repos.approvals.pendingForRun(runId);
    if (pending === undefined) throw new Error('no approval');
    const decided = await decideApproval(harness.ctx, { idempotencyKey: 'b4-decide-000001', approvalId: pending.id, planHash: pending.planHash,
      contextHash: pending.contextHash, decision: 'approved' });
    if (!decided.ok) throw new Error(decided.error.code);
    await tick(harness.ctx); // queued → running (B2)
    expect(harness.db.repos.runs.get(runId).status).toBe('running');
    return { harness, runId, approvalId: pending.id };
  }

  it('the stale check at implement pauses the run AND invalidates the approval (project_changed); a new approval is required', async () => {
    const { harness, runId, approvalId } = await approvedAndRunning();
    await writeFile(join(harness.projectRoot, 'src', 'handlers', 'user.ts'), 'changed on disk\n');

    for (let i = 0; i < 5 && harness.db.repos.runs.get(runId).status === 'running'; i += 1) await tick(harness.ctx);

    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'approval_stale' }));
    expect(harness.db.repos.approvals.get(approvalId as never)?.invalidatedReason).toBe('project_changed');
    expect(harness.db.repos.approvals.latestApprovedForRun(runId)).toBeUndefined();
    expect(harness.db.repos.attempts.listForRun(runId).filter((a) => a.stepRunId === harness.db.repos.steps.latestFor(runId, 'implement' as StepKey)?.id)).toEqual([]);
    expect(harness.db.repos.events.list(runId, 0, 1000).some((e) => e.type === 'error.recorded' && e.payload['approvalId'] === approvalId)).toBe(true);

    // Resuming WITHOUT use_preserved_snapshot never dispatches implement on the invalidated approval.
    harness.db.tx('immediate', (r) => applyRunEvent(r, r.runs.get(runId), { type: 'RESUME_RESOLVED' }, harness.clock.now(), []));
    for (let i = 0; i < 5 && harness.db.repos.runs.get(runId).status !== 'paused'; i += 1) await tick(harness.ctx);
    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'approval_stale' }));
    const implement = harness.db.repos.steps.latestFor(runId, 'implement' as StepKey);
    expect(harness.db.repos.attempts.listForRun(runId).filter((a) => a.stepRunId === implement?.id)).toEqual([]);
  });

  it('use_preserved_snapshot (recorded after the invalidation) keeps the approval valid for the preserved inputs', async () => {
    const { harness, runId } = await approvedAndRunning();
    await writeFile(join(harness.projectRoot, 'src', 'handlers', 'user.ts'), 'changed on disk\n');
    for (let i = 0; i < 5 && harness.db.repos.runs.get(runId).status === 'running'; i += 1) await tick(harness.ctx);
    expect(harness.db.repos.runs.get(runId).pauseReason).toBe('approval_stale');

    harness.db.tx('immediate', (r) => {
      r.events.append(runId, 'run.snapshot_preserved', {});
      applyRunEvent(r, r.runs.get(runId), { type: 'RESUME_RESOLVED' }, harness.clock.now(), []);
    });
    for (let i = 0; i < 5; i += 1) await tick(harness.ctx);

    const implement = harness.db.repos.steps.listForRun(runId).filter((s) => s.stepKey === 'implement');
    const attempts = harness.db.repos.attempts.listForRun(runId).filter((a) => implement.some((s) => s.id === a.stepRunId));
    expect(attempts.length).toBeGreaterThan(0);
  });
});

describe('B5: fallback iterations are priced per model at settlement', () => {
  const fallbackResult = (served: string) =>
    wrapGenerate(async (base, req, gctx) => {
      const res = await base.get(req.providerId).generate(req, gctx);
      if (res.kind !== 'success') return res;
      const second = { uncachedInputTokens: 2_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1_000 };
      const withFallback: ModelSuccess = {
        ...res,
        usage: {
          uncachedInputTokens: res.usage.uncachedInputTokens + second.uncachedInputTokens,
          cacheReadInputTokens: res.usage.cacheReadInputTokens,
          cacheWriteInputTokens: res.usage.cacheWriteInputTokens,
          outputTokens: res.usage.outputTokens + second.outputTokens,
        },
        fallback: { servedByModel: served, iterations: [{ modelId: req.modelId, usage: res.usage }, { modelId: served, usage: second }] },
      };
      return withFallback;
    });

  it('a known fallback model is priced with its own catalog price (calculated)', async () => {
    const { harness, runId, stepRunId } = await readyReview({ providers: fallbackResult('claude-opus-5-5') });

    await executeModelAttempt(harness.ctx, runId, stepRunId);

    const [attempt] = harness.db.repos.attempts.listForRun(runId);
    const settle = ledgerOf(harness.db.repos, runId).find((e) => e.attemptId === attempt?.id && e.type === 'settle');
    const opus = harness.db.repos.catalog.get('anthropic', 'claude-opus-5-5')?.prices as ModelPrices;
    const own = attempt?.profileSnapshot.prices as ModelPrices;
    const u = attempt?.usage;
    if (u === null || u === undefined) throw new Error('no usage');
    const second = { uncachedInputTokens: 2_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1_000 };
    const first = { ...u, uncachedInputTokens: u.uncachedInputTokens - 2_000, outputTokens: u.outputTokens - 1_000 };
    expect(settle?.certainty).toBe('calculated');
    expect(settle?.deltaMicrousd).toBe(computeCost(first, own).microusd + computeCost(second, opus).microusd);
    expect(settle?.deltaMicrousd).not.toBe(computeCost(u, own).microusd); // pre-fix: everything at the profile price
  });

  it('an unknown fallback model is priced at the provider maximum and settles as estimated', async () => {
    const { harness, runId, stepRunId } = await readyReview({ providers: fallbackResult('claude-future-9') });

    await executeModelAttempt(harness.ctx, runId, stepRunId);

    const [attempt] = harness.db.repos.attempts.listForRun(runId);
    const settle = ledgerOf(harness.db.repos, runId).find((e) => e.attemptId === attempt?.id && e.type === 'settle');
    const max = maxPrices(harness.db.repos.catalog.list('anthropic').map((e) => e.prices)) as ModelPrices;
    const second = { uncachedInputTokens: 2_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1_000 };
    const u = attempt?.usage;
    if (u === null || u === undefined) throw new Error('no usage');
    const first = { ...u, uncachedInputTokens: u.uncachedInputTokens - 2_000, outputTokens: u.outputTokens - 1_000 };
    expect(settle?.certainty).toBe('estimated');
    expect(settle?.deltaMicrousd).toBe(computeCost(first, attempt?.profileSnapshot.prices as ModelPrices).microusd + computeCost(second, max).microusd);
  });
});

describe('B6: logged errors never carry the API key', () => {
  it.each([
    ['a key-shaped secret', 'sk-ant-api03-SECRETSECRETSECRETSECRET1234'],
    ['an opaque key of any shape', 'opaque-credential-value-7788'],
  ])('adapter throwing a message containing %s', async (_label, key) => {
    const { harness, runId, stepRunId } = await readyReview({
      credentials: { resolve: () => Promise.resolve(ok(key)) },
      providers: wrapGenerate(() => Promise.reject(new Error(`401 Unauthorized: invalid x-api-key ${key}`))),
    });

    await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(harness.logger.entries.some((e) => e.event === 'adapter.threw')).toBe(true);
    expect(JSON.stringify(harness.logger.entries)).not.toContain(key);
  });

  it('the loop handler and any logged field pass through redaction', async () => {
    const key = 'sk-ant-api03-LOOPLOOPLOOPLOOPLOOPLOOP9999';
    const { harness, runId } = await readyReview({
      context: (base) => ({ assemble: () => Promise.reject(new Error(`boom with ${key}`)).then(() => base.assemble(undefined as never)) }),
    });

    await tick(harness.ctx);
    harness.ctx.logger.warn('custom', { nested: { header: `Authorization: Bearer ${key}` } });

    expect(harness.logger.entries.some((e) => e.event === 'loop.handler_threw')).toBe(true);
    expect(JSON.stringify(harness.logger.entries)).not.toContain(key);
    expect(harness.db.repos.runs.get(runId).status).toBe('failed');
  });
});

describe('B7: preflight N equals the first attempt reservation', () => {
  it('uses the dispatch request construction (system prompt, goal, constraints, schema, overhead) and adapter.estimate', async () => {
    const harness = await createHarness();
    h = harness;
    const workflow = harness.db.repos.workflows.listWorkflows()[0];
    if (workflow === undefined) throw new Error('no workflow');
    const goal = 'Fix the defects in the handlers.';
    const relPaths = ['src/lib/format.ts', 'src/handlers/user.ts', 'src/handlers/orders.ts']; // not in rel_path order

    const pre = await harness.engine.handle('relay/v1/runs.preflight', {
      projectId: harness.projectId, workflowId: workflow.id, workflowVersion: 1, goal, input: { kind: 'files', relPaths },
    });
    const runId = await harness.startRun({ relPaths, goal });
    for (let i = 0; i < 10 && harness.db.repos.attempts.listForRun(runId).length === 0; i += 1) await tick(harness.ctx);

    const [attempt] = harness.db.repos.attempts.listForRun(runId);
    expect(pre.ok).toBe(true);
    if (!pre.ok || attempt === undefined) throw new Error('no preflight / attempt');
    expect(pre.data.firstReservation.N).toBe(attempt.reservationMicrousd);
    expect(pre.data.inputSummary.estimatedInputTokens).toBe((attempt.estimate as { inputTokens?: number } | null)?.inputTokens);
    expect(pre.data.firstReservation.basis).toBe('local_estimate');
    expect(pre.data.inputSummary.files).toBe(3);
  });
});

describe('B9: runs.pause wakes the loop, and wait_until sleeps are interruptible', () => {
  it('a pause during a backoff sleep takes effect without waiting out the timer', async () => {
    const { harness, runId, stepRunId } = await readyReview();
    const far = harness.clock.now() + 3_600_000;
    harness.db.tx('immediate', (r) => r.steps.transition(stepRunId, ['ready'], 'ready', { notBeforeAt: far as never }));
    await drainWake(harness);
    const sleeping = tick(harness.ctx); // → wait_until (1 h on the manual timers, which never advance here)
    await sleep(20);
    expect(await settledWithin(sleeping, 1)).toBe('timeout');

    const res = await harness.engine.handle('relay/v1/runs.pause', { runId });

    expect(res.ok).toBe(true);
    expect(await settledWithin(sleeping, 500)).toBe('resolved');
    await tick(harness.ctx);
    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'user' }));
    expect(harness.clock.now()).toBeLessThan(far);
  });

  it('any wake signal ends a wait_until sleep early', async () => {
    const { harness, stepRunId } = await readyReview();
    harness.db.tx('immediate', (r) => r.steps.transition(stepRunId, ['ready'], 'ready', { notBeforeAt: (harness.clock.now() + 60_000) as never }));
    await drainWake(harness);
    const sleeping = tick(harness.ctx);
    await sleep(20);
    expect(await settledWithin(sleeping, 1)).toBe('timeout');

    harness.ctx.wake.signal();

    expect(await settledWithin(sleeping, 500)).toBe('resolved');
  });
});
