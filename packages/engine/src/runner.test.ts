import { afterEach, describe, expect, it } from 'vitest';
import { epochMs, errors } from '@relay/contracts';
import type { StepKey } from '@relay/contracts';
import type { StepRow } from '@relay/storage';
import { createWakeSignal } from './clock.js';
import { applyRunEvent } from './run-machine.js';
import { createEngine, createEngineFromContext, handlerKind, pickNext, selectNextStep, stepsToPromote, tick } from './runner.js';
import { snapshotOf } from './snapshot.js';
import { applyStepEvent, skipOpenSteps } from './step-machine.js';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';
import { createManualTimers } from './testing/manual-timers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const row = (stepKey: string, state: StepRow['state'], over: Partial<StepRow> = {}): StepRow =>
  ({ id: `stp_${stepKey}`, stepKey, state, notBeforeAt: null, ordinal: 0, ...over }) as unknown as StepRow;

describe('selectNextStep (pure)', () => {
  const now = epochMs(1_000);

  it('picks the first eligible ready row by ordinal', () => {
    expect(selectNextStep([row('a', 'succeeded'), row('b', 'ready'), row('c', 'ready')], now)).toEqual({ kind: 'step', step: row('b', 'ready') });
  });

  it('waits until the earliest not_before_at (backoff) instead of sleeping in F4', () => {
    expect(selectNextStep([row('a', 'ready', { notBeforeAt: epochMs(5_000) }), row('b', 'ready', { notBeforeAt: epochMs(3_000) })], now))
      .toEqual({ kind: 'wait_until', at: 3_000 });
  });

  it('reports a failed or unknown latest row as blocked_failed', () => {
    expect(selectNextStep([row('a', 'failed'), row('b', 'ready')], now).kind).toBe('blocked_failed');
    expect(selectNextStep([row('a', 'unknown')], now).kind).toBe('blocked_failed');
  });

  it('waits while an approval is open, and reports none when nothing can move', () => {
    expect(selectNextStep([row('a', 'awaiting_approval')], now)).toEqual({ kind: 'waiting' });
    expect(selectNextStep([row('a', 'succeeded'), row('b', 'pending')], now)).toEqual({ kind: 'none' });
  });
});

