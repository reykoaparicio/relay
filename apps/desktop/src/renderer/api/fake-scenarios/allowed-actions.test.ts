// U-4: the fake bridge exposes exactly the engine's F2 actions — both use the contracts truth table; this checks the
// fake's mapping of its facts over every status × pause reason × fact combination.
import { describe, expect, it } from 'vitest';
import { PAUSE_REASONS, RUN_STATUSES, allowedRunActions as engineTable } from '@relay/contracts';
import { allowedRunActions as fake } from './allowed-actions';

describe('fake allowedRunActions vs the engine truth table', () => {
  it('agree for every status, pause reason and fact', () => {
    const diffs: string[] = [];
    const bools = [true, false];
    for (const status of RUN_STATUSES) {
      for (const pauseReason of status === 'paused' ? PAUSE_REASONS : [null]) {
        for (const hasFailedStep of bools) {
          for (const hasPatchArtifact of bools) {
            for (const hasRetryableStep of bools) {
              for (const missingCredential of bools) {
                const facts = { hasFailedStep, hasPatchArtifact, hasRetryableStep, missingCredential };
                const e = engineTable({ status, pauseReason }, { unknownAttempts: 0, ...facts });
                const f = fake(status, pauseReason, { uncertainAttempts: 1, ...facts });
                if (JSON.stringify(e) !== JSON.stringify(f)) diffs.push(`${status}/${String(pauseReason)} ${JSON.stringify(facts)}: engine=${e.join(',')} fake=${f.join(',')}`);
              }
            }
          }
        }
      }
    }
    expect(diffs).toEqual([]);
  });

  it('paused(unknown_outcome): retry_step while a step is retryable, resume once none is left', () => {
    const facts = { uncertainAttempts: 1, hasFailedStep: false, hasPatchArtifact: false };
    expect(fake('paused', 'unknown_outcome', { ...facts, hasRetryableStep: true })).toEqual(['retry_step', 'stop', 'export_report']);
    expect(fake('paused', 'unknown_outcome', { ...facts, hasRetryableStep: false })).toEqual(['resume', 'stop', 'export_report']);
  });
});
