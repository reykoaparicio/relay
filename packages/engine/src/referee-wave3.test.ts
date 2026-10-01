// Regression tests for the Referee wave-3 rulings on the money / ledger / state-machine audit. Each fails on the
// pre-fix code: (1) a reconciled overrun deferred while the run was not `running` is durable and no resume path can
// bypass it, decide_unknown works from any pause, and decisions are gated by allowedRunActions; (2) a failed step at
// maxAttempts can be retried (the reserve checkpoint pauses limit_attempts); (3) runs.list agrees with runs.get on
// the overrun flag; (4) no write after a lost lease, recovery CAS before ledger, no hot spin on a conflict.
import { afterEach, describe, expect, it } from 'vitest';
import { err, errors, microusd } from '@relay/contracts';
import type { AttemptId, RunId, StepKey, StepRunId } from '@relay/contracts';
import { FAKE_FIXTURES } from '@relay/providers';
import type { ModelRequest, ModelResult, ProviderRegistry, ReconciliationResult } from '@relay/providers';
import type { AttemptRow, Repos } from '@relay/storage';
import { executeModelAttempt } from './checkpoints.js';
import { deferPause } from './outcome.js';
import { reconcileUnknownAttempts, recoverAttempt } from './recovery.js';
import { overrunError } from './retry.js';
import { applyRunEvent } from './run-machine.js';
import type { RunMachineEvent } from './run-machine.js';
import { stepsToPromote, tick } from './runner.js';
import { snapshotOf } from './snapshot.js';
import { applyStepEvent } from './step-machine.js';
import { drive, driveThroughApproval } from './testing/drive.js';
import { SAMPLE_FILES, createHarness, sleep } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const REVIEW = 'review' as StepKey;

async function open(o: HarnessOptions = {}): Promise<Harness> {
  const x = await createHarness(o);
  h = x;
  return x;
}

function ledgerOf(r: Repos, runId: RunId) {
  const page = r.ledger.list(runId, { limit: 500, sort: 'created_asc' });
  if (!page.ok) throw new Error('ledger');
  return page.value.items;
}

const pauses = (x: Harness, runId: RunId): string[] =>
  x.db.repos.events.list(runId, 0, 100_000).filter((e) => e.type === 'run.status_changed').map((e) => `${String(e.payload['to'])}/${String(e.payload['pauseReason'])}`);

async function actionsOf(x: Harness, runId: RunId): Promise<readonly string[]> {
  const d = await x.engine.handle('relay/v1/runs.get', { runId });
  if (!d.ok) throw new Error(d.error.code);
  return d.data.availableActions;
}

const usage = (outputTokens: number) => ({ uncachedInputTokens: 100, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens });

/**
 * The audited scenario: the deadline fires while the review call is in flight (abort `{ kind: 'deadline' }`), the
 * attempt ends `unknown` with a provider response id, and the run pauses `deadline`. Reconcile later finds the call
 * completed with usage far above the liability (X > N).
 */
async function deadlineUnknown(): Promise<{ x: Harness; runId: RunId; attemptId: AttemptId }> {
  const box: { x?: Harness; runId?: RunId; seen: number } = { seen: 0 };
  const overrun = (): Promise<ReconciliationResult> =>
    Promise.resolve({ kind: 'completed', json: structuredClone(FAKE_FIXTURES['findings.v1']), usage: usage(900_000), rawUsage: null });
  const providers = (base: ProviderRegistry): ProviderRegistry => ({
    list: () => base.list(),
    get: (id) => ({
      ...base.get(id),
      reconcile: overrun,
      generate: async (req: ModelRequest, gctx): Promise<ModelResult> => {
        const res = await base.get(req.providerId).generate(req, gctx);
        if (req.metadata.stepKey !== 'review') return res;
        box.seen += 1;
        if (box.seen !== 1 || box.x === undefined || box.runId === undefined) return res;
        box.x.ctx.cancellation.abortRun(box.runId, { kind: 'deadline' }); // the deadline timer fired mid-call
        return { kind: 'error', error: errors.providerUnavailable(req.providerId), phase: 'sent_no_response' };
      },
    }),
  });
  const x = await open({ scenario: { name: 'lookup', capabilityOverrides: { supportsRequestLookup: true }, steps: [] }, providers });
  box.x = x;
  const runId = await x.startRun({ budgetMicrousd: 50_000_000 });
  box.runId = runId;
  expect(await drive(x, runId, ['paused'])).toBe('paused');
  const run = x.db.repos.runs.get(runId);
  expect(run.pauseReason).toBe('deadline');
  const [a] = x.db.repos.attempts.listForRun(runId);
  expect(a?.state).toBe('unknown');
  return { x, runId, attemptId: a!.id };
}

