// E1 regression tests (audit 2, engine + money): budget-scope dead end, memory chosen at start, a terminal run's unknown
// liability, runs.start after the idempotency TTL, the stalled-runner double release, same-key concurrent commands,
// and offered actions that always failed. Each was ported from the auditor's failing scenario.
import { afterEach, describe, expect, it } from 'vitest';
import { IDEMPOTENCY_TTL_MS, RUNNER_STALE_AFTER_MS, errors } from '@relay/contracts';
import type { AttemptId, MemoryId, RunId, StepKey } from '@relay/contracts';
import { applyRunEvent } from './run-machine.js';
import { createEngineContext, createEngineFromContext, tick } from './runner.js';
import { createHarness } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';
import { drive } from './testing/drive.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function harness(o: HarnessOptions = {}): Promise<Harness> {
  h = await createHarness(o);
  return h;
}

const detailOf = async (x: Harness, runId: RunId) => {
  const d = await x.engine.handle('relay/v1/runs.get', { runId });
  if (!d.ok) throw new Error(d.error.code);
  return d.data;
};

const startInput = (x: Harness, key: string, extra: Record<string, unknown> = {}) => ({
  idempotencyKey: key, projectId: x.projectId, workflowId: x.db.repos.workflows.listWorkflows()[0]?.id ?? ('' as never), workflowVersion: 1,
  goal: 'Fix the defects in the handlers.', input: { kind: 'files' as const, relPaths: ['src/handlers/user.ts'] }, ...extra,
});

describe('#1 budget pause scope', () => {
  it('a budget_run pause whose next admission fails at the PROJECT scope moves to budget_project (edit_project_allowance offered)', async () => {
    const x = await harness({ monthlyAllowanceMicrousd: 10_000 });
    const runId = await x.startRun({ budgetMicrousd: 10_000 });
    expect(await drive(x, runId, ['paused', 'awaiting_approval', 'completed'])).toBe('paused');
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('budget_run');

    const inc = await x.engine.handle('relay/v1/runs.increaseAllowance', { idempotencyKey: 'e1-scope-incr-0001', runId, newAllowanceMicrousd: 5_000_000 });

    expect(inc.ok && [inc.data.status, inc.data.budget?.scope]).toEqual(['paused', 'project']);
    const d = await detailOf(x, runId);
    expect([d.pauseReason, d.statusDetail?.code, d.statusDetail?.details?.['scope']]).toEqual(['budget_project', 'BUDGET_BLOCKED', 'project']);
    expect(d.availableActions).toContain('edit_project_allowance');
  });

  it('a project allowance edit re-checks paused(budget_run) runs too and resumes the ones that now pass', async () => {
    const x = await harness({ monthlyAllowanceMicrousd: 10_000 });
    const runId = await x.startRun({ budgetMicrousd: 5_000_000 });
    // The run allowance is ample; only the project cap blocks — label it budget_run (as an older build did).
    await tick(x.ctx);
    const blocked = x.db.repos.runs.get(runId);
    expect([blocked.status, blocked.pauseReason]).toEqual(['paused', 'budget_project']);
    x.db.tx('immediate', (r) => {
      r.runs.updateStatus(runId, ['paused'], 'paused', { pauseReason: 'budget_run', statusDetail: null });
    });
    const p = x.db.repos.projects.get(x.projectId);

    const up = await x.engine.handle('relay/v1/projects.update', { projectId: x.projectId, expectedUpdatedAt: p.updatedAt, patch: { monthlyAllowanceMicrousd: 50_000_000 } });

    expect(up.ok).toBe(true);
    expect(x.db.repos.runs.get(runId).status).toBe('queued');
  });

  it('a project allowance edit that leaves the RUN scope failing moves budget_project → budget_run', async () => {
    const x = await harness({ monthlyAllowanceMicrousd: 10_000 });
    const runId = await x.startRun({ budgetMicrousd: 10_000 });
    await drive(x, runId, ['paused']);
    await x.engine.handle('relay/v1/runs.increaseAllowance', { idempotencyKey: 'e1-scope-incr-0002', runId, newAllowanceMicrousd: 20_000 });
    x.db.tx('immediate', (r) => {
      r.runs.updateStatus(runId, ['paused'], 'paused', { pauseReason: 'budget_project', statusDetail: null });
    });
    const p = x.db.repos.projects.get(x.projectId);

    await x.engine.handle('relay/v1/projects.update', { projectId: x.projectId, expectedUpdatedAt: p.updatedAt, patch: { monthlyAllowanceMicrousd: 50_000_000 } });

    const run = x.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason]).toEqual(['paused', 'budget_run']);
    expect((await detailOf(x, runId)).availableActions).toContain('increase_allowance');
  });
});

