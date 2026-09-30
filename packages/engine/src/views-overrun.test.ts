import type { LedgerEntryRow } from '@relay/storage';
import { describe, expect, it } from 'vitest';
import { attemptsOverran } from './views.js';

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
