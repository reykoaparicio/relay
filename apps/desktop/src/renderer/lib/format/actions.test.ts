import { describe, expect, it } from 'vitest';
import { NEXT_ACTIONS, RUN_ACTIONS } from '@relay/contracts';
import { NEXT_ACTION_LABELS, RUN_ACTION_DONE_LABELS, RUN_ACTION_LABELS } from './actions';

describe('no "unknown" money wording (decision 1)', () => {
  it('never labels an action, its outcome, or a next action with "unknown"', () => {
    for (const a of RUN_ACTIONS) {
      expect(RUN_ACTION_LABELS[a]).not.toMatch(/unknown/i);
      expect(RUN_ACTION_DONE_LABELS[a]).not.toMatch(/unknown/i);
    }
    for (const n of NEXT_ACTIONS) expect(NEXT_ACTION_LABELS[n]).not.toMatch(/unknown/i);
  });
});

describe('RUN_ACTION_LABELS', () => {
  it('names the approval decisions the way ApprovalCard shows them', () => {
    expect(RUN_ACTION_LABELS.approve).toBe('Approve plan');
    expect(RUN_ACTION_LABELS.request_revision).toBe('Request revision');
    expect(RUN_ACTION_LABELS.reject).toBe('Reject plan');
  });
});

describe('RUN_ACTION_DONE_LABELS', () => {
  it('states the outcome of every action, never "<button label>: done"', () => {
    for (const a of RUN_ACTIONS) {
      expect(RUN_ACTION_DONE_LABELS[a]).not.toBe('');
      expect(RUN_ACTION_DONE_LABELS[a]).not.toMatch(/: done$/);
    }
    expect(RUN_ACTION_DONE_LABELS.approve).toBe('Plan approved');
  });

  it('calls asynchronous stops requests, not completed facts', () => {
    expect(RUN_ACTION_DONE_LABELS.pause).toBe('Pause requested');
    expect(RUN_ACTION_DONE_LABELS.cancel).toBe('Cancellation requested');
  });
});
