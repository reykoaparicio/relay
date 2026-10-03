import { describe, expect, it } from 'vitest';
import { recoveryHint } from './overview-model';

describe('recoveryHint', () => {
  it('calls an interrupted run interrupted', () => {
    expect(recoveryHint({ status: 'interrupted', pauseReason: null })).toBe('1 interrupted run needs a decision');
  });

  it('never calls a run paused on an uncertain request "interrupted"', () => {
    const hint = recoveryHint({ status: 'paused', pauseReason: 'unknown_outcome' });
    expect(hint).toBe('1 paused run needs a decision: the last request may not have completed');
    expect(hint).not.toMatch(/interrupt/i);
  });
});
