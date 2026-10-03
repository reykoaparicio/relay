import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_STATES,
  COST_CERTAINTY,
  MEMORY_STATUSES,
  NEXT_ACTIONS,
  PAUSE_REASONS,
  RUN_ACTIONS,
  RUN_STATUSES,
  STEP_STATES,
} from '@relay/contracts';
import { NEXT_ACTION_LABELS, RUN_ACTION_LABELS } from './actions';
import { statusPresentation } from './status-presentation';
import type { StatusPresentation } from './status-presentation';

function expectComplete(p: StatusPresentation) {
  expect(p.label.trim()).not.toBe('');
  expect(typeof p.icon === 'function' || typeof p.icon === 'object').toBe(true);
}

describe('statusPresentation', () => {
  it.each(RUN_STATUSES)('run status %s has a label and an icon', (status) => {
    expectComplete(statusPresentation('run', status));
  });

  it.each(PAUSE_REASONS)('paused + %s has its own label, icon, and tone', (reason) => {
    const p = statusPresentation('run', 'paused', reason);

    expectComplete(p);
    expect(p).toBe(statusPresentation('pause', reason));
  });

  it('gives every pause reason a distinct label', () => {
    const labels = new Set(PAUSE_REASONS.map((r) => statusPresentation('pause', r).label));

    expect(labels.size).toBe(PAUSE_REASONS.length);
  });

  it.each(['failed', 'cancelled', 'interrupted', 'incomplete'] as const)('run %s has a visible detail sentence', (status) => {
    expect(statusPresentation('run', status).detail?.trim()).toBeTruthy();
  });

  it.each(PAUSE_REASONS.filter((r) => r !== 'user'))('pause reason %s has a visible detail sentence', (reason) => {
    expect(statusPresentation('pause', reason).detail?.trim()).toBeTruthy();
  });

  it('keeps failed visually distinct from every recoverable pause', () => {
    const failedTone = statusPresentation('run', 'failed').tone;

    expect(failedTone).toBe('danger');
    for (const reason of PAUSE_REASONS) expect(statusPresentation('pause', reason).tone).not.toBe('danger');
  });

  it('marks the unknown-outcome pause with the unknown tone (not red or green)', () => {
    expect(statusPresentation('pause', 'unknown_outcome').tone).toBe('unknown');
  });

  it('renders a generic paused label when the reason is missing', () => {
    expect(statusPresentation('run', 'paused', null).label).toBe('Paused');
  });

  it.each(STEP_STATES)('step state %s has a label and an icon', (s) => {
    expectComplete(statusPresentation('step', s));
  });

  it.each(ATTEMPT_STATES)('attempt state %s has a label and an icon', (s) => {
    expectComplete(statusPresentation('attempt', s));
  });

  it.each(MEMORY_STATUSES)('memory status %s has a label and an icon', (s) => {
    expectComplete(statusPresentation('memory', s));
  });

  it.each(COST_CERTAINTY)('cost certainty %s has a label and an icon', (s) => {
    expectComplete(statusPresentation('certainty', s));
  });

  it('words the unknown_outcome pause plainly: retry (may charge again) or stop', () => {
    const p = statusPresentation('run', 'paused', 'unknown_outcome');

    expect(p.label).toBe('Paused: request may not have completed');
    expect(p.detail).toBe('Retry the step (this may charge again) or stop');
  });

  it('labels estimated cost "Estimated", and the legacy unknown certainty as an estimate too', () => {
    expect(statusPresentation('certainty', 'estimated').label).toBe('Estimated');
    expect(statusPresentation('certainty', 'unknown').label).toBe('Estimated');
  });

  it('never shows "unknown" in any certainty, attempt, step or pause label or detail (decision 1)', () => {
    const all = [
      ...COST_CERTAINTY.map((c) => statusPresentation('certainty', c)),
      ...ATTEMPT_STATES.map((a) => statusPresentation('attempt', a)),
      ...STEP_STATES.map((st) => statusPresentation('step', st)),
      ...PAUSE_REASONS.map((r) => statusPresentation('pause', r)),
    ];
    for (const p of all) {
      expect(p.label).not.toMatch(/unknown/i);
      expect(p.detail ?? '').not.toMatch(/unknown/i);
    }
  });
});

describe('action labels', () => {
  it('has a non-empty label for every NEXT_ACTIONS and RUN_ACTIONS value', () => {
    for (const a of NEXT_ACTIONS) expect(NEXT_ACTION_LABELS[a]).toBeTruthy();
    for (const a of RUN_ACTIONS) expect(RUN_ACTION_LABELS[a]).toBeTruthy();
  });
});
