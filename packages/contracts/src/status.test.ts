import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as status from './status.js';

const PAIRS: readonly (readonly [readonly string[], z.ZodEnum])[] = [
  [status.PROVIDER_IDS, status.providerIdSchema],
  [status.ROLES, status.roleSchema],
  [status.EFFORT_LEVELS, status.effortSchema],
  [status.RUN_STATUSES, status.runStatusSchema],
  [status.TERMINAL_RUN_STATUSES, status.terminalRunStatusSchema],
  [status.PAUSE_REASONS, status.pauseReasonSchema],
  [status.STEP_STATES, status.stepStateSchema],
  [status.ATTEMPT_STATES, status.attemptStateSchema],
  [status.ATTEMPT_PURPOSES, status.attemptPurposeSchema],
  [status.LEDGER_SCOPES, status.ledgerScopeSchema],
  [status.LEDGER_BUCKETS, status.ledgerBucketSchema],
  [status.LEDGER_ENTRY_TYPES, status.ledgerEntryTypeSchema],
  [status.COST_CERTAINTY, status.costCertaintySchema],
  [status.MEMORY_TYPES, status.memoryTypeSchema],
  [status.MEMORY_STATUSES, status.memoryStatusSchema],
  [status.MEMORY_EVENT_TYPES, status.memoryEventTypeSchema],
  [status.APPROVAL_DECISIONS, status.approvalDecisionSchema],
  [status.ARTIFACT_KINDS, status.artifactKindSchema],
  [status.EXCLUSION_REASONS, status.exclusionReasonSchema],
  [status.ERROR_CODES, status.errorCodeSchema],
  [status.NEXT_ACTIONS, status.nextActionSchema],
  [status.RUN_ACTIONS, status.runActionSchema],
  [status.CREDENTIAL_STORAGE_MODES, status.credentialStorageModeSchema],
  [status.RUNNER_STATES, status.runnerStateSchema],
];

describe('status enums', () => {
  it('every exported as-const array has a z.enum schema with identical members', () => {
    const arrays = Object.entries(status).filter(([k, v]) => /^[A-Z_]+$/.test(k) && Array.isArray(v));

    expect(arrays).toHaveLength(PAIRS.length);
    for (const [values, schema] of PAIRS) {
      expect(schema.options).toEqual([...values]);
      expect(new Set(values).size).toBe(values.length);
      for (const v of values) expect(schema.safeParse(v).success).toBe(true);
      expect(schema.safeParse('__not_a_member__').success).toBe(false);
    }
  });

  it('ARTIFACT_KINDS includes input_file and PAUSE_REASONS has 14 members', () => {
    expect(status.ARTIFACT_KINDS).toContain('input_file');
    expect(status.PAUSE_REASONS).toHaveLength(14);
  });

  it('terminal statuses are a subset of run statuses', () => {
    for (const s of status.TERMINAL_RUN_STATUSES) expect(status.RUN_STATUSES).toContain(s);
    expect(status.isTerminalRunStatus('completed')).toBe(true);
    expect(status.isTerminalRunStatus('paused')).toBe(false);
  });
});