describe('the loop (F13)', () => {
  it('promotes steps whose dependencies all succeeded and maps handler kinds from the snapshot', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    const run = h.db.repos.runs.get(runId);
    const snap = snapshotOf(run);

    expect(stepsToPromote(h.db.repos.steps.latestPerStepKey(runId), snap).map((s) => s.stepKey)).toEqual(['intake']);
    expect(['intake', 'review', 'approve', 'finalize', 'nope'].map((k) => handlerKind(snap, k as StepKey))).toEqual(['intake', 'model', 'approval', 'finalize', null]);
  });

  it('picks running/cancelling runs before the oldest queued one', async () => {
    h = await createHarness();
    const first = await h.startRun();
    const second = await h.startRun();
    expect(pickNext(h.db.repos)?.id).toBe(first);

    h.db.tx('immediate', (r) => applyRunEvent(r, r.runs.get(second), { type: 'CHECKS_PASSED' }, h!.clock.now(), []));

    expect(pickNext(h.db.repos)?.id).toBe(second);
    expect(await tick(h.ctx)).toBe(true);
  });

  it('blocks a queued run whose provider the project no longer permits (SETUP_BLOCKED)', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    const p = h.db.repos.projects.get(h.projectId);
    h.db.repos.projects.update(h.projectId, { providerPolicy: { ...p.providerPolicy, allowedProviderIds: ['openai'] } }, p.updatedAt);

    await tick(h.ctx);

    expect(h.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'setup_blocked' }));
    expect(h.db.repos.runs.get(runId).statusDetail?.code).toBe('PERMISSION_DENIED');
  });

  it('turns a failed latest step into its pause event (safety net) and an unmovable run into failed', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    await tick(h.ctx);
    await tick(h.ctx);
    h.db.tx('immediate', (r) => {
      const review = r.steps.latestFor(runId, 'review' as StepKey);
      if (review === undefined) throw new Error('x');
      applyStepEvent(r, [], review, 'DEPS_MET');
      const ready = r.steps.get(review.id);
      applyStepEvent(r, [], ready, 'RESERVED');
      applyStepEvent(r, [], r.steps.get(review.id), 'DISPATCHING');
      applyStepEvent(r, [], r.steps.get(review.id), 'SETTLED_FAILED', { error: errors.outputInvalid() });
    });

    await tick(h.ctx);

    expect(h.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'output_invalid' }));
    const other = await h.startRun();
    await tick(h.ctx);
    await tick(h.ctx);
    h.db.tx('immediate', (r) => {
      skipOpenSteps(r, [], other);
    });
    await tick(h.ctx);
    expect(h.db.repos.runs.get(other).status).toBe('failed');
  });

  it('logs and fails the run (UNRECOVERABLE, never a crash of the loop) when a handler throws', async () => {
    h = await createHarness({ context: () => ({ assemble: () => Promise.reject(new Error('boom')) }) });
    const runId = await h.startRun();
    await tick(h.ctx);
    await tick(h.ctx);

    await tick(h.ctx);

    expect(h.db.repos.runs.get(runId).status).toBe('failed');
    expect(h.db.repos.runs.get(runId).statusDetail?.code).toBe('INTERNAL');
    expect(h.logger.entries.some((e) => e.event === 'loop.handler_threw')).toBe(true);
  });

  it('applies USER_PAUSE at the top of an iteration and waits out a backoff on the injected timers', async () => {
    h = await createHarness({ scenario: 'rate-limit-then-ok' });
    const runId = await h.startRun();
    for (let i = 0; i < 3; i += 1) await tick(h.ctx); // checks, intake, rate-limited review
    expect(h.db.repos.steps.latestFor(runId, 'review' as StepKey)?.notBeforeAt).not.toBeNull();

    const waiting = tick(h.ctx);
    h.timers.advance(1_000);
    await waiting;
    await tick(h.ctx);

    expect(h.db.repos.steps.latestFor(runId, 'review' as StepKey)?.state).toBe('succeeded');
    h.db.repos.runs.setPauseRequested(runId, true);
    await tick(h.ctx);
    expect(h.db.repos.runs.get(runId).pauseReason).toBe('user');
  });
});

describe('engine start/stop (F1)', () => {
  it('takes the lease (a second runner is refused), heartbeats, sweeps retention, and releases on stop', async () => {
    h = await createHarness();
    await h.engine.start();
    await h.engine.start(); // idempotent
    const other = createEngineFromContext({ ...h.ctx, ids: h.ids });

    await expect(other.start()).rejects.toMatchObject({ appError: { code: 'RUNNER_UNAVAILABLE' } });
    h.timers.advance(2_000); // heartbeat
    await h.engine.stop({ graceMs: 10 });
    await h.engine.stop({ graceMs: 10 }); // no-op when stopped

    await other.start();
    await other.stop({ graceMs: 10 });
  });

  it('createEngine builds its own context; handle() maps an unexpected throw to INTERNAL with a correlation id', async () => {
    h = await createHarness();
    const engine = createEngine({ ...h.ctx, projectFs: { ...h.ctx.projectFs, scan: () => { throw new Error('disk exploded'); } } });

    const res = await engine.handle('relay/v1/projects.previewRoot', { projectId: h.projectId });

    expect(res.ok ? null : res.error).toEqual(expect.objectContaining({ code: 'INTERNAL', correlationId: expect.stringMatching(/^cor_/) as unknown }));
    expect(JSON.stringify(res)).not.toContain('disk exploded');
    expect(h.logger.entries.some((e) => e.event === 'handler.threw')).toBe(true);
  });

  it('the wake signal resolves a wait early and remembers a signal sent while nobody waits', async () => {
    const timers = createManualTimers();
    const wake = createWakeSignal(timers);
    wake.signal();
    await wake.wait(10_000); // resolves immediately (pending signal)

    const w = wake.wait(10_000);
    wake.signal();
    await w;
    const t = wake.wait(50);
    timers.advance(50);
    await t;

    expect(timers.pending()).toBe(0);
  });
});
