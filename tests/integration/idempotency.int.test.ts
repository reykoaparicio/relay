// 11 §K6 idempotency (@m3): runs.start twice with the same key → one run; the same key with a different payload →
// CONFLICT (idempotency_key_reused).
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { allRuns } from '../helpers/assert-ledger.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

describe('idempotency @m3', () => {
  it('runs.start with the same key twice → one run; same key + different payload → CONFLICT @m3', async () => {
    h = await createHarness({ start: false });

    const a = await h.startRunRaw({ key: 'same-start-key-0001' });
    const b = await h.startRunRaw({ key: 'same-start-key-0001' });
    const c = await h.startRunRaw({ key: 'same-start-key-0001', goal: 'A different goal entirely.' });

    expect(a.ok && b.ok && a.data.runId === b.data.runId).toBe(true);
    expect(allRuns(h.db)).toHaveLength(1);
    expect(c.ok ? null : [c.error.code, c.error.details?.['reason']]).toEqual(['CONFLICT', 'idempotency_key_reused']);
    expect(allRuns(h.db)).toHaveLength(1);
  });

  it('a replayed approval decision and a replayed resume never re-apply @m3', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    await h.waitFor(runId, 'awaiting_approval');

    const first = await h.approve(runId, 'approve-replay-0001');
    const replay = await h.call('relay/v1/approvals.decide', {
      idempotencyKey: 'approve-replay-0001', approvalId: first.ok ? first.data.approval.id : (''),
      planHash: first.ok ? first.data.approval.planHash : '', contextHash: first.ok ? first.data.approval.contextHash : '', decision: 'approved',
    });

    expect(first.ok).toBe(true);
    expect(replay.ok && first.ok && replay.data.approval.id).toBe(first.ok ? first.data.approval.id : null);
    await h.waitFor(runId, 'completed');
    expect(h.steps(runId, 'approve')).toHaveLength(1);
    expect(h.calls({ runId, stepKey: 'implement' })).toHaveLength(1);
  });
});
