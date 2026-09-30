import { afterEach, describe, expect, it } from 'vitest';
import { epochMs } from '@relay/contracts';
import type { RunId, StepKey } from '@relay/contracts';
import { executeModelAttempt } from './checkpoints.js';
import { deadlineReached, executionMsAt, remainingExecutionMs } from './deadline.js';
import { stepsToPromote, tick } from './runner.js';
import { snapshotOf } from './snapshot.js';
import { applyStepEvent } from './step-machine.js';
import { createHarness } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const LIMITS = { executionTimeoutSeconds: 60 } as const;

async function runningRun(o: HarnessOptions = {}): Promise<{ harness: Harness; runId: RunId }> {
  const harness = await createHarness(o);
  h = harness;
  const wf = harness.db.repos.workflows.listWorkflows()[0];
  const started = await harness.engine.handle('relay/v1/runs.start', {
    idempotencyKey: 'deadline-run-0001', projectId: harness.projectId, workflowId: wf?.id ?? '', workflowVersion: 1, goal: 'g',
    input: { kind: 'files', relPaths: ['src/lib/format.ts'] }, limitOverrides: LIMITS,
  });
  if (!started.ok) throw new Error(started.error.code);
  await tick(harness.ctx);
  return { harness, runId: started.data.runId };
}

describe('deadline (F12)', () => {
  it('computes used / remaining execution time including the open segment', () => {
    const run = { executionMsUsed: 10_000, runningSince: epochMs(1_000), limits: { executionTimeoutSeconds: 60 } } as Parameters<typeof deadlineReached>[0];

    expect(executionMsAt(run, epochMs(6_000))).toBe(15_000);
    expect(remainingExecutionMs(run, epochMs(6_000))).toBe(45_000);
    expect(deadlineReached(run, epochMs(50_999))).toBe(false);
    expect(deadlineReached(run, epochMs(51_000))).toBe(true);
    expect(remainingExecutionMs({ ...run, runningSince: null }, epochMs(0))).toBe(50_000);
  });

  it('fires with nothing in flight: paused(deadline)', async () => {
    const { harness, runId } = await runningRun();

    harness.timers.advance(60_000);
    await harness.waitFor(() => harness.db.repos.runs.get(runId).status === 'paused');

    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ pauseReason: 'deadline', executionMsUsed: 60_000 }));
    const detail = await harness.engine.handle('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.availableActions).toEqual(['raise_limits', 'stop']);
  });

  it('does not count time spent awaiting approval (20 min on manual timers)', async () => {
    const { harness, runId } = await runningRun();
    for (let i = 0; i < 20 && harness.db.repos.runs.get(runId).status !== 'awaiting_approval'; i += 1) await tick(harness.ctx);
    const used = harness.db.repos.runs.get(runId).executionMsUsed;

    harness.timers.advance(20 * 60_000);
    await Promise.resolve();

    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'awaiting_approval', executionMsUsed: used }));
    expect(harness.timers.pending()).toBe(0); // the segment timer was cleared on leaving `running`
  });

  it('fires during a hang: the call is aborted, the full N becomes unknown, and the run pauses as deadline', async () => {
    const { harness, runId } = await runningRun({ scenario: { name: 'hang-anything', steps: [{ match: { stepKey: 'review' }, result: { kind: 'hang' } }] } });
    await tick(harness.ctx); // intake
    harness.db.tx('immediate', (r) => {
      for (const s of stepsToPromote(r.steps.latestPerStepKey(runId), snapshotOf(r.runs.get(runId)))) applyStepEvent(r, [], s, 'DEPS_MET');
    });
    const review = harness.db.repos.steps.latestFor(runId, 'review' as StepKey);

    const pending = executeModelAttempt(harness.ctx, runId, review?.id ?? ('' as never));
    await harness.waitFor(() => harness.db.repos.attempts.listForRun(runId)[0]?.state === 'dispatching');
    harness.timers.advance(60_000);
    await pending;

    const [a] = harness.db.repos.attempts.listForRun(runId);
    expect(a?.state).toBe('unknown');
    expect(harness.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: a?.reservationMicrousd }));
    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'deadline' }));
  });
});