describe('#2 memory records chosen at start', () => {
  it('runs.start refuses a memoryRecordIds entry that is not approved for the project (VALIDATION_FAILED memory_not_approved)', async () => {
    const x = await harness();
    const res = await x.engine.handle('relay/v1/runs.start', startInput(x, 'e1-mem-start-00001', { memoryRecordIds: ['mem_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as MemoryId] }));

    expect(res.ok ? null : [res.error.code, (res.error.details?.['issues'] as { code: string }[])[0]?.code]).toEqual(['VALIDATION_FAILED', 'memory_not_approved']);
    expect(x.db.repos.runs.idsForProject(x.projectId)).toEqual([]);
  });

  it('an approved record is accepted', async () => {
    const x = await harness();
    const mem = await x.engine.handle('relay/v1/memory.create', { idempotencyKey: 'e1-mem-create-0001', projectId: x.projectId, type: 'user_rule',
      title: 'Validate inputs', content: 'Validate inputs with the helpers.', scope: { roles: 'all' } });
    if (!mem.ok) throw new Error(mem.error.code);

    const res = await x.engine.handle('relay/v1/runs.start', startInput(x, 'e1-mem-start-00002', { memoryRecordIds: [mem.data.id] }));

    expect(res.ok && res.data.status).toBe('queued');
  });
});

describe('#4 unknown charge on a terminal run', () => {
  async function stoppedWithUnknown(): Promise<{ x: Harness; runId: RunId; attemptId: AttemptId }> {
    const x = await harness({ scenario: { name: 'u', steps: [{ match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'unknown_after_dispatch' } }] },
      monthlyAllowanceMicrousd: 100_000 });
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const a = x.db.repos.attempts.listForRun(runId).find((y) => y.state === 'unknown');
    if (a === undefined) throw new Error('no unknown attempt');
    const stop = await x.engine.handle('relay/v1/runs.cancel', { runId });
    expect(stop.ok && stop.data.status).toBe('cancelled');
    return { x, runId, attemptId: a.id };
  }

  it('offers decide_unknown on the stopped run; accept_estimated_charge settles the liability without a status change', async () => {
    const { x, runId, attemptId } = await stoppedWithUnknown();
    expect((await detailOf(x, runId)).availableActions).toEqual(['decide_unknown', 'export_report']);
    const U = x.db.repos.ledger.runBalances(runId).U;
    expect(U).toBeGreaterThan(0);

    const retry = await x.engine.handle('relay/v1/runs.decideUnknown', { idempotencyKey: 'e1-term-decide-0001', runId, attemptId, decision: 'retry_acknowledging_charge' });
    const accept = await x.engine.handle('relay/v1/runs.decideUnknown', { idempotencyKey: 'e1-term-decide-0002', runId, attemptId, decision: 'accept_estimated_charge' });

    expect(retry.ok ? null : retry.error.details?.['reason']).toBe('decision_not_applicable');
    expect(accept.ok && [accept.data.status, accept.data.availableActions]).toEqual(['cancelled', ['export_report']]);
    const b = x.db.repos.ledger.runBalances(runId);
    expect([b.U, b.R]).toEqual([0, 0]);
    expect(x.db.repos.attempts.find(attemptId)?.state).toBe('failed');
    // Months later the liability no longer reduces the project allowance.
    x.timers.advance(95 * 24 * 3600 * 1000);
    const sum = await x.engine.handle('relay/v1/ledger.projectSummary', { projectId: x.projectId });
    expect(sum.ok && sum.data.unknownMicrousd).toBe(0);
  });

  it('mark_failed_keep_liability abandons the attempt (liability kept, as chosen)', async () => {
    const { x, runId, attemptId } = await stoppedWithUnknown();

    const res = await x.engine.handle('relay/v1/runs.decideUnknown', { idempotencyKey: 'e1-term-decide-0003', runId, attemptId, decision: 'mark_failed_keep_liability' });

    expect(res.ok && res.data.status).toBe('cancelled');
    expect(x.db.repos.attempts.find(attemptId)?.state).toBe('abandoned');
    expect(x.db.repos.ledger.runBalances(runId).U).toBeGreaterThan(0);
  });
});

describe('#5 runs.start after the idempotency TTL', () => {
  it('the same request replays the run it created (never INTERNAL); another request with that key → CONFLICT', async () => {
    const x = await harness();
    const input = startInput(x, 'e1-start-ttl-000001');
    const first = await x.engine.handle('relay/v1/runs.start', input);
    expect(first.ok).toBe(true);
    x.clock.advance(IDEMPOTENCY_TTL_MS + 1);

    const after = await x.engine.handle('relay/v1/runs.start', input);
    const other = await x.engine.handle('relay/v1/runs.start', { ...input, goal: 'Something else.' });

    expect(after.ok && first.ok && after.data.runId).toBe(first.ok && first.data.runId);
    expect(x.db.repos.runs.idsForProject(x.projectId)).toHaveLength(1);
    expect(other.ok ? null : [other.error.code, other.error.details?.['reason']]).toEqual(['CONFLICT', 'idempotency_key_reused']);
  });
});

describe('#6 stalled runner taken over between reserve and dispatch intent', () => {
  it('the stale runner writes nothing: the reservation is released once (R ≥ 0)', async () => {
    let takenOver = false;
    const x = await harness({ scenario: 'happy-path' });
    const runId = await x.startRun();
    x.ctx.lease.owned = true;
    (x.ctx.lease as { ownerId?: string }).ownerId = 'runner_A';
    x.db.repos.lease.acquire('runner_A', process.pid, x.clock.now(), RUNNER_STALE_AFTER_MS);
    const ctxB = createEngineContext({ ...x.ctx, emit: () => undefined, hooks: undefined });
    const engineB = createEngineFromContext(ctxB);
    const push = x.events.push.bind(x.events);
    x.events.push = (...e) => {
      for (const ev of e) {
        if (!takenOver && ev.type === 'run.event' && ev.event.type === 'ledger.reserved') {
          takenOver = true;
          x.clock.advance(RUNNER_STALE_AFTER_MS + 1);
          void engineB.start(); // lease takeover + recovery run synchronously up to the first await
        }
      }
      return push(...e);
    };
    for (let i = 0; i < 30 && !(takenOver as boolean); i += 1) await tick(x.ctx);
    expect(takenOver).toBe(true);
    await new Promise((r) => globalThis.setTimeout(r, 50));
    await engineB.stop({ graceMs: 0 });

    const b = x.db.repos.ledger.runBalances(runId);
    expect(b.R).toBe(0);
    for (const a of x.db.repos.attempts.listForRun(runId)) expect(x.db.repos.ledger.attemptBalances(a.id).reserved).toBe(0);
  });
});

describe('#7 same-key concurrent commands replay', () => {
  it('approvals.decide double click: both get the decided result', async () => {
    const x = await harness();
    const runId = await x.startRun();
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    const a = (await detailOf(x, runId)).pendingApproval;
    if (a === null) throw new Error('no approval');
    const input = { idempotencyKey: 'e1-dbl-approve-0001', approvalId: a.id, planHash: a.planHash, contextHash: a.contextHash, decision: 'approved' as const };

    const [p, q] = await Promise.all([x.engine.handle('relay/v1/approvals.decide', input), x.engine.handle('relay/v1/approvals.decide', input)]);

    expect([p.ok, q.ok]).toEqual([true, true]);
  });

  it('runs.increaseAllowance double click: both ok, one allowance change', async () => {
    const x = await harness();
    const runId = await x.startRun({ budgetMicrousd: 10_000 });
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const input = { idempotencyKey: 'e1-dbl-incr-000001', runId, newAllowanceMicrousd: 3_000_000 };

    const [p, q] = await Promise.all([x.engine.handle('relay/v1/runs.increaseAllowance', input), x.engine.handle('relay/v1/runs.increaseAllowance', input)]);

    expect([p.ok, q.ok]).toEqual([true, true]);
    expect(x.db.repos.ledger.listForRun(runId).filter((e) => e.entry.type === 'allowance_change')).toHaveLength(1);
  });

  it('runs.retryStep double click (profile resolved before the tx): both ok, one new step row', async () => {
    const x = await harness({ scenario: { name: 'refuse', steps: [{ match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'refused' } }] } });
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const failed = x.db.repos.steps.latestFor(runId, 'review' as StepKey);
    const profile = x.db.repos.profiles.list()[0];
    if (failed === undefined || profile === undefined) throw new Error('setup');
    const input = { idempotencyKey: 'e1-dbl-retry-000001', runId, stepId: failed.id, profileId: profile.id };

    const [p, q] = await Promise.all([x.engine.handle('relay/v1/runs.retryStep', input), x.engine.handle('relay/v1/runs.retryStep', input)]);

    expect([p.ok, q.ok]).toEqual([true, true]);
    expect(x.db.repos.steps.listForRun(runId).filter((s) => s.stepKey === 'review')).toHaveLength(2);
  });

  it('runs.decideUnknown double click: both ok, one decision', async () => {
    const x = await harness({ scenario: { name: 'u', steps: [{ match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'unknown_after_dispatch' } }] } });
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const a = x.db.repos.attempts.listForRun(runId).find((y) => y.state === 'unknown');
    if (a === undefined) throw new Error('no unknown');
    const input = { idempotencyKey: 'e1-dbl-decide-00001', runId, attemptId: a.id, decision: 'accept_estimated_charge' as const };

    const [p, q] = await Promise.all([x.engine.handle('relay/v1/runs.decideUnknown', input), x.engine.handle('relay/v1/runs.decideUnknown', input)]);

    expect([p.ok, q.ok]).toEqual([true, true]);
    expect(x.db.repos.ledger.listForRun(runId).filter((e) => e.entry.type === 'resolve_unknown')).toHaveLength(1);
  });
});

describe('#8 offered actions are the ones the handlers accept', () => {
  it('a budget pause with a failed step offers retry_step and choose_profile, and runs.retryStep accepts both', async () => {
    const x = await harness({ scenario: { name: 'refuse', steps: [{ match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'refused' } }] } });
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    x.db.tx('immediate', (r) => {
      r.runs.updateStatus(runId, ['paused'], 'paused', { pauseReason: 'budget_run', statusDetail: null });
    });
    const d = await detailOf(x, runId);
    expect(d.availableActions).toEqual(['increase_allowance', 'retry_step', 'choose_profile', 'stop']);
    const failed = x.db.repos.steps.latestFor(runId, 'review' as StepKey);
    const option = d.profileOptions?.[0];
    if (failed === undefined || option === undefined) throw new Error('setup');

    const chosen = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'e1-budget-choose-01', runId, stepId: failed.id, profileId: option.profileId });

    expect(chosen.ok && chosen.data.status).toBe('queued');
  });

  it('an interrupted run with an unknown attempt offers decide_unknown, then review_recovery once decided', async () => {
    const x = await harness({ scenario: { name: 'u', steps: [{ match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'unknown_after_dispatch' } }] } });
    const runId = await x.startRun();
    await drive(x, runId, ['paused']);
    x.db.tx('immediate', (r) => {
      r.runs.updateStatus(runId, ['paused'], 'interrupted', {});
    });
    expect((await detailOf(x, runId)).availableActions).toEqual(['decide_unknown', 'stop']);
    const a = x.db.repos.attempts.listForRun(runId).find((y) => y.state === 'unknown');

    await x.engine.handle('relay/v1/runs.decideUnknown', { idempotencyKey: 'e1-int-decide-00001', runId, attemptId: a?.id ?? 'att_01J9ZZZZZZZZZZZZZZZZZZZZZ0', decision: 'retry_acknowledging_charge' });
    const d = await detailOf(x, runId);
    const resumed = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'e1-int-resume-00001', runId, decision: { kind: 'continue' } });

    expect(d.availableActions).toEqual(['review_recovery', 'stop']);
    expect(resumed.ok && resumed.data.status).toBe('queued');
  });

  it('paused(auth_required) without a credential ref offers only reconnect_provider (resume → AUTH_REQUIRED)', async () => {
    const x = await harness();
    const runId = await x.startRun();
    await tick(x.ctx);
    x.db.tx('immediate', (r) => applyRunEvent(r, r.runs.get(runId), { type: 'AUTH_FAILED', error: errors.authRequired('anthropic') }, x.clock.now(), []));
    for (const p of ['anthropic', 'openai', 'gemini', 'fake'] as const) x.db.repos.credentials.delete(p);

    const d = await detailOf(x, runId);
    const res = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'e1-auth-resume-0001', runId, decision: { kind: 'continue' } });

    expect(d.availableActions).toEqual(['reconnect_provider', 'stop']);
    expect(res.ok ? null : res.error.code).toBe('AUTH_REQUIRED');
  });
});
