// 11 §K6 limits (FR-05, @m3). (a) maxAttempts → LIMIT_REACHED, paused(limit_attempts) → raise_limits → completes.
// (b) the execution deadline counts only running time: 20 min spent awaiting approval never fires it (manual clock).
// (c) a hanging step past the remaining execution time → abort + paused(deadline), attempt unknown with U = N →
// raise_limits. (d) maxConcurrentSteps = 1: two queued runs never run at the same time.
import { afterEach, describe, expect, it } from 'vitest';
import type { RunId } from '@relay/contracts';
import { expectNoNegativeReserved } from '../helpers/assert-ledger.js';
import { createHarness, sleep } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { createManualClock } from '../helpers/manual-clock.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';
import { expectedEstimate } from './uncertain-estimate.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

const settled = (r: { status: string }) => !['queued', 'running'].includes(r.status);

/** [start, end) intervals the run spent `running`, from its run.status_changed events. */
function runningIntervals(x: Harness, runId: RunId): [number, number][] {
  const out: [number, number][] = [];
  let since: number | null = null;
  for (const e of x.db.repos.events.list(runId, 0, 1000)) {
    if (e.type !== 'run.status_changed') continue;
    const to = (e.payload as { to: string }).to;
    if (to === 'running' && since === null) since = e.at;
    else if (to !== 'running' && since !== null) {
      out.push([since, e.at]);
      since = null;
    }
  }
  if (since !== null) out.push([since, Number.MAX_SAFE_INTEGER]);
  return out;
}

