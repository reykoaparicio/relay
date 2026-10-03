// 11 §K4 crash matrix (@crash @m3, FR-07, §7.5, §17.1 rows 5–6). Every crash is a REAL separate Node process
// (runner-child.ts forked with the tsx loader) dying with exit 137 at a F13 hook, then a fresh child is forked
// IMMEDIATELY on the same userData dir (fresh heartbeat, dead owner pid → lease acquired, 03 §R4-10) and recovery runs.
// Recovery always moves every dispatching attempt → unknown, settled at once as an estimate (decision 1); only row 4
// reconciles (and corrects the estimate).
import { afterEach, describe, expect, it } from 'vitest';
import type { RunId } from '@relay/contracts';
import { expectBalances } from '../helpers/assert-ledger.js';
import { expectExit, runChild } from '../helpers/crash-harness.js';
import type { ChildResult } from '../helpers/crash-harness.js';
import { DEFAULT_REL_PATHS, createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { expectStorageInvariants } from '../helpers/invariants.js';
import { cleanupTempDirs, copyFixture, makeTempDir } from '../helpers/temp-dirs.js';
import { attemptEntries, expectedEstimate } from './uncertain-estimate.js';

const CRASH_EXIT = 137;
const GOAL = 'Fix the defects in the handlers.';

afterEach(async () => {
  await cleanupTempDirs();
});

interface Env {
  readonly userDataDir: string;
  readonly projectRoot: string;
}

async function env(): Promise<Env> {
  return { userDataDir: await makeTempDir('relay-crash-ud-'), projectRoot: await copyFixture('sample-api') };
}

const startAction = (e: Env) => ({ kind: 'start' as const, projectRoot: e.projectRoot, relPaths: DEFAULT_REL_PATHS, goal: GOAL });

function runIdOf(r: ChildResult): RunId {
  if (r.runId === undefined) throw new Error(`child reported no run id: ${JSON.stringify(r.messages)}`);
  return r.runId;
}

/** Opens the userData dir in-process WITHOUT starting the engine (no lease, no recovery) for assertions. */
async function inspect<T>(e: Env, scenario: string, fn: (h: Harness) => Promise<T> | T): Promise<T> {
  const h = await createHarness({ userDataDir: e.userDataDir, projectRoot: e.projectRoot, scenario, start: false });
  try {
    return await fn(h);
  } finally {
    await h.dispose();
  }
}

const ledgerTypes = (h: Harness, runId: RunId): string[] => {
  const page = h.db.repos.ledger.list(runId, { limit: 500, sort: 'created_asc' });
  return page.ok ? page.value.items.map((x) => x.type) : [];
};

describe('crash matrix @crash @m3', () => {
  it('#1 beforeReservationTx@review: no attempt, no reserve; interrupted; resume(continue) runs review once @crash @m3', async () => {
    const e = await env();
    const crashed = await runChild({ userDataDir: e.userDataDir, action: startAction(e), until: ['awaiting_approval'] }, { crashAt: 'beforeReservationTx@review' });
    expectExit(crashed, CRASH_EXIT);
    const runId = runIdOf(crashed);

    const recovered = await runChild({ userDataDir: e.userDataDir, action: { kind: 'recover' }, runId, until: ['interrupted'] });
    expectExit(recovered, 0);

    await inspect(e, 'happy-path', (h) => {
      expect(h.db.repos.runs.get(runId).status).toBe('interrupted');
      expect(h.db.repos.attempts.listForRun(runId)).toEqual([]);
      expect(ledgerTypes(h, runId).filter((t) => t !== 'allowance_set')).toEqual([]);
      expect(h.calls({ runId })).toHaveLength(0);
      return expectStorageInvariants(h.db, e.userDataDir);
    });

    const resumed = await runChild({ userDataDir: e.userDataDir, action: { kind: 'resume', decision: { kind: 'continue' } }, runId, until: ['awaiting_approval'] });
    expectExit(resumed, 0);
    await inspect(e, 'happy-path', (h) => {
      expect(h.calls({ runId, stepKey: 'review' })).toHaveLength(1);
      expect(h.attempts(runId, 'review').map((a) => a.state)).toEqual(['succeeded']);
      return expectStorageInvariants(h.db, e.userDataDir);
    });
  });

  it('#2 afterDispatchIntent@review: dispatching → unknown, settled at once as an estimate (decision 1: release N + settle E, U = 0, may not have been charged), 0 calls, no reconcile; review_recovery → paused(unknown_outcome) → retry_step @crash @m3', async () => {
    const e = await env();
    const crashed = await runChild({ userDataDir: e.userDataDir, action: startAction(e), until: ['awaiting_approval'] }, { crashAt: 'afterDispatchIntent@review' });
    expectExit(crashed, CRASH_EXIT);
    const runId = runIdOf(crashed);

    expectExit(await runChild({ userDataDir: e.userDataDir, action: { kind: 'recover' }, runId, until: ['interrupted'] }), 0);

    const attemptId = await inspect(e, 'happy-path', async (h) => {
      const [a, ...rest] = h.attempts(runId, 'review');
      expect(rest).toEqual([]);
      expect(a?.state).toBe('unknown'); // honest by construction: the bytes could have left
      const N = a!.reservationMicrousd;
      const E = expectedEstimate(a!, 0);
      expect(N).toBeGreaterThan(E);
      expect(E).toBeGreaterThan(0);
      expect([a!.outcomeUncertain, a!.mayNotHaveBeenCharged]).toEqual([true, true]); // no response byte ever arrived
      expect(h.db.repos.runs.get(runId).status).toBe('interrupted');
      expect(attemptEntries(h.db, runId, a!.id)).toEqual([['reserve', 'reserved', N, null], ['release', 'reserved', 0 - N, null], ['settle', 'settled', E, 'estimated']]);
      expectBalances(h.db, runId, { C: E, R: 0, U: 0 });
      expect(h.calls({ runId })).toHaveLength(0);
      expect(h.callLog.reconcileEntries()).toEqual([]); // supportsRequestLookup false → no reconcile
      await expectStorageInvariants(h.db, e.userDataDir);
      return a!.id;
    });

    // interrupted: review_recovery re-queues; the loop pauses unknown_outcome on the uncertain step (never re-dispatched).
    const reviewed = await runChild({ userDataDir: e.userDataDir, action: { kind: 'resume', decision: { kind: 'continue' } }, runId, until: ['paused'] });
    expectExit(reviewed, 0);
    expect(reviewed.messages.find((m) => m.type === 'status')).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'unknown_outcome' }));
    await inspect(e, 'happy-path', (h) => {
      expect(h.calls({ runId })).toHaveLength(0); // never a silent re-dispatch
    });
    const retried = await runChild({ userDataDir: e.userDataDir, action: { kind: 'retryStep', stepKey: 'review' }, runId, until: ['awaiting_approval'] });
    expectExit(retried, 0);
    expect(retried.messages.find((m) => m.type === 'acted')).toEqual(expect.objectContaining({ ok: true }));
    await inspect(e, 'happy-path', (h) => {
      const [old, fresh] = h.attempts(runId, 'review');
      expect(old?.id).toBe(attemptId);
      expect(old?.state).toBe('abandoned');
      expect(fresh).toEqual(expect.objectContaining({ state: 'succeeded', purpose: 'user_retry' }));
      expect(h.db.repos.ledger.attemptBalances(attemptId)).toEqual({ reserved: 0, unknown: 0, settled: expectedEstimate(old!, 0) }); // counted once
      expect(h.db.repos.ledger.runBalances(runId).U).toBe(0);
      expect(h.calls({ runId, stepKey: 'review' })).toHaveLength(1);
      return expectStorageInvariants(h.db, e.userDataDir);
    });
  });

  it('#3 crash-after-dispatch-plan scenario: plan uncertain, settled as an estimate (1 call, a response id arrived); retry_step → 2 calls (explicit) @crash @m3', async () => {
    const e = await env();
    const scenario = 'crash-after-dispatch-plan';
    const crashed = await runChild({ userDataDir: e.userDataDir, scenario, action: startAction(e), until: ['awaiting_approval'] });
    expectExit(crashed, CRASH_EXIT);
    const runId = runIdOf(crashed);

    expectExit(await runChild({ userDataDir: e.userDataDir, scenario, action: { kind: 'recover' }, runId, until: ['interrupted'] }), 0);

    await inspect(e, scenario, async (h) => {
      const [a] = h.attempts(runId, 'plan');
      expect(a?.state).toBe('unknown');
      expect(h.attempts(runId, 'review').map((x) => x.state)).toEqual(['succeeded']);
      expect(h.db.repos.ledger.attemptBalances(a!.id)).toEqual({ reserved: 0, unknown: 0, settled: expectedEstimate(a!, 0) });
      expect(a!.mayNotHaveBeenCharged).toBe(false); // the response id was recorded before the crash
      expect(h.calls({ runId, stepKey: 'plan' })).toHaveLength(1);
      expect(h.calls({ runId, stepKey: 'review' })).toHaveLength(1);
      await expectStorageInvariants(h.db, e.userDataDir);
    });

    expectExit(await runChild({ userDataDir: e.userDataDir, scenario, action: { kind: 'resume', decision: { kind: 'continue' } }, runId, until: ['paused'] }), 0);
    await inspect(e, scenario, (h) => {
      expect(h.db.repos.runs.get(runId).pauseReason).toBe('unknown_outcome');
      expect(h.calls({ runId, stepKey: 'plan' })).toHaveLength(1); // review_recovery alone never dispatches
    });
    expectExit(await runChild({ userDataDir: e.userDataDir, scenario, action: { kind: 'retryStep', stepKey: 'plan' }, runId, until: ['awaiting_approval'] }), 0);
    await inspect(e, scenario, (h) => {
      expect(h.calls({ runId, stepKey: 'plan' })).toHaveLength(2);
      expect(h.calls({ runId, stepKey: 'plan' }).map((c) => c.purpose)).toEqual(['initial', 'user_retry']);
      expect(h.attempts(runId, 'plan').map((x) => x.state)).toEqual(['abandoned', 'succeeded']);
      expect(h.calls({ runId, stepKey: 'review' })).toHaveLength(1);
      return expectStorageInvariants(h.db, e.userDataDir);
    });
  });

  it('#4 afterProviderResponse@implement + reconcile-completed (lookup on): estimate settled at recovery, then F9b → reconciled_succeeded, the estimate corrected (never counted twice), no new call @crash @m3', async () => {
    const e = await env();
    const scenario = 'reconcile-completed';
    const caps = { supportsRequestLookup: true } as const;
    const first = await runChild({ userDataDir: e.userDataDir, scenario, fakeCapabilityOverrides: caps, action: startAction(e), until: ['awaiting_approval'] });
    expectExit(first, 0);
    const runId = runIdOf(first);

    const crashed = await runChild({ userDataDir: e.userDataDir, scenario, fakeCapabilityOverrides: caps, action: { kind: 'approve' }, runId, until: ['completed'] },
      { crashAt: 'afterProviderResponse@implement' });
    expectExit(crashed, CRASH_EXIT);

    const recovered = await runChild({ userDataDir: e.userDataDir, scenario, fakeCapabilityOverrides: caps, action: { kind: 'recover' }, runId,
      until: ['interrupted', 'queued', 'running', 'completed'], untilNoUnknown: true });
    expectExit(recovered, 0);

    await inspect(e, scenario, async (h) => {
      const [a, ...rest] = h.attempts(runId, 'implement');
      expect(rest).toEqual([]);
      expect(a?.providerResponseId).toBe(`fake_resp_${a!.id}`);
      expect(a?.state).toBe('reconciled_succeeded');
      const mine = attemptEntries(h.db, runId, a!.id);
      expect(mine.map(([t, , , c]) => [t, c])).toEqual([['reserve', null], ['release', null], ['settle', 'estimated'], ['settle', 'estimated'], ['settle', 'calculated']]);
      expect(mine[3]?.[2]).toBe(-(mine[2]?.[2] ?? 0)); // the correction removes exactly the estimate
      expect(h.db.repos.ledger.attemptBalances(a!.id)).toEqual({ reserved: 0, unknown: 0, settled: mine[4]?.[2] });
      expect(h.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: 0 }));
      expect(h.steps(runId, 'implement').at(-1)?.state).toBe('succeeded');
      expect(h.calls({ runId, stepKey: 'implement' })).toHaveLength(1);
      expect(h.callLog.reconcileEntries().filter((x) => x.attemptId === a!.id).length).toBeGreaterThanOrEqual(1);
      await expectStorageInvariants(h.db, e.userDataDir);
    });

    const status = await inspect(e, scenario, (h) => h.db.repos.runs.get(runId).status);
    if (status !== 'completed') {
      expectExit(await runChild({ userDataDir: e.userDataDir, scenario, fakeCapabilityOverrides: caps, action: { kind: 'resume', decision: { kind: 'continue' } }, runId, until: ['completed'] }), 0);
    }
    await inspect(e, scenario, (h) => {
      expect(h.db.repos.runs.get(runId).status).toBe('completed');
      expect(h.calls({ runId, stepKey: 'implement' })).toHaveLength(1);
      return expectStorageInvariants(h.db, e.userDataDir);
    });
  });

  it('#5 afterStepCommit@review: review succeeded and never re-run (FR-07); interrupted; resume → plan next @crash @m3', async () => {
    const e = await env();
    const crashed = await runChild({ userDataDir: e.userDataDir, action: startAction(e), until: ['awaiting_approval'] }, { crashAt: 'afterStepCommit@review' });
    expectExit(crashed, CRASH_EXIT);
    const runId = runIdOf(crashed);

    expectExit(await runChild({ userDataDir: e.userDataDir, action: { kind: 'recover' }, runId, until: ['interrupted'] }), 0);
    await inspect(e, 'happy-path', (h) => {
      expect(h.db.repos.runs.get(runId).status).toBe('interrupted');
      expect(h.steps(runId, 'review').map((s) => s.state)).toEqual(['succeeded']);
      expect(h.attempts(runId, 'plan')).toEqual([]);
      return expectStorageInvariants(h.db, e.userDataDir);
    });

    expectExit(await runChild({ userDataDir: e.userDataDir, action: { kind: 'resume', decision: { kind: 'continue' } }, runId, until: ['awaiting_approval'] }), 0);
    await inspect(e, 'happy-path', (h) => {
      expect(h.calls({ runId, stepKey: 'review' })).toHaveLength(1);
      expect(h.calls({ runId, stepKey: 'plan' })).toHaveLength(1);
      expect(h.calls({ runId }).map((c) => c.stepKey)).toEqual(['review', 'plan']);
      return expectStorageInvariants(h.db, e.userDataDir);
    });
  });

  it('#6 afterApprovalCommit@approve: the decision is durable; the run resumes into implement without a new approval @crash @m3', async () => {
    const e = await env();
    const first = await runChild({ userDataDir: e.userDataDir, action: startAction(e), until: ['awaiting_approval'] });
    expectExit(first, 0);
    const runId = runIdOf(first);

    const crashed = await runChild({ userDataDir: e.userDataDir, action: { kind: 'approve' }, runId, until: ['completed'] }, { crashAt: 'afterApprovalCommit@approve' });
    expectExit(crashed, CRASH_EXIT);
    await inspect(e, 'happy-path', (h) => {
      const approvals = h.steps(runId, 'approve');
      expect(approvals.map((s) => s.state)).toEqual(['succeeded']);
      expect(h.db.repos.approvals.latestApprovedForRun(runId)?.decision).toBe('approved');
    });

    // At the crash the run was queued (B2) or already picked up by the loop (running) → recovery: queued runs on;
    // running → interrupted and the user resumes. Either way the approval is never requested again.
    const recovered = await runChild({ userDataDir: e.userDataDir, action: { kind: 'recover' }, runId, until: ['completed', 'interrupted'] });
    expectExit(recovered, 0);
    if (recovered.status === 'interrupted') {
      await inspect(e, 'happy-path', (h) => {
        expect(h.db.repos.approvals.pendingForRun(runId)).toBeUndefined();
        expect(h.steps(runId, 'approve').map((s) => s.state)).toEqual(['succeeded']);
      });
      expectExit(await runChild({ userDataDir: e.userDataDir, action: { kind: 'resume', decision: { kind: 'continue' } }, runId, until: ['completed'] }), 0);
    }
    await inspect(e, 'happy-path', (h) => {
      expect(h.db.repos.runs.get(runId).status).toBe('completed');
      expect(h.db.repos.approvals.pendingForRun(runId)).toBeUndefined();
      expect(h.steps(runId, 'approve')).toHaveLength(1);
      expect(h.calls({ runId, stepKey: 'implement' })).toHaveLength(1);
      expect(h.calls({ runId, stepKey: 'review' })).toHaveLength(1);
      expect(h.calls({ runId, stepKey: 'plan' })).toHaveLength(1);
      return expectStorageInvariants(h.db, e.userDataDir);
    });
  });

  it('#7 SIGKILL while awaiting_approval: still awaiting_approval after restart; no attempt touched @crash @m3', async () => {
    const e = await env();
    const killed = await runChild({ userDataDir: e.userDataDir, action: startAction(e), until: ['awaiting_approval'] }, { killOnStatus: true });
    expect(killed.signal).toBe('SIGKILL');
    const runId = runIdOf(killed);
    const before = await inspect(e, 'happy-path', (h) => h.db.repos.attempts.listForRun(runId));

    expectExit(await runChild({ userDataDir: e.userDataDir, action: { kind: 'recover' }, runId, until: ['awaiting_approval', 'interrupted', 'paused'] }), 0);
    await inspect(e, 'happy-path', (h) => {
      expect(h.db.repos.runs.get(runId).status).toBe('awaiting_approval');
      expect(h.db.repos.attempts.listForRun(runId)).toEqual(before);
      expect(h.db.repos.approvals.pendingForRun(runId)).toBeDefined();
      return expectStorageInvariants(h.db, e.userDataDir);
    });
  });
});