const raiseDeadline = (x: Harness, runId: RunId, key: string) =>
  x.engine.handle('relay/v1/runs.resume', { idempotencyKey: key, runId,
    decision: { kind: 'raise_limits', executionTimeoutSeconds: x.db.repos.runs.get(runId).limits.executionTimeoutSeconds + 600 } });

describe('finding 1: a deferred reconciled overrun is durable and never bypassed', () => {
  it('paused(deadline) + reconciled overrun → raise_limits pauses budget_overrun (not queued) → acknowledge_overrun → completes', async () => {
    const { x, runId } = await deadlineUnknown();
    await reconcileUnknownAttempts(x.ctx, new AbortController().signal);

    const afterReconcile = x.db.repos.runs.get(runId);
    expect([afterReconcile.status, afterReconcile.pauseReason]).toEqual(['paused', 'deadline']);
    expect(afterReconcile.deferredPause?.reason).toBe('budget_overrun');

    const raised = await raiseDeadline(x, runId, 'raise-limits-00001');
    expect(raised.ok && raised.data.status).toBe('paused');
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('budget_overrun');
    expect(await actionsOf(x, runId)).toEqual(['acknowledge_overrun', 'increase_allowance', 'stop']);

    const ack = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'ack-overrun-00001', runId, decision: { kind: 'acknowledge_overrun' } });
    expect(ack.ok && ack.data.status).toBe('queued');
    expect(x.db.repos.runs.get(runId).deferredPause).toBeNull();
    expect(await driveThroughApproval(x, runId, ['completed', 'paused', 'failed', 'incomplete'])).toBe('completed');
    expect(pauses(x, runId)).toContain('paused/budget_overrun');
  });

  it('a restart while queued: the overrun deferred on a queued run replaces CHECKS_PASSED; increase_allowance resolves it', async () => {
    const { x, runId } = await deadlineUnknown();
    const raised = await raiseDeadline(x, runId, 'raise-limits-00002'); // queued, the unknown attempt still open
    expect(raised.ok && raised.data.status).toBe('queued');

    await reconcileUnknownAttempts(x.ctx, new AbortController().signal); // reconciled while queued
    expect(x.db.repos.runs.get(runId).deferredPause?.reason).toBe('budget_overrun');
    await tick(x.ctx); // the loop's CHECKS_PASSED

    const run = x.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason]).toEqual(['paused', 'budget_overrun']);
    expect(pauses(x, runId).slice(-2)).toEqual(['queued/null', 'paused/budget_overrun']); // never ran past it
    const L = x.db.repos.ledger.runBalances(runId).L;
    const inc = await x.engine.handle('relay/v1/runs.increaseAllowance', { idempotencyKey: 'increase-allow-001', runId, newAllowanceMicrousd: microusd(L + 10_000_000) });
    expect(inc.ok && inc.data.status).toBe('queued');
    expect(x.db.repos.runs.get(runId).deferredPause).toBeNull();
    expect(await driveThroughApproval(x, runId, ['completed', 'paused', 'failed', 'incomplete'])).toBe('completed');
  });

  it('(a) decide_unknown is offered and works from paused(deadline); the run keeps its deadline pause', async () => {
    const { x, runId, attemptId } = await deadlineUnknown();
    expect(await actionsOf(x, runId)).toEqual(['raise_limits', 'decide_unknown', 'stop']);

    const decided = await x.engine.handle('relay/v1/runs.decideUnknown', { idempotencyKey: 'decide-deadline-01', runId, attemptId, decision: 'retry_acknowledging_charge' });

    expect(decided.ok).toBe(true);
    expect(x.db.repos.attempts.get(attemptId).state).toBe('abandoned');
    const run = x.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason]).toEqual(['paused', 'deadline']);
    expect(await actionsOf(x, runId)).toEqual(['raise_limits', 'stop']);
    expect((await raiseDeadline(x, runId, 'raise-limits-00003')).ok).toBe(true);
    expect(await driveThroughApproval(x, runId, ['completed', 'paused', 'failed', 'incomplete'])).toBe('completed');
  });

  it('(b) switch_profile on paused(unknown_outcome) with an open unknown attempt is refused (decision_not_applicable)', async () => {
    const x = await open({ scenario: 'midstream-error' });
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('unknown_outcome');
    expect(await actionsOf(x, runId)).toEqual(['decide_unknown', 'stop']);
    const economy = x.db.repos.profiles.getByName('Economy');

    const res = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'switch-unknown-001', runId,
      decision: { kind: 'switch_profile', stepKey: 'plan', profileId: economy?.id ?? '' } } as never);

    expect(res.ok ? null : [res.error.code, res.error.details?.['reason']]).toEqual(['CONFLICT', 'decision_not_applicable']);
    expect(x.db.repos.runs.get(runId).status).toBe('paused');
    expect(x.db.repos.configRevisions.list(runId)).toEqual([]);
  });
});