describe('limits @m3', () => {
  it('(a) maxAttempts = 3 → LIMIT_REACHED, paused(limit_attempts) → raise_limits({ maxAttempts: 6 }) → RESUME_RESOLVED → completes @m3', async () => {
    h = await createHarness({ limits: { maxAttempts: 3 } });
    const runId = await h.startRun();
    await h.waitFor(runId, 'awaiting_approval');
    await h.approve(runId);

    const paused = await h.waitFor(runId, settled);

    expect([paused.status, paused.pauseReason]).toEqual(['paused', 'limit_attempts']);
    expect(paused.statusDetail?.code).toBe('LIMIT_REACHED');
    expect(h.db.repos.attempts.listForRun(runId)).toHaveLength(3);
    expect(h.calls({ runId, stepKey: 'verify' })).toEqual([]);

    const raised = await h.resume(runId, { kind: 'raise_limits', maxAttempts: 6 });
    expect(raised.ok && ['queued', 'running']).toContain(raised.ok ? raised.data.status : null);
    expect((await h.waitFor(runId, settled)).status).toBe('completed');
    expect(h.db.repos.runs.get(runId).limits.maxAttempts).toBe(6);
    expect(h.db.repos.attempts.listForRun(runId)).toHaveLength(4);
  });

  it('(b) 60 s deadline + 20 min waiting for approval (manual clock) → no deadline; execution_ms_used excludes the wait; approve → continues @m3', async () => {
    const mc = createManualClock();
    h = await createHarness({ clock: mc, limits: { executionTimeoutSeconds: 60 } });
    const runId = await h.startRun();
    await h.waitFor(runId, 'awaiting_approval');
    const usedBefore = h.db.repos.runs.get(runId).executionMsUsed;

    mc.advance(20 * 60 * 1000);
    await sleep(50);

    const waiting = h.db.repos.runs.get(runId);
    expect(waiting.status).toBe('awaiting_approval');
    expect(waiting.executionMsUsed).toBe(usedBefore);
    expect(waiting.executionMsUsed).toBeLessThan(60_000);
    await h.approve(runId);
    const done = await h.waitFor(runId, settled);
    expect(done.status).toBe('completed');
    expect(done.executionMsUsed).toBeLessThan(60_000);
  });

  it('(c) a hanging step past the remaining execution time → abort + paused(deadline), attempt uncertain and settled as an estimate (U = 0) → raise_limits → RESUME_RESOLVED @m3', async () => {
    const mc = createManualClock();
    h = await createHarness({ scenario: 'hang', clock: mc, limits: { executionTimeoutSeconds: 60 } });
    const runId = await h.startRun();
    await h.waitUntil(() => h!.attempts(runId, 'review')[0]?.state === 'dispatching', 10_000, 'review in flight');

    mc.advance(61_000);
    const paused = await h.waitFor(runId, settled);

    expect([paused.status, paused.pauseReason]).toEqual(['paused', 'deadline']);
    const [a] = h.attempts(runId, 'review');
    expect(a?.state).toBe('unknown');
    expect(h.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: 0, C: expectedEstimate(a!, 0) }));
    expect(h.calls({ runId })).toHaveLength(1);

    const raised = await h.resume(runId, { kind: 'raise_limits', executionTimeoutSeconds: 600 });

    expect(raised.ok ? raised.data.status : raised.error.code).not.toBe('paused');
    expect(h.db.repos.runs.get(runId).limits.executionTimeoutSeconds).toBe(600);
    const next = await h.waitFor(runId, settled);
    // The uncertain attempt still needs the user's retry (never silently retried): retry_step / stop.
    expect(h.calls({ runId, stepKey: 'review' })).toHaveLength(1);
    expect(next.status).toBe('paused');
    expect(next.pauseReason).toBe('unknown_outcome');
    expectNoNegativeReserved(h.db);
  });

  // Referee wave 3, finding 2: a step failed at attemptCount == maxAttempts used to refuse retry_step / choose_profile
  // (LIMIT_REACHED) while raise_limits was refused for its pause reason — no working action. The retry now reaches
  // the reserve checkpoint, which pauses limit_attempts, from which raise_limits continues.
  it.each([
    ['retry_step', false],
    ['choose_profile', true],
  ] as const)('(e) output_invalid at attemptCount == maxAttempts (malformed-twice, maxAttempts 2) → %s → paused(limit_attempts) → raise_limits → completes @m3', async (_label, withProfile) => {
    h = await createHarness({ scenario: 'malformed-twice', limits: { maxAttempts: 2 } });
    const x = h;
    const runId = await x.startRun();
    const failed = await x.waitFor(runId, settled);
    expect([failed.status, failed.pauseReason, failed.attemptCount]).toEqual(['paused', 'output_invalid', 2]);
    const economy = x.db.repos.profiles.getByName('Economy');

    const retried = await x.retryStep(runId, 'review', withProfile ? { profileId: economy!.id } : {});

    expect(retried.ok ? null : retried.error).toBeNull();
    const limited = await x.waitFor(runId, (r) => r.status === 'paused' && r.pauseReason === 'limit_attempts');
    expect(limited.attemptCount).toBe(2);
    const raised = await x.resume(runId, { kind: 'raise_limits', maxAttempts: 10 });
    expect(raised.ok ? null : raised.error).toBeNull();
    await x.waitFor(runId, 'awaiting_approval');
    await x.approve(runId);
    expect((await x.waitFor(runId, settled)).status).toBe('completed');
    if (withProfile) expect(x.steps(runId, 'review').at(-1)?.profileName).toBe('Economy');
    expectNoNegativeReserved(x.db);
  });

  it('(d) maxConcurrentSteps = 1: two queued runs execute sequentially (running intervals never overlap) @m3', async () => {
    h = await createHarness();
    const a = await h.startRun({ key: 'concurrency-run-a-01' });
    const b = await h.startRun({ key: 'concurrency-run-b-01' });
    await h.waitFor(a, 'awaiting_approval');
    await h.waitFor(b, 'awaiting_approval');
    await h.approve(a);
    await h.approve(b);
    await h.waitFor(a, 'completed');
    await h.waitFor(b, 'completed');

    const ia = runningIntervals(h, a);
    const ib = runningIntervals(h, b);
    expect(ia.length).toBeGreaterThan(0);
    expect(ib.length).toBeGreaterThan(0);
    for (const [s1, e1] of ia) for (const [s2, e2] of ib) expect(s1 < e2 && s2 < e1, `overlap ${String([s1, e1])} ${String([s2, e2])}`).toBe(false);
    const attempts = [...h.db.repos.attempts.listForRun(a), ...h.db.repos.attempts.listForRun(b)].sort((x, y) => (x.dispatchedAt ?? 0) - (y.dispatchedAt ?? 0));
    for (let i = 1; i < attempts.length; i += 1) expect(attempts[i]!.dispatchedAt!).toBeGreaterThanOrEqual(attempts[i - 1]!.finishedAt!);
  });
});
