import { afterEach, describe, expect, it } from 'vitest';
import { PAUSE_REASONS, RUN_STATUSES, errors, isTerminalRunStatus } from '@relay/contracts';
import type { ApprovalId, AttemptId, PauseReason, RunStatus } from '@relay/contracts';
import type { PostCommitEffect, RunMachineEvent, RunMachineEventType } from './run-machine.js';
import { allowedRunActions, applyRunEvent, runEffects, transitionRun } from './run-machine.js';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

const E = errors.providerUnavailable();
const ATT = 'att_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as AttemptId;

/** One representative event per type (reason-carrying events get their first reason). */
const SAMPLES: Record<RunMachineEventType, RunMachineEvent> = {
  CHECKS_PASSED: { type: 'CHECKS_PASSED' },
  SETUP_BLOCKED: { type: 'SETUP_BLOCKED', reason: 'setup_blocked', error: E },
  PLAN_READY: { type: 'PLAN_READY', approvalId: 'apr_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as ApprovalId },
  APPROVED_MATCHING: { type: 'APPROVED_MATCHING' },
  REJECTED: { type: 'REJECTED' },
  REVISION_REQUESTED: { type: 'REVISION_REQUESTED' },
  BUDGET_BLOCKED: { type: 'BUDGET_BLOCKED', scope: 'run', error: E },
  BUDGET_OVERRUN: { type: 'BUDGET_OVERRUN', attemptId: ATT, error: E },
  USER_PAUSE: { type: 'USER_PAUSE' },
  AUTH_FAILED: { type: 'AUTH_FAILED', error: E },
  RATE_LIMIT_EXHAUSTED: { type: 'RATE_LIMIT_EXHAUSTED', error: E },
  APPROVAL_STALE: { type: 'APPROVAL_STALE', error: E },
  LIMIT_REACHED: { type: 'LIMIT_REACHED', reason: 'limit_attempts', error: E },
  OUTPUT_INVALID_EXHAUSTED: { type: 'OUTPUT_INVALID_EXHAUSTED', error: E },
  TRANSPORT_EXHAUSTED: { type: 'TRANSPORT_EXHAUSTED', error: E },
  MODEL_REFUSED: { type: 'MODEL_REFUSED', error: E },
  UNKNOWN_OUTCOME: { type: 'UNKNOWN_OUTCOME', attemptId: ATT, error: E },
  RUNNER_LOST: { type: 'RUNNER_LOST' },
  UNRECOVERABLE: { type: 'UNRECOVERABLE', error: E },
  ACCEPTED: { type: 'ACCEPTED' },
  REVISION_LIMIT: { type: 'REVISION_LIMIT', cause: 'revision_limit' },
  CANCEL_REQUESTED: { type: 'CANCEL_REQUESTED' },
  STOP_REQUESTED: { type: 'STOP_REQUESTED' },
  WORK_STOPPED: { type: 'WORK_STOPPED' },
  RESUME_RESOLVED: { type: 'RESUME_RESOLVED' },
  RECOVERY_DECIDED: { type: 'RECOVERY_DECIDED' },
};

type Row = readonly [RunStatus, RunMachineEvent, RunStatus, PauseReason | null];
const sb = (reason: 'setup_blocked' | 'auth_required' | 'budget_run' | 'budget_project'): RunMachineEvent => ({ type: 'SETUP_BLOCKED', reason, error: E });

/** The F2 table, one row per reason-variant. */
const TABLE: readonly Row[] = [
  ['queued', SAMPLES.CHECKS_PASSED, 'running', null],
  ['queued', sb('setup_blocked'), 'paused', 'setup_blocked'],
  ['queued', sb('auth_required'), 'paused', 'auth_required'],
  ['queued', sb('budget_run'), 'paused', 'budget_run'],
  ['queued', sb('budget_project'), 'paused', 'budget_project'],
  ['queued', SAMPLES.CANCEL_REQUESTED, 'cancelled', null],
  ['queued', SAMPLES.BUDGET_OVERRUN, 'paused', 'budget_overrun'], // clarification 14 (deferred while queued)
  ['queued', SAMPLES.APPROVAL_STALE, 'paused', 'approval_stale'],
  ['running', SAMPLES.PLAN_READY, 'awaiting_approval', null],
  ['running', sb('setup_blocked'), 'paused', 'setup_blocked'],
  ['running', sb('auth_required'), 'paused', 'auth_required'],
  ['running', { type: 'BUDGET_BLOCKED', scope: 'run', error: E }, 'paused', 'budget_run'],
  ['running', { type: 'BUDGET_BLOCKED', scope: 'project', error: E }, 'paused', 'budget_project'],
  ['running', SAMPLES.BUDGET_OVERRUN, 'paused', 'budget_overrun'],
  ['running', SAMPLES.USER_PAUSE, 'paused', 'user'],
  ['running', SAMPLES.AUTH_FAILED, 'paused', 'auth_required'],
  ['running', SAMPLES.RATE_LIMIT_EXHAUSTED, 'paused', 'rate_limited'],
  ['running', SAMPLES.APPROVAL_STALE, 'paused', 'approval_stale'],
  ['running', { type: 'LIMIT_REACHED', reason: 'limit_attempts', error: E }, 'paused', 'limit_attempts'],
  ['running', { type: 'LIMIT_REACHED', reason: 'deadline', error: E }, 'paused', 'deadline'],
  ['running', SAMPLES.OUTPUT_INVALID_EXHAUSTED, 'paused', 'output_invalid'],
  ['running', SAMPLES.TRANSPORT_EXHAUSTED, 'paused', 'provider_unavailable'],
  ['running', SAMPLES.MODEL_REFUSED, 'paused', 'model_refused'],
  ['running', SAMPLES.UNKNOWN_OUTCOME, 'paused', 'unknown_outcome'],
  ['running', SAMPLES.RUNNER_LOST, 'interrupted', null],
  ['running', SAMPLES.UNRECOVERABLE, 'failed', null],
  ['running', SAMPLES.ACCEPTED, 'completed', null],
  ['running', { type: 'REVISION_LIMIT', cause: 'revision_limit' }, 'incomplete', null],
  ['running', { type: 'REVISION_LIMIT', cause: 'verifier_incomplete' }, 'incomplete', null],
  ['running', SAMPLES.CANCEL_REQUESTED, 'cancelling', null],
  ['awaiting_approval', SAMPLES.APPROVED_MATCHING, 'queued', null], // ruling B2: the loop's CHECKS_PASSED starts it
  ['awaiting_approval', SAMPLES.REVISION_REQUESTED, 'queued', null],
  ['awaiting_approval', SAMPLES.REJECTED, 'cancelled', null],
  ['awaiting_approval', SAMPLES.APPROVAL_STALE, 'paused', 'approval_stale'],
  ['awaiting_approval', SAMPLES.CANCEL_REQUESTED, 'cancelled', null],
  ['paused', SAMPLES.RESUME_RESOLVED, 'queued', null],
  ['paused', SAMPLES.CANCEL_REQUESTED, 'cancelled', null],
  ['paused', SAMPLES.STOP_REQUESTED, 'cancelled', null],
  ['paused', SAMPLES.BUDGET_OVERRUN, 'paused', 'budget_overrun'],
  ['paused', SAMPLES.APPROVAL_STALE, 'paused', 'approval_stale'],
  ['interrupted', SAMPLES.RECOVERY_DECIDED, 'queued', null],
  ['interrupted', SAMPLES.CANCEL_REQUESTED, 'cancelled', null],
  ['interrupted', SAMPLES.STOP_REQUESTED, 'cancelled', null],
  ['interrupted', SAMPLES.BUDGET_OVERRUN, 'paused', 'budget_overrun'], // clarification 14 (deferred reconciled overrun)
  ['interrupted', SAMPLES.APPROVAL_STALE, 'paused', 'approval_stale'],
  ['cancelling', SAMPLES.WORK_STOPPED, 'cancelled', null],
  ['cancelling', SAMPLES.RUNNER_LOST, 'cancelled', null],
];

describe('transitionRun (F2 table)', () => {
  it.each(TABLE.map((row) => [`${row[0]} + ${row[1].type}${'reason' in row[1] ? `(${row[1].reason})` : ''}`, row] as const))('%s', (_name, row) => {
    const [from, ev, to, pauseReason] = row;

    const t = transitionRun(from, ev);

    expect(t).toEqual({ to, pauseReason });
  });

  it('maps every other (status, event) pair to ILLEGAL (generated matrix)', () => {
    const legal = new Set(TABLE.map(([from, ev]) => `${from}|${ev.type}`));
    const illegal: string[] = [];

    for (const status of RUN_STATUSES) {
      for (const [type, ev] of Object.entries(SAMPLES)) {
        const t = transitionRun(status, ev);
        if (!legal.has(`${status}|${type}`)) {
          expect(t, `${status} + ${type}`).toEqual({ error: 'ILLEGAL' });
          illegal.push(`${status}|${type}`);
        } else {
          expect('error' in t, `${status} + ${type}`).toBe(false);
        }
      }
    }

    expect(illegal.length).toBe(RUN_STATUSES.length * Object.keys(SAMPLES).length - legal.size);
  });

  it('rejects budget reasons on SETUP_BLOCKED from running (those arrive as BUDGET_BLOCKED)', () => {
    expect(transitionRun('running', sb('budget_run'))).toEqual({ error: 'ILLEGAL' });
    expect(transitionRun('running', sb('budget_project'))).toEqual({ error: 'ILLEGAL' });
  });

  it('reaches failed only through UNRECOVERABLE (R3-1)', () => {
    for (const status of RUN_STATUSES) {
      for (const ev of Object.values(SAMPLES)) {
        const t = transitionRun(status, ev);
        if (!('error' in t) && t.to === 'failed') expect(ev.type).toBe('UNRECOVERABLE');
      }
    }
  });

  it('treats completed/incomplete/cancelled/failed as terminal', () => {
    expect(RUN_STATUSES.filter(isTerminalRunStatus)).toEqual(['cancelled', 'completed', 'incomplete', 'failed']);
  });
});

describe('§7.2 clarifications (one it() each)', () => {
  it('1: queued → cancelled on CANCEL_REQUESTED (nothing in flight)', () => {
    expect(transitionRun('queued', SAMPLES.CANCEL_REQUESTED)).toEqual({ to: 'cancelled', pauseReason: null });
  });
  it('2: awaiting_approval → queued on REVISION_REQUESTED (and APPROVED_MATCHING), never directly to running (B2)', () => {
    expect(transitionRun('awaiting_approval', SAMPLES.REVISION_REQUESTED)).toEqual({ to: 'queued', pauseReason: null });
    expect(transitionRun('awaiting_approval', SAMPLES.APPROVED_MATCHING)).toEqual({ to: 'queued', pauseReason: null });
  });
  it('3: awaiting_approval → paused(approval_stale) on APPROVAL_STALE', () => {
    expect(transitionRun('awaiting_approval', SAMPLES.APPROVAL_STALE)).toEqual({ to: 'paused', pauseReason: 'approval_stale' });
  });
  it('4: awaiting_approval → cancelled on CANCEL_REQUESTED', () => {
    expect(transitionRun('awaiting_approval', SAMPLES.CANCEL_REQUESTED)).toEqual({ to: 'cancelled', pauseReason: null });
  });
  it('5: paused → cancelled on CANCEL_REQUESTED and STOP_REQUESTED', () => {
    expect(transitionRun('paused', SAMPLES.STOP_REQUESTED)).toEqual({ to: 'cancelled', pauseReason: null });
    expect(transitionRun('paused', SAMPLES.CANCEL_REQUESTED)).toEqual({ to: 'cancelled', pauseReason: null });
  });
  it('6: interrupted → cancelled on CANCEL_REQUESTED and STOP_REQUESTED', () => {
    expect(transitionRun('interrupted', SAMPLES.STOP_REQUESTED)).toEqual({ to: 'cancelled', pauseReason: null });
    expect(transitionRun('interrupted', SAMPLES.CANCEL_REQUESTED)).toEqual({ to: 'cancelled', pauseReason: null });
  });
  it('7: cancelling → cancelled on RUNNER_LOST', () => {
    expect(transitionRun('cancelling', SAMPLES.RUNNER_LOST)).toEqual({ to: 'cancelled', pauseReason: null });
  });
  it('8: running → paused carries the added reasons', () => {
    const reasons = TABLE.filter(([from, , to]) => from === 'running' && to === 'paused').map(([, , , r]) => r);
    expect(new Set(reasons)).toEqual(new Set(['budget_run', 'budget_project', 'budget_overrun', 'user', 'auth_required', 'rate_limited',
      'approval_stale', 'limit_attempts', 'deadline', 'unknown_outcome', 'output_invalid', 'provider_unavailable', 'model_refused', 'setup_blocked']));
  });
  it('9: queued → paused uses setup_blocked / auth_required / budget_run / budget_project', () => {
    for (const reason of ['setup_blocked', 'auth_required', 'budget_run', 'budget_project'] as const) {
      expect(transitionRun('queued', sb(reason))).toEqual({ to: 'paused', pauseReason: reason });
    }
  });
  it('10: running → failed is narrowed to UNRECOVERABLE', () => {
    expect(transitionRun('running', SAMPLES.UNRECOVERABLE)).toEqual({ to: 'failed', pauseReason: null });
    expect(transitionRun('running', SAMPLES.TRANSPORT_EXHAUSTED)).toEqual({ to: 'paused', pauseReason: 'provider_unavailable' });
  });
  it('11: running → incomplete also fires for a verifier `incomplete`', () => {
    expect(transitionRun('running', { type: 'REVISION_LIMIT', cause: 'verifier_incomplete' })).toEqual({ to: 'incomplete', pauseReason: null });
  });
  it('12: paused → queued on RESUME_RESOLVED', () => {
    expect(transitionRun('paused', SAMPLES.RESUME_RESOLVED)).toEqual({ to: 'queued', pauseReason: null });
  });
  it('13: interrupted → queued on RECOVERY_DECIDED', () => {
    expect(transitionRun('interrupted', SAMPLES.RECOVERY_DECIDED)).toEqual({ to: 'queued', pauseReason: null });
  });
  it('14: paused → paused(budget_overrun | approval_stale) when a reconciled outcome requires that pause (BH-2, BH-6)', () => {
    expect(transitionRun('paused', SAMPLES.BUDGET_OVERRUN)).toEqual({ to: 'paused', pauseReason: 'budget_overrun' });
    expect(transitionRun('paused', SAMPLES.APPROVAL_STALE)).toEqual({ to: 'paused', pauseReason: 'approval_stale' });
  });
});

describe('allowedRunActions truth table', () => {
  const none = { unknownAttempts: 0, hasFailedStep: false, hasPatchArtifact: false };
  const paused = (reason: PauseReason) => ({ status: 'paused' as const, pauseReason: reason });
  const EXPECTED: Record<PauseReason, readonly string[]> = {
    budget_run: ['increase_allowance', 'choose_profile', 'stop'],
    budget_project: ['edit_project_allowance', 'choose_profile', 'stop'],
    budget_overrun: ['acknowledge_overrun', 'increase_allowance', 'stop'],
    limit_attempts: ['raise_limits', 'stop'],
    deadline: ['raise_limits', 'stop'],
    output_invalid: ['retry_step', 'choose_profile', 'stop'],
    provider_unavailable: ['retry_step', 'choose_profile', 'stop'],
    model_refused: ['retry_step', 'choose_profile', 'stop'],
    setup_blocked: ['resume', 'choose_profile', 'stop'],
    unknown_outcome: ['resume', 'stop'],
    auth_required: ['reconnect_provider', 'resume', 'stop'],
    user: ['resume', 'stop'],
    rate_limited: ['resume', 'stop'],
    approval_stale: ['resnapshot_and_replan', 'use_preserved_snapshot', 'stop'],
  };

  it.each(PAUSE_REASONS.map((r) => [r]))('paused(%s)', (reason) => {
    expect(allowedRunActions(paused(reason), none)).toEqual(EXPECTED[reason]);
  });

  it('offers at least one non-stop action for every pause reason and every unknown/failed combination (no exception)', () => {
    for (const reason of PAUSE_REASONS) {
      for (const facts of [none, { ...none, unknownAttempts: 1 }, { ...none, hasFailedStep: true }, { ...none, unknownAttempts: 1, hasFailedStep: true }]) {
        expect(allowedRunActions(paused(reason), facts).some((a) => a !== 'stop'), `${reason} ${JSON.stringify(facts)}`).toBe(true);
      }
    }
  });

  it('offers decide_unknown only while unknown attempts remain, then retry_step once the step failed', () => {
    expect(allowedRunActions(paused('unknown_outcome'), { ...none, unknownAttempts: 2 })).toEqual(['decide_unknown', 'stop']);
    expect(allowedRunActions(paused('unknown_outcome'), { ...none, hasFailedStep: true })).toEqual(['retry_step', 'choose_profile', 'stop']);
  });

  it('maps every non-paused status', () => {
    const at = (status: RunStatus, f = none) => allowedRunActions({ status, pauseReason: null }, f);
    expect(at('queued')).toEqual(['cancel']);
    expect(at('running')).toEqual(['pause', 'cancel']);
    expect(at('awaiting_approval')).toEqual(['approve', 'request_revision', 'reject', 'cancel']);
    expect(at('interrupted')).toEqual(['review_recovery', 'stop']);
    expect(at('interrupted', { ...none, unknownAttempts: 1 })).toEqual(['review_recovery', 'decide_unknown', 'stop']);
    expect(at('cancelling')).toEqual([]);
    expect(at('paused')).toEqual(['stop']);
    for (const s of ['completed', 'incomplete', 'cancelled', 'failed'] as const) {
      expect(at(s)).toEqual(['export_report']);
      expect(at(s, { ...none, hasPatchArtifact: true })).toEqual(['export_report', 'export_patch']);
    }
  });
});

describe('applyRunEvent', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });

  it('accrues execution time only while running and sets startedAt once', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    const r = h.db.repos;
    const fx: PostCommitEffect[] = [];

    h.db.tx('immediate', (tx) => applyRunEvent(tx, tx.runs.get(runId), SAMPLES.CHECKS_PASSED, h!.clock.now(), fx));
    const started = r.runs.get(runId);
    h.clock.advance(1_500);
    h.db.tx('immediate', (tx) => applyRunEvent(tx, tx.runs.get(runId), SAMPLES.USER_PAUSE, h!.clock.now(), fx));
    h.clock.advance(10_000);
    const paused = r.runs.get(runId);

    expect(started.status).toBe('running');
    expect(started.startedAt).not.toBeNull();
    expect(started.runningSince).not.toBeNull();
    expect(paused.executionMsUsed).toBe(1_500);
    expect(paused.runningSince).toBeNull();
    expect(paused.pauseReason).toBe('user');
    expect(fx.map((e) => e.kind)).toContain('arm_deadline');
    expect(fx.map((e) => e.kind)).toContain('disarm_deadline');
  });

  it('clears pause_requested on USER_PAUSE and records the status detail', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    const fx: PostCommitEffect[] = [];
    h.db.tx('immediate', (tx) => applyRunEvent(tx, tx.runs.get(runId), SAMPLES.CHECKS_PASSED, h!.clock.now(), fx));
    h.db.repos.runs.setPauseRequested(runId, true);

    h.db.tx('immediate', (tx) => applyRunEvent(tx, tx.runs.get(runId), SAMPLES.USER_PAUSE, h!.clock.now(), fx));
    h.db.tx('immediate', (tx) => applyRunEvent(tx, tx.runs.get(runId), SAMPLES.RESUME_RESOLVED, h!.clock.now(), fx));
    h.db.tx('immediate', (tx) => applyRunEvent(tx, tx.runs.get(runId), SAMPLES.CHECKS_PASSED, h!.clock.now(), fx));
    h.db.tx('immediate', (tx) => applyRunEvent(tx, tx.runs.get(runId), SAMPLES.AUTH_FAILED, h!.clock.now(), fx));

    const run = h.db.repos.runs.get(runId);
    expect(run.pauseRequested).toBe(false);
    expect(run.statusDetail?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(run.startedAt).toBe(run.createdAt);
  });

  it('returns false when the CAS loses and throws on an ILLEGAL transition', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    const stale = h.db.repos.runs.get(runId);
    h.db.tx('immediate', (tx) => applyRunEvent(tx, tx.runs.get(runId), SAMPLES.CHECKS_PASSED, h!.clock.now(), []));

    const lost = h.db.tx('immediate', (tx) => applyRunEvent(tx, stale, SAMPLES.CANCEL_REQUESTED, h!.clock.now(), []));

    expect(lost).toBe(false);
    expect(() => h!.db.tx('immediate', (tx) => applyRunEvent(tx, tx.runs.get(runId), SAMPLES.RESUME_RESOLVED, h!.clock.now(), []))).toThrow(/illegal run transition/);
  });

  it('never runs effects of a rolled-back transition', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    const fx: PostCommitEffect[] = [];

    expect(() => h!.db.tx('immediate', (tx) => {
      applyRunEvent(tx, tx.runs.get(runId), SAMPLES.CHECKS_PASSED, h!.clock.now(), fx);
      throw new Error('boom');
    })).toThrow('boom');

    expect(h.db.repos.runs.get(runId).status).toBe('queued');
    expect(h.events.filter((e) => e.type === 'run.status' && e.status === 'running')).toEqual([]); // `fx` never ran
    expect(h.db.repos.events.list(runId, 0, 100).some((e) => e.type === 'run.status_changed')).toBe(false);
  });

  it('queues a terminal effect (report) and logs failing effects without throwing', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    const fx: PostCommitEffect[] = [];
    h.db.tx('immediate', (tx) => applyRunEvent(tx, tx.runs.get(runId), SAMPLES.CANCEL_REQUESTED, h!.clock.now(), fx));

    await runEffects({ ...h.ctx, emit: () => { throw new Error('emit failed'); } }, fx);

    expect(fx.some((e) => e.kind === 'terminal')).toBe(true);
    expect(h.logger.entries.some((e) => e.event === 'effect.failed')).toBe(true);
    await h.waitFor(() => h!.db.repos.artifacts.listForRun(runId, ['report']).length === 1);
  });

  it('B1: RUNNER_LOST closes the running segment at lastAliveAt, never at now (downtime never counts)', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    h.db.tx('immediate', (tx) => applyRunEvent(tx, tx.runs.get(runId), SAMPLES.CHECKS_PASSED, h!.clock.now(), []));
    h.clock.advance(2_000);
    const alive = h.clock.now();
    h.clock.advance(3 * 3_600_000);

    h.db.tx('immediate', (tx) => applyRunEvent(tx, tx.runs.get(runId), { type: 'RUNNER_LOST', lastAliveAt: alive }, h!.clock.now(), []));

    expect(h.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'interrupted', executionMsUsed: 2_000, runningSince: null }));
  });

  it('B2 guard: nothing enters running while another run is running (invariant)', async () => {
    h = await createHarness();
    const a = await h.startRun();
    const b = await h.startRun();
    h.db.tx('immediate', (tx) => applyRunEvent(tx, tx.runs.get(a), SAMPLES.CHECKS_PASSED, h!.clock.now(), []));

    expect(() => h!.db.tx('immediate', (tx) => applyRunEvent(tx, tx.runs.get(b), SAMPLES.CHECKS_PASSED, h!.clock.now(), []))).toThrow(/cannot enter running/);
    expect(h.db.repos.runs.get(b).status).toBe('queued');
  });
});