describe('finding 1: applyRunEvent applies a durable deferred pause instead of every continuing event', () => {
  const overrun = (attemptId = 'att_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as AttemptId) =>
    ({ type: 'BUDGET_OVERRUN', attemptId, error: overrunError(attemptId, microusd(10), microusd(20)) }) as const;
  const apply = (x: Harness, runId: RunId, ev: RunMachineEvent) =>
    x.db.tx('immediate', (r) => applyRunEvent(r, r.runs.get(runId), ev, x.clock.now(), []));
  const defer = (x: Harness, runId: RunId, ev: Parameters<typeof deferPause>[3]) => { x.db.tx('immediate', (r) => { deferPause(r, [], runId, ev); }); };
  const state = (x: Harness, runId: RunId) => {
    const run = x.db.repos.runs.get(runId);
    return [run.status, run.pauseReason, run.deferredPause?.reason ?? null];
  };

  it('CHECKS_PASSED, RESUME_RESOLVED (any other pause) and RECOVERY_DECIDED all pause budget_overrun; resolving that pause clears it', async () => {
    const x = await open();
    const runId = await x.startRun();
    defer(x, runId, overrun());
    apply(x, runId, { type: 'CHECKS_PASSED' });
    expect(state(x, runId)).toEqual(['paused', 'budget_overrun', 'budget_overrun']);
    apply(x, runId, { type: 'RESUME_RESOLVED' }); // the user acknowledged THIS pause
    expect(state(x, runId)).toEqual(['queued', null, null]);

    apply(x, runId, { type: 'CHECKS_PASSED' });
    apply(x, runId, { type: 'USER_PAUSE' });
    defer(x, runId, overrun());
    apply(x, runId, { type: 'RESUME_RESOLVED' });
    expect(state(x, runId)).toEqual(['paused', 'budget_overrun', 'budget_overrun']);

    apply(x, runId, { type: 'RESUME_RESOLVED' });
    apply(x, runId, { type: 'CHECKS_PASSED' });
    apply(x, runId, { type: 'RUNNER_LOST' });
    defer(x, runId, overrun());
    apply(x, runId, { type: 'RECOVERY_DECIDED' });
    expect(state(x, runId)).toEqual(['paused', 'budget_overrun', 'budget_overrun']);
  });

  it('an overrun wins over a deferred scope change and is never replaced by one', async () => {
    const x = await open();
    const runId = await x.startRun();
    const stale = { type: 'APPROVAL_STALE', error: errors.approvalStale('scope_changed') } as const;
    defer(x, runId, stale);
    expect(state(x, runId)).toEqual(['queued', null, 'approval_stale']);
    defer(x, runId, overrun());
    defer(x, runId, stale);
    expect(state(x, runId)).toEqual(['queued', null, 'budget_overrun']);
  });
});

describe('finding 2: a failed step at attemptCount == maxAttempts', () => {
  async function exhausted(): Promise<{ x: Harness; runId: RunId; stepId: StepRunId }> {
    const x = await open({ scenario: 'malformed-twice' });
    const wf = x.db.repos.workflows.listWorkflows()[0]!;
    const started = await x.engine.handle('relay/v1/runs.start', { idempotencyKey: 'dead-end-run-0001', projectId: x.projectId, workflowId: wf.id,
      workflowVersion: 1, goal: 'Fix the defects in the handlers.', input: { kind: 'files', relPaths: Object.keys(SAMPLE_FILES) },
      limitOverrides: { maxAttempts: 2 } } as never);
    if (!started.ok) throw new Error(started.error.code);
    const runId = started.data.runId;
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const run = x.db.repos.runs.get(runId);
    expect([run.pauseReason, run.attemptCount, run.limits.maxAttempts]).toEqual(['output_invalid', 2, 2]);
    return { x, runId, stepId: x.db.repos.steps.latestFor(runId, REVIEW)!.id };
  }

  it('retry_step → paused(limit_attempts) → raise_limits → completes', async () => {
    const { x, runId, stepId } = await exhausted();
    const retry = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'dead-end-retry-001', runId, stepId });
    expect(retry.ok).toBe(true);
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('limit_attempts');
    const raised = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'dead-end-raise-001', runId, decision: { kind: 'raise_limits', maxAttempts: 10 } });
    expect(raised.ok).toBe(true);
    const end = await driveThroughApproval(x, runId, ['completed', 'paused', 'failed', 'incomplete']);
    expect([end, x.db.repos.runs.get(runId).pauseReason, x.db.repos.runs.get(runId).statusDetail]).toEqual(['completed', null, null]);
  });

  it('choose_profile (retryStep { profileId }) → paused(limit_attempts) → raise_limits → completes on the new profile', async () => {
    const { x, runId, stepId } = await exhausted();
    const economy = x.db.repos.profiles.getByName('Economy');
    const chose = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'dead-end-choose-01', runId, stepId, profileId: economy?.id ?? '' });
    expect(chose.ok).toBe(true);
    expect(x.db.repos.configRevisions.list(runId)).toHaveLength(1);
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('limit_attempts');
    expect((await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'dead-end-raise-002', runId, decision: { kind: 'raise_limits', maxAttempts: 10 } })).ok).toBe(true);
    expect(await driveThroughApproval(x, runId, ['completed', 'paused', 'failed', 'incomplete'])).toBe('completed');
    expect(x.db.repos.steps.latestFor(runId, REVIEW)?.profileName).toBe('Economy');
  });
});

