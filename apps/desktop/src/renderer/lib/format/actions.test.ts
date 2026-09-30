import { describe, expect, it } from 'vitest';
import { UNKNOWN_OUTCOME_DECISIONS } from '@relay/contracts';
import { RUN_ACTION_LABELS, UNKNOWN_OUTCOME_DECISION_HINTS, UNKNOWN_OUTCOME_DECISION_LABELS } from './actions';

describe('unknown-outcome decision labels', () => {
  it('labels and explains every contracts decision', () => {
    for (const d of UNKNOWN_OUTCOME_DECISIONS) {
      expect(UNKNOWN_OUTCOME_DECISION_LABELS[d]).not.toBe('');
      expect(UNKNOWN_OUTCOME_DECISION_HINTS[d]).not.toBe('');
    }
  });

  it('says the retry may incur another charge (§4.4)', () => {
    expect(UNKNOWN_OUTCOME_DECISION_LABELS.retry_acknowledging_charge).toMatch(/may incur another charge/);
  });
});

describe('RUN_ACTION_LABELS', () => {
  it('names the approval decisions the way ApprovalCard shows them', () => {
    expect(RUN_ACTION_LABELS.approve).toBe('Approve plan');
    expect(RUN_ACTION_LABELS.request_revision).toBe('Request revision');
    expect(RUN_ACTION_LABELS.reject).toBe('Reject plan');
  });
});
