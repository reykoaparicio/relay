import { afterEach, describe, expect, it } from 'vitest';
import { STEP_STATES } from '@relay/contracts';
import type { StepState } from '@relay/contracts';
import type { PostCommitEffect } from './run-machine.js';
import type { StepEvent } from './step-machine.js';
import { STEP_EVENTS, applyStepEvent, isTerminalStep, skipOpenSteps, transitionStep } from './step-machine.js';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

const TABLE: readonly (readonly [StepState, StepEvent, StepState])[] = [
  ['pending', 'DEPS_MET', 'ready'],
  ['ready', 'RESERVED', 'reserved'],
  ['ready', 'APPROVAL_OPENED', 'awaiting_approval'],
  ['ready', 'LOCAL_STEP_DONE', 'succeeded'],
  ['reserved', 'DISPATCHING', 'executing'],
  ['reserved', 'RESERVATION_RELEASED', 'ready'],
  ['executing', 'SETTLED_VALID', 'succeeded'],
  ['executing', 'NOT_SENT', 'ready'],
  ['executing', 'SETTLED_RETRY', 'ready'],
  ['executing', 'SETTLED_FAILED', 'failed'],
  ['executing', 'OUTCOME_UNKNOWN', 'unknown'],
  ['unknown', 'USER_RETRY', 'ready'],
  ['unknown', 'USER_ABANDON', 'failed'],
  ['unknown', 'RECONCILED_VALID', 'succeeded'],
  ['unknown', 'RECONCILED_RETRY', 'ready'],
  ['unknown', 'RECONCILED_FAILED', 'failed'],
  ['awaiting_approval', 'DECIDED_APPROVED', 'succeeded'],
  ['awaiting_approval', 'DECIDED_REVISION', 'failed'],
  ['awaiting_approval', 'DECIDED_REJECTED', 'failed'],
];

describe('transitionStep (F3 table)', () => {
  it.each(TABLE.map((row) => [`${row[0]} + ${row[1]} → ${row[2]}`, row] as const))('%s', (_n, [from, ev, to]) => {
    expect(transitionStep(from, ev)).toEqual({ to });
  });

  it('moves every non-terminal state to skipped on RUN_CANCELLED', () => {
    for (const s of STEP_STATES.filter((x) => !isTerminalStep(x))) {
      expect(transitionStep(s, 'RUN_CANCELLED'), s).toEqual({ to: 'skipped' });
    }
  });

  it('keeps terminal steps immutable (every event is ILLEGAL)', () => {
    for (const s of ['succeeded', 'failed', 'skipped'] as const) {
      for (const ev of STEP_EVENTS) expect(transitionStep(s, ev), `${s}+${ev}`).toEqual({ error: 'ILLEGAL' });
    }
  });

  it('never targets validating (it is in-memory only) and rejects every unlisted pair', () => {
    const legal = new Set(TABLE.map(([f, e]) => `${f}|${e}`));
    for (const s of STEP_STATES) {
      for (const ev of STEP_EVENTS) {
        const t = transitionStep(s, ev);
        if ('to' in t) expect(t.to).not.toBe('validating');
        if (ev !== 'RUN_CANCELLED' && !legal.has(`${s}|${ev}`)) expect(t, `${s}+${ev}`).toEqual({ error: 'ILLEGAL' });
      }
    }
  });
});

describe('applyStepEvent / skipOpenSteps', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });

  it('CAS-moves the row, appends step.state_changed, and rejects illegal or stale moves', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    const intake = h.db.repos.steps.latestFor(runId, 'intake' as never);
    if (intake === undefined) throw new Error('no intake');
    const fx: PostCommitEffect[] = [];

    const moved = h.db.tx('immediate', (r) => applyStepEvent(r, fx, intake, 'DEPS_MET'));
    const lost = h.db.tx('immediate', (r) => applyStepEvent(r, fx, intake, 'DEPS_MET'));

    expect(moved).toBe(true);
    expect(lost).toBe(false);
    expect(h.db.repos.steps.get(intake.id).state).toBe('ready');
    expect(h.db.repos.events.list(runId, 0, 100).some((e) => e.type === 'step.state_changed' && e.payload['to'] === 'ready')).toBe(true);
    expect(() => h!.db.tx('immediate', (r) => applyStepEvent(r, fx, h!.db.repos.steps.get(intake.id), 'SETTLED_VALID'))).toThrow(/illegal step/);
  });

  it('skips every non-terminal row of a run', async () => {
    h = await createHarness();
    const runId = await h.startRun();

    const n = h.db.tx('immediate', (r) => skipOpenSteps(r, [], runId));

    expect(n).toBe(7);
    expect(h.db.repos.steps.listForRun(runId).every((s) => s.state === 'skipped')).toBe(true);
  });
});
