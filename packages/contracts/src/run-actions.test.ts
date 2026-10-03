import { describe, expect, it } from 'vitest';
import { allowedRunActions } from './run-actions.js';
import { PAUSE_REASONS, RUN_STATUSES } from './status.js';

const NONE = { unknownAttempts: 0, hasFailedStep: false, hasPatchArtifact: false };

describe('allowedRunActions (06 F2, shared by the engine and the fake bridge)', () => {
  it('offers export_report in every state, and export_patch only with an exportable patch', () => {
    for (const status of RUN_STATUSES) {
      for (const pauseReason of status === 'paused' ? [...PAUSE_REASONS, null] : [null]) {
        expect(allowedRunActions({ status, pauseReason }, NONE)).toContain('export_report');
        expect(allowedRunActions({ status, pauseReason }, NONE)).not.toContain('export_patch');
        expect(allowedRunActions({ status, pauseReason }, { ...NONE, hasPatchArtifact: true }).slice(-2)).toEqual(['export_report', 'export_patch']);
      }
    }
  });

  it('every pause has a non-stop way out; unknown_outcome switches to resume when nothing is retryable', () => {
    for (const pauseReason of PAUSE_REASONS) {
      for (const hasRetryableStep of [true, false]) {
        const actions = allowedRunActions({ status: 'paused', pauseReason }, { ...NONE, hasRetryableStep });
        expect(actions.filter((a) => a !== 'stop' && !a.startsWith('export')).length, pauseReason).toBeGreaterThan(0);
      }
    }
    expect(allowedRunActions({ status: 'paused', pauseReason: 'unknown_outcome' }, { ...NONE, hasRetryableStep: false })).toEqual(['resume', 'stop', 'export_report']);
    expect(allowedRunActions({ status: 'paused', pauseReason: 'unknown_outcome' }, NONE)).toEqual(['retry_step', 'stop', 'export_report']);
    expect(allowedRunActions({ status: 'paused', pauseReason: null }, NONE)).toEqual(['stop', 'export_report']);
  });

  it('hides choose_profile when no profile can be chosen', () => {
    expect(allowedRunActions({ status: 'paused', pauseReason: 'model_refused' }, { ...NONE, hasProfileOptions: false })).toEqual(['retry_step', 'stop', 'export_report']);
  });
});