describe('finding 3: runs.list and runs.get agree on cost.overrun', () => {
  it('after an attempt overran within the allowance', async () => {
    const x = await open({ scenario: { name: 'overrun', steps: [{ match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'overrun', outputTokens: 100_000 } }] } });
    const runId = await x.startRun({ budgetMicrousd: 50_000_000 });
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('budget_overrun');

    const list = await x.engine.handle('relay/v1/runs.list', { projectId: x.projectId, limit: 10 });
    const get = await x.engine.handle('relay/v1/runs.get', { runId });

    if (!list.ok || !get.ok) throw new Error('ipc');
    const row = (list.data as { items: { id: string; cost: { overrun: boolean; remaining: number } }[] }).items.find((i) => i.id === runId);
    expect(get.data.cost.remaining).toBeGreaterThan(0); // within the allowance: only the per-attempt rule flags it
    expect(get.data.cost.overrun).toBe(true);
    expect(row?.cost).toEqual(get.data.cost);
    expect(x.db.repos.ledger.attemptsOverran(runId)).toBe(true);
  });
});

describe('finding 4: writes after awaits', () => {
  async function readyReview(o: HarnessOptions = {}): Promise<{ x: Harness; runId: RunId; stepRunId: StepRunId }> {
    const x = await open(o);
    const runId = await x.startRun();
    await tick(x.ctx); // runChecks → running
    await tick(x.ctx); // intake
    x.db.tx('immediate', (r) => {
      for (const s of stepsToPromote(r.steps.latestPerStepKey(runId), snapshotOf(r.runs.get(runId)))) applyStepEvent(r, [], s, 'DEPS_MET');
    });
    const step = x.db.repos.steps.latestFor(runId, REVIEW);
    if (step?.state !== 'ready') throw new Error('review not ready');
    return { x, runId, stepRunId: step.id };
  }

  it('(a) reserve after a lost lease writes nothing — not the attempt, the ledger, nor a pause it would have taken', async () => {
    const box: { x?: Harness; runId?: RunId } = {};
    const { x, runId, stepRunId } = await readyReview({
      hooks: {
        beforeReservationTx: () => {
          if (box.x === undefined || box.runId === undefined) return;
          const owner = box.x;
          owner.db.tx('immediate', (r) => { r.runs.setPauseRequested(box.runId as RunId, true); }); // reserve would pause
          owner.ctx.lease.owned = false; // stop() / a takeover during prepare's awaits
        },
      },
    });
    box.x = x;
    box.runId = runId;
    const ledgerBefore = ledgerOf(x.db.repos, runId).length;
    const seqBefore = x.db.repos.events.lastSeq(runId);

    const out = await executeModelAttempt(x.ctx, runId, stepRunId);

    expect(out).toEqual({ kind: 'blocked', why: 'lease_lost' });
    expect(x.db.repos.attempts.listForRun(runId)).toEqual([]);
    expect(ledgerOf(x.db.repos, runId)).toHaveLength(ledgerBefore);
    expect(x.db.repos.events.lastSeq(runId)).toBe(seqBefore);
    expect(x.db.repos.runs.get(runId).status).toBe('running');
    expect(x.db.repos.steps.get(stepRunId).state).toBe('ready');
  });

  it('(a) reserve after a stale takeover writes nothing even before the heartbeat flips the in-memory flag', async () => {
    const box: { x?: Harness } = {};
    const { x, runId, stepRunId } = await readyReview({
      hooks: {
        beforeReservationTx: () => {
          if (box.x === undefined) return;
          const owner = box.x;
          owner.ctx.lease.ownerId = 'runner_stalled';
          owner.db.repos.lease.acquire('runner_new', 2, owner.ctx.clock.now(), 0); // another process took the stale lease
        },
      },
    });
    box.x = x;
    const ledgerBefore = ledgerOf(x.db.repos, runId).length;

    expect(x.ctx.lease.owned).toBe(true);
    const out = await executeModelAttempt(x.ctx, runId, stepRunId);

    expect(out).toEqual({ kind: 'blocked', why: 'lease_lost' });
    expect(x.ctx.lease.owned).toBe(false);
    expect(x.db.repos.attempts.listForRun(runId)).toEqual([]);
    expect(ledgerOf(x.db.repos, runId)).toHaveLength(ledgerBefore);
  });

  it('(a) pauseRun after a lost lease writes nothing', async () => {
    const box: { x?: Harness; armed: boolean } = { armed: false };
    const { x, runId, stepRunId } = await readyReview({
      context: (base) => ({
        assemble: async (i) => {
          if (!box.armed || box.x === undefined) return base.assemble(i);
          box.x.ctx.lease.owned = false;
          return err(errors.contextTooLarge({ estimatedInputTokens: 10, budgetTokens: 1 }));
        },
      }),
    });
    box.x = x;
    box.armed = true;
    const seqBefore = x.db.repos.events.lastSeq(runId);

    const out = await executeModelAttempt(x.ctx, runId, stepRunId);

    expect(out).toEqual({ kind: 'blocked', why: 'lease_lost' });
    expect(x.db.repos.runs.get(runId).status).toBe('running');
    expect(x.db.repos.events.lastSeq(runId)).toBe(seqBefore);
  });

  it('(b) recoverAttempt with a stale row (the attempt moved meanwhile) loses the CAS and appends no ledger entry', async () => {
    const box: { x?: Harness; stale?: AttemptRow } = {};
    const { x, runId, stepRunId } = await readyReview({
      hooks: {
        afterDispatchIntent: (c) => {
          if (box.x !== undefined && c.attemptId !== undefined) box.stale = box.x.db.repos.attempts.get(c.attemptId);
        },
      },
    });
    box.x = x;
    await executeModelAttempt(x.ctx, runId, stepRunId);
    const stale = box.stale!;
    expect(stale.state).toBe('dispatching');
    expect(x.db.repos.attempts.get(stale.id).state).toBe('succeeded');
    const before = ledgerOf(x.db.repos, runId);
    const balances = x.db.repos.ledger.runBalances(runId);

    for (const row of [stale, { ...stale, state: 'reserved' as const }]) {
      x.db.tx('immediate', (r) => { recoverAttempt(r, [], row, x.clock.now()); });
    }

    expect(ledgerOf(x.db.repos, runId)).toEqual(before);
    expect(x.db.repos.ledger.runBalances(runId)).toEqual(balances);
    expect(x.db.repos.attempts.get(stale.id).state).toBe('succeeded');
  });

  it('(c) a CONFLICT from the dispatch status check backs off instead of spinning hot (bounded ticks)', async () => {
    const box = { assembles: 0 };
    const { x, runId, stepRunId } = await readyReview({
      context: (base) => ({
        assemble: (i) => {
          box.assembles += 1;
          return base.assemble(i);
        },
      }),
    });
    // A `reserved` step with no attempt of this process: selectNextStep offers it, F6 #1 refuses it (CONFLICT).
    x.db.tx('immediate', (r) => r.steps.transition(stepRunId, ['ready'], 'reserved', {}));
    const d = x.ctx.wake.wait(0); // drain a wake-up left pending by earlier commits
    x.timers.advance(0);
    await d;
    let done = false;

    const p = tick(x.ctx).then(() => {
      done = true;
    });
    for (let i = 0; i < 20 && box.assembles === 0; i += 1) await sleep(5);
    await sleep(20);

    expect(box.assembles).toBe(1);
    expect(done).toBe(false); // waiting (idle backoff), not returning for an immediate re-prepare
    x.timers.advance(60_000);
    await p;
    expect(box.assembles).toBe(1);
    expect(x.db.repos.runs.get(runId).status).toBe('running');
  });
});
