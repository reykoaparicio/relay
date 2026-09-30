import type { LedgerEntryRow } from '@relay/storage';
import { describe, expect, it } from 'vitest';
import { attemptCostCertainty, attemptsOverran } from './views.js';

function entry(attemptId: string | null, type: LedgerEntryRow['type'], delta: number): LedgerEntryRow {
  return { attemptId, type, deltaMicrousd: delta } as unknown as LedgerEntryRow;
}

describe('attemptsOverran (§9.5 actual > reservation)', () => {
  it('is true when an attempt settled more than it reserved, even far below the allowance', () => {
    const entries = [entry('att_a', 'reserve', 100), entry('att_a', 'release', -100), entry('att_a', 'settle', 150)];

    expect(attemptsOverran(entries)).toBe(true);
  });

  it('is false when every attempt settled at or below its reservation', () => {
    const entries = [entry('att_a', 'reserve', 100), entry('att_a', 'settle', 100), entry('att_b', 'reserve', 50), entry('att_b', 'settle', 10)];

    expect(attemptsOverran(entries)).toBe(false);
  });

  it('ignores run-level entries without an attempt', () => {
    expect(attemptsOverran([entry(null, 'allowance_set', 3_000_000)])).toBe(false);
  });
});

function priced(attemptId: string, bucket: LedgerEntryRow['bucket'], certainty: LedgerEntryRow['certainty'], delta = 100): LedgerEntryRow {
  const type = bucket === 'settled' ? 'settle' : bucket === 'unknown' ? 'move_to_unknown' : 'reserve';
  return { attemptId, type, bucket, certainty, deltaMicrousd: delta } as unknown as LedgerEntryRow;
}

describe('attemptCostCertainty (from the attempt settle entries)', () => {
  const id = 'att_a' as Parameters<typeof attemptCostCertainty>[1];

  it.each(['reported', 'calculated', 'estimated'] as const)('a %s settlement reads as %s', (c) => {
    expect(attemptCostCertainty([priced('att_a', 'reserved', null), priced('att_a', 'settled', c)], id)).toBe(c);
  });

  it('an unknown liability resolved by accept_estimated_charge is estimated, not calculated', () => {
    const entries = [
      priced('att_a', 'reserved', null),
      priced('att_a', 'reserved', null, -100),
      priced('att_a', 'unknown', 'unknown'),
      priced('att_a', 'unknown', null, -100),
      priced('att_a', 'settled', 'estimated'),
    ];
    expect(attemptCostCertainty(entries, id)).toBe('estimated');
  });

  it('is unknown with only unknown-bucket entries, and null with neither', () => {
    expect(attemptCostCertainty([priced('att_a', 'reserved', null), priced('att_a', 'unknown', 'unknown')], id)).toBe('unknown');
    expect(attemptCostCertainty([priced('att_a', 'reserved', null)], id)).toBeNull();
  });

  it('takes the weakest certainty when mixed and ignores other attempts', () => {
    const entries = [priced('att_a', 'settled', 'reported'), priced('att_a', 'settled', 'estimated'), priced('att_b', 'settled', 'unknown')];
    expect(attemptCostCertainty(entries, id)).toBe('estimated');
  });
});
