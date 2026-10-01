import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { err, errors, microusd, upperBound } from '@relay/contracts';
import type { RunId, StepKey, StepRunId } from '@relay/contracts';
import { FAKE_FIXTURES, createMemoryCallLog, createProviderRegistry } from '@relay/providers';
import type { ProviderRegistry } from '@relay/providers';
import type { Db, Repos } from '@relay/storage';
import { onWorkStopped } from './cancellation.js';
import { executeModelAttempt } from './checkpoints.js';
import { fromUtf8 } from './hash.js';
import type { CrashHookCtx, EngineCtx } from './ports.js';
import { findProfileByName } from './profiles.js';
import { applyRunEvent } from './run-machine.js';
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

const REVIEW = 'review' as StepKey;

/** Queued → running → intake done → review promoted to `ready`. */
async function readyReview(o: HarnessOptions = {}, run: { budgetMicrousd?: number | ((x: Harness) => number) } = {}): Promise<{ harness: Harness; runId: RunId; stepRunId: StepRunId }> {
  const harness = await createHarness(o);
  h = harness;
  const budget = typeof run.budgetMicrousd === 'function' ? run.budgetMicrousd(harness) : run.budgetMicrousd;
  const runId = await harness.startRun(budget === undefined ? {} : { budgetMicrousd: budget });
  await tick(harness.ctx); // runChecks → running
  await tick(harness.ctx); // intake
  harness.db.tx('immediate', (r) => {
    for (const s of stepsToPromote(r.steps.latestPerStepKey(runId), snapshotOf(r.runs.get(runId)))) applyStepEvent(r, [], s, 'DEPS_MET');
  });
  const step = harness.db.repos.steps.latestFor(runId, REVIEW);
  if (step?.state !== 'ready') throw new Error('review not ready');
  return { harness, runId, stepRunId: step.id };
}

/** The review step's minimum reservation (output allowance only): the loop's queued check admits any L ≥ this. */
function reviewMinimum(x: Harness): number {
  const r = x.db.repos;
  const wf = r.workflows.listWorkflows()[0];
  const step = wf === undefined ? undefined : r.workflows.getVersion(wf.id, 1)?.spec.steps.find((s) => s.id === REVIEW);
  const profile = step?.kind === 'model' ? findProfileByName(r, step.profile) : undefined;
  const entry = profile === undefined ? undefined : r.catalog.get(profile.providerId, profile.modelId);
  if (step?.kind !== 'model' || profile === undefined || entry === undefined) throw new Error('review profile');
  return upperBound(0, step.maxOutputTokens ?? profile.params.maxOutputTokens, entry.prices);
}

function ledgerOf(r: Repos, runId: RunId) {
  const page = r.ledger.list(runId, { limit: 100, sort: 'created_asc' });
  if (!page.ok) throw new Error('ledger');
  return page.value.items;
}

/** A Db whose `n`-th tx after `arm()` misbehaves (`throwBefore`: never runs fn; `throwAfter`: runs fn, then throws → rollback). */
function faultyDb(db: Db, mode: 'throwBefore' | 'throwAfter', n: number): Db & { arm(): void } {
  let armed = false;
  let count = 0;
  return {
    ...db,
    repos: db.repos,
    arm() {
      armed = true;
    },
    tx(txMode, fn) {
      if (armed) count += 1;
      if (armed && count === n) {
        if (mode === 'throwBefore') throw new Error('injected tx failure');
        return db.tx(txMode, (r) => {
          fn(r);
          throw new Error('injected mid-tx failure');
        });
      }
      return db.tx(txMode, fn);
    },
  };
}

function withRegistry(o: Parameters<typeof createProviderRegistry>[0]): (base: ProviderRegistry) => ProviderRegistry {
  return () => createProviderRegistry(o);
}

describe('executeModelAttempt (§7.4)', () => {
  it('happy path writes reservation, dispatch intent, artifacts, and settlement in F4 order', async () => {
    const { harness, runId, stepRunId } = await readyReview();
    const before = harness.db.repos.events.lastSeq(runId);

    const out = await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(out).toEqual(expect.objectContaining({ kind: 'settled', outcome: 'valid', plan: 'succeed' }));
    const types = harness.db.repos.events.list(runId, before, 100).map((e) => (e.type === 'step.state_changed' ? `step:${String(e.payload['to'])}` : e.type));
    expect(types).toEqual([
      'step:reserved', 'attempt.created', 'ledger.reserved', 'step:executing', 'attempt.dispatching',
      'artifact.created', 'artifact.created', 'artifact.created', 'attempt.settled', 'step:succeeded',
    ]);
    const [attempt] = harness.db.repos.attempts.listForStep(stepRunId);
    expect(attempt).toEqual(expect.objectContaining({ seq: 1, purpose: 'initial', state: 'succeeded', retryOfAttemptId: null }));
    expect(attempt?.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(attempt?.providerResponseId).toBe(`fake_resp_${String(attempt?.id)}`);
    const moves = ledgerOf(harness.db.repos, runId).filter((e) => e.attemptId === attempt?.id);
    expect(moves.map((e) => e.type)).toEqual(['reserve', 'release', 'settle']);
    expect(moves[1]?.groupId).toBe(moves[2]?.groupId);
    expect(moves[0]?.groupId).not.toBe(moves[1]?.groupId);
    const kinds = harness.db.repos.artifacts.listForRun(runId).filter((a) => a.attemptId === attempt?.id).map((a) => [a.kind, a.mediaType]);
    expect(kinds).toEqual([['raw_response', 'application/json'], ['context_manifest', 'application/json'], ['findings', 'application/json']]);
    const step = harness.db.repos.steps.get(stepRunId);
    expect(step.outcome).toBe('findings');
    expect(harness.db.repos.ledger.runBalances(runId).R).toBe(0);
    const call = harness.callLog.entries()[0];
    expect(call).toEqual(expect.objectContaining({ stepKey: 'review', purpose: 'initial', runId, attemptId: attempt?.id }));
  });

  it('never creates an attempt row when the credential is missing, and pauses auth_required', async () => {
    const { harness, runId, stepRunId } = await readyReview({ credentials: { resolve: () => Promise.resolve(err(errors.authRequired('anthropic'))) } });

    const out = await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(out).toEqual({ kind: 'blocked', why: 'paused' });
    expect(harness.db.repos.attempts.listForRun(runId)).toEqual([]);
    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'auth_required' }));
    expect(harness.callLog.entries()).toEqual([]);
  });

  it('honours pause_requested observed inside the step-2 tx (no attempt row)', async () => {
    const box: { target?: RunId } = {};
    const { harness, runId, stepRunId } = await readyReview({
      hooks: { beforeReservationTx: () => { if (box.target !== undefined) h?.db.repos.runs.setPauseRequested(box.target, true); } },
    });
    box.target = runId;

    const out = await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(out).toEqual({ kind: 'blocked', why: 'paused' });
    expect(harness.db.repos.attempts.listForRun(runId)).toEqual([]);
    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'user', pauseRequested: false }));
  });

  it('creates no attempt when the run became cancelling before the reservation', async () => {
    const box: { target?: RunId } = {};
    const { harness, runId, stepRunId } = await readyReview({
      hooks: {
        beforeReservationTx: () => {
          const x = h;
          if (x === undefined || box.target === undefined) return;
          x.db.tx('immediate', (r) => applyRunEvent(r, r.runs.get(box.target as RunId), { type: 'CANCEL_REQUESTED' }, x.clock.now(), []));
        },
      },
    });
    box.target = runId;

    const out = await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(out).toEqual({ kind: 'blocked', why: 'not_running' });
    expect(harness.db.repos.attempts.listForRun(runId)).toEqual([]);
  });

  it('re-checks attemptCount < maxAttempts inside the step-2 tx', async () => {
    const box: { target?: RunId } = {};
    const { harness, runId, stepRunId } = await readyReview({
      hooks: {
        beforeReservationTx: () => {
          if (h === undefined || box.target === undefined) return;
          for (let i = 0; i < 10; i += 1) h.db.repos.runs.incrementAttemptCount(box.target);
        },
      },
    });
    box.target = runId;

    await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(harness.db.repos.attempts.listForRun(runId)).toEqual([]);
    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'limit_attempts' }));
  });

  it('does not call the provider when the dispatching tx fails', async () => {
    const { harness, runId, stepRunId } = await readyReview();
    const db = faultyDb(harness.db, 'throwBefore', 2);
    const ctx: EngineCtx = { ...harness.ctx, db, hooks: { beforeReservationTx: () => { db.arm(); } } };

    await expect(executeModelAttempt(ctx, runId, stepRunId)).rejects.toThrow('injected tx failure');

    expect(harness.callLog.entries()).toEqual([]);
    expect(harness.db.repos.attempts.listForRun(runId).map((a) => a.state)).toEqual(['reserved']); // recovery releases it
  });

  it('keeps the settlement group atomic: a throw mid step-7 leaves no partial entries and forces unknown', async () => {
    const { harness, runId, stepRunId } = await readyReview();
    const db = faultyDb(harness.db, 'throwAfter', 4); // reserve, dispatching, onResponseId, settle
    const ctx: EngineCtx = { ...harness.ctx, db, hooks: { beforeReservationTx: () => { db.arm(); } } };

    await expect(executeModelAttempt(ctx, runId, stepRunId)).rejects.toThrow('injected mid-tx failure');

    const [attempt] = harness.db.repos.attempts.listForRun(runId);
    expect(attempt?.state).toBe('unknown');
    const types = ledgerOf(harness.db.repos, runId).filter((e) => e.attemptId === attempt?.id).map((e) => e.type);
    expect(types).toEqual(['reserve', 'move_to_unknown', 'move_to_unknown']);
    const b = harness.db.repos.ledger.runBalances(runId);
    expect(b.R).toBe(0);
    expect(b.U).toBe(attempt?.reservationMicrousd);
    expect(harness.db.repos.artifacts.listForRun(runId).filter((a) => a.attemptId === attempt?.id)).toEqual([]);
    expect(harness.db.repos.runs.get(runId).pauseReason).toBe('unknown_outcome');
  });

  it('invokes the crash hooks in order with { attemptId, stepKey, purpose, attemptSeq }', async () => {
    const calls: [string, CrashHookCtx][] = [];
    const rec = (name: string) => (c: CrashHookCtx) => calls.push([name, c]);
    const { harness, runId, stepRunId } = await readyReview({
      hooks: { beforeReservationTx: rec('before'), afterDispatchIntent: rec('intent'), afterProviderResponse: rec('response'), afterStepCommit: rec('commit') },
    });

    await executeModelAttempt(harness.ctx, runId, stepRunId);

    const attemptId = harness.db.repos.attempts.listForRun(runId)[0]?.id;
    expect(calls.map(([n]) => n)).toEqual(['before', 'intent', 'response', 'commit']);
    expect(calls[0]?.[1]).toEqual({ stepKey: 'review', purpose: 'initial', attemptSeq: 1 });
    for (const [, c] of calls.slice(1)) expect(c).toEqual({ stepKey: 'review', purpose: 'initial', attemptSeq: 1, attemptId });
  });

  it('releases an attempt aborted after the dispatch intent but before generate (failed_before_dispatch)', async () => {
    const box: { target?: RunId } = {};
    const { harness, runId, stepRunId } = await readyReview({ hooks: { afterDispatchIntent: () => { if (box.target !== undefined) h?.ctx.cancellation.abortRun(box.target, { kind: 'cancel' }); } } });
    box.target = runId;

    const out = await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(out).toEqual(expect.objectContaining({ outcome: 'not_sent', plan: 'release' }));
    expect(harness.callLog.entries()).toEqual([]);
    const [attempt] = harness.db.repos.attempts.listForRun(runId);
    expect(attempt?.state).toBe('failed_before_dispatch');
    expect(ledgerOf(harness.db.repos, runId).filter((e) => e.attemptId === attempt?.id).map((e) => e.type)).toEqual(['reserve', 'release']);
    expect(harness.db.repos.steps.get(stepRunId).state).toBe('ready');
  });

  it('records `unknown` (never dispatching) when the adapter throws', async () => {
    const { harness, runId, stepRunId } = await readyReview({
      providers: (base) => ({ list: () => base.list(), get: (id) => ({ ...base.get(id), generate: () => Promise.reject(new Error('adapter bug')) }) }),
    });

    await executeModelAttempt(harness.ctx, runId, stepRunId);

    const [attempt] = harness.db.repos.attempts.listForRun(runId);
    expect(attempt?.state).toBe('unknown');
    expect(harness.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: attempt?.reservationMicrousd }));
    expect(harness.db.repos.runs.get(runId).pauseReason).toBe('unknown_outcome');
    expect(harness.logger.entries.some((e) => e.event === 'adapter.threw')).toBe(true);
  });

  it('stores non-JSON raw text as text/plain, retries with schema_repair, and redacts only the raw response', async () => {
    const secret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd';
    const fixture = { ...(FAKE_FIXTURES['findings.v1'] as Record<string, unknown>), summary: `Found a leaked key ${secret} in config.` };
    const { harness, runId, stepRunId } = await readyReview({
      providers: withRegistry({
        mode: 'fake', clock: { now: () => (h ? h.clock.now() : (0 as never)) }, callLog: createMemoryCallLog(), extraFixtures: { 'findings.secret': fixture },
        fakeScenario: { name: 'custom', steps: [
          { match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'malformed', text: `not json at all ${secret}` } },
          { match: { stepKey: 'review', purpose: 'schema_repair' }, result: { kind: 'success', fixture: 'findings.secret' } },
        ] },
      }),
    });

    const first = await executeModelAttempt(harness.ctx, runId, stepRunId);
    const retried = harness.db.repos.steps.get(stepRunId);
    const second = await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(first).toEqual(expect.objectContaining({ outcome: 'invalid_output', plan: 'retry' }));
    expect(retried).toEqual(expect.objectContaining({ state: 'ready', schemaRepairsUsed: 1 }));
    expect(second).toEqual(expect.objectContaining({ outcome: 'valid' }));
    const [a1, a2] = harness.db.repos.attempts.listForStep(stepRunId);
    expect(a1?.error?.code).toBe('OUTPUT_INVALID');
    expect(a2).toEqual(expect.objectContaining({ purpose: 'schema_repair', retryOfAttemptId: a1?.id, seq: 2 }));
    const arts = harness.db.repos.artifacts.listForRun(runId);
    const raw1 = arts.find((a) => a.attemptId === a1?.id && a.kind === 'raw_response');
    const raw2 = arts.find((a) => a.attemptId === a2?.id && a.kind === 'raw_response');
    const out = arts.find((a) => a.attemptId === a2?.id && a.kind === 'findings');
    expect(raw1?.mediaType).toBe('text/plain');
    const read = async (rel: string | undefined) => {
      const bytes = await harness.ctx.artifacts.read(rel ?? '', 1_000_000);
      if (!bytes.ok) throw new Error('read');
      return fromUtf8(bytes.value);
    };
    expect(await read(raw1?.relPath)).not.toContain(secret);
    expect(await read(raw2?.relPath)).not.toContain(secret);
    expect(await read(out?.relPath)).toContain(secret); // canonical output is never redacted
  });

  it('commits ledger + attempt but leaves the step alone when it is no longer executing', async () => {
    const box: { target?: StepRunId } = {};
    const { harness, runId, stepRunId } = await readyReview({
      hooks: {
        afterProviderResponse: () => {
          const x = h;
          if (x === undefined || box.target === undefined) return;
          x.db.tx('immediate', (r) => applyStepEvent(r, [], r.steps.get(box.target as StepRunId), 'RUN_CANCELLED'));
        },
      },
    });
    box.target = stepRunId;

    await executeModelAttempt(harness.ctx, runId, stepRunId);

    const [attempt] = harness.db.repos.attempts.listForRun(runId);
    expect(attempt?.state).toBe('succeeded');
    expect(harness.db.repos.steps.get(stepRunId).state).toBe('skipped');
    expect(ledgerOf(harness.db.repos, runId).filter((e) => e.attemptId === attempt?.id).map((e) => e.type)).toEqual(['reserve', 'release', 'settle']);
  });

  it('pauses budget_overrun when X > N regardless of L, recording the uncapped cost', async () => {
    const { harness, runId, stepRunId } = await readyReview({ scenario: 'overrun' });

    await executeModelAttempt(harness.ctx, runId, stepRunId);

    const [attempt] = harness.db.repos.attempts.listForRun(runId);
    const settle = ledgerOf(harness.db.repos, runId).find((e) => e.type === 'settle' && e.attemptId === attempt?.id);
    expect(settle?.deltaMicrousd).toBeGreaterThan(attempt?.reservationMicrousd ?? Infinity);
    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'budget_overrun' }));
    expect(harness.db.repos.steps.get(stepRunId).state).toBe('succeeded');
    expect(harness.db.repos.events.list(runId, 0, 200).some((e) => e.type === 'ledger.overrun')).toBe(true);
    const detail = await harness.engine.handle('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.availableActions).toEqual(['acknowledge_overrun', 'increase_allowance', 'stop']);
  });

  it('pauses budget_run inside the reservation tx when C + R + U + N > L', async () => {
    // L covers the queued check's minimum (output only) but not N (input + output): admission blocks at dispatch.
    const { harness, runId, stepRunId } = await readyReview({}, { budgetMicrousd: (x) => reviewMinimum(x) + 1 });

    const out = await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(out).toEqual({ kind: 'blocked', why: 'paused' });
    expect(harness.db.repos.attempts.listForRun(runId)).toEqual([]);
    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'budget_run' }));
    expect(harness.db.repos.runs.get(runId).statusDetail?.code).toBe('BUDGET_BLOCKED');
    expect(harness.db.repos.events.list(runId, 0, 200).some((e) => e.type === 'ledger.blocked')).toBe(true);
  });

  it('pauses on the project-month allowance with pauseReason budget_project', async () => {
    const { harness, runId, stepRunId } = await readyReview();
    const p = harness.db.repos.projects.get(harness.projectId);
    harness.db.repos.projects.update(harness.projectId, { monthlyAllowanceMicrousd: microusd(1_000) }, p.updatedAt); // after the queued check

    await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(harness.db.repos.runs.get(runId).pauseReason).toBe('budget_project');
  });

  it('cancel during a hang aborts the call: attempt unknown (never dispatching), U = N, R = 0, then cancelled', async () => {
    const { harness, runId, stepRunId } = await readyReview({ scenario: 'hang' });

    const pending = executeModelAttempt(harness.ctx, runId, stepRunId);
    await harness.waitFor(() => harness.db.repos.attempts.listForRun(runId)[0]?.state === 'dispatching');
    const cancel = await harness.engine.handle('relay/v1/runs.cancel', { runId });
    await pending;

    expect(cancel.ok && cancel.data.status).toBe('cancelling');
    const [attempt] = harness.db.repos.attempts.listForRun(runId);
    expect(attempt?.state).toBe('unknown');
    expect(harness.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: attempt?.reservationMicrousd }));
    expect(harness.db.repos.runs.get(runId).status).toBe('cancelling');
    expect(harness.db.repos.steps.get(stepRunId).state).toBe('unknown'); // skipped only by the WORK_STOPPED handler

    expect(await onWorkStopped(harness.ctx, runId)).toBe(true);
    expect(harness.db.repos.runs.get(runId).status).toBe('cancelled');
    expect(harness.db.repos.steps.get(stepRunId).state).toBe('skipped');
    const again = await harness.engine.handle('relay/v1/runs.cancel', { runId });
    expect(again.ok).toBe(false);
  });

  it('pauses approval_stale (PROJECT_CHANGED) when a selected file changed on disk after intake', async () => {
    const { harness, runId, stepRunId } = await readyReview();
    await writeFile(join(harness.projectRoot, 'src', 'lib', 'format.ts'), 'export const changed = true;\n');

    const out = await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(out).toEqual({ kind: 'blocked', why: 'paused' });
    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'approval_stale' }));
    expect(harness.db.repos.runs.get(runId).statusDetail?.code).toBe('PROJECT_CHANGED');
  });
});

describe('retry outcomes through the checkpoint (F7)', () => {
  it('rate limit: step ready with rate_limit_waits_used + not_before_at (no sleep), then succeeds', async () => {
    const { harness, runId, stepRunId } = await readyReview({ scenario: 'rate-limit-then-ok' });
    const now = harness.clock.now();

    const first = await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(first).toEqual(expect.objectContaining({ outcome: 'rate_limited', plan: 'retry' }));
    expect(harness.db.repos.steps.get(stepRunId)).toEqual(expect.objectContaining({ state: 'ready', rateLimitWaitsUsed: 1, notBeforeAt: now + 1000 }));
    const second = await executeModelAttempt(harness.ctx, runId, stepRunId);
    expect(second).toEqual(expect.objectContaining({ outcome: 'valid' }));
    expect(harness.db.repos.attempts.listForStep(stepRunId)[1]?.purpose).toBe('initial');
  });

  it('transport: 5xx before body retries once as transport_retry, then fails the step and pauses provider_unavailable', async () => {
    const { harness, runId, stepRunId } = await readyReview({ scenario: 'server-error-twice' });

    await executeModelAttempt(harness.ctx, runId, stepRunId);
    expect(harness.db.repos.steps.get(stepRunId)).toEqual(expect.objectContaining({ state: 'ready', transportRetriesUsed: 1 }));
    await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(harness.db.repos.attempts.listForStep(stepRunId).map((a) => a.purpose)).toEqual(['initial', 'transport_retry']);
    expect(harness.db.repos.steps.get(stepRunId).state).toBe('failed');
    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'provider_unavailable' }));
  });

  it('auth failure holds the step ready and pauses auth_required', async () => {
    const { harness, runId, stepRunId } = await readyReview({ scenario: 'auth-fail' });

    await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(harness.db.repos.steps.get(stepRunId).state).toBe('ready');
    expect(harness.db.repos.runs.get(runId).pauseReason).toBe('auth_required');
  });

  it('refusal fails the step and pauses model_refused (never run failed)', async () => {
    const { harness, runId, stepRunId } = await readyReview({ scenario: 'refused' });

    await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(harness.db.repos.steps.get(stepRunId).state).toBe('failed');
    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'model_refused' }));
  });

  it('mid-stream error is never auto-retried: unknown outcome with partial usage recorded informationally', async () => {
    const { harness, runId, stepRunId } = await readyReview({ scenario: 'midstream-error' });

    await executeModelAttempt(harness.ctx, runId, stepRunId);

    const [attempt] = harness.db.repos.attempts.listForRun(runId);
    expect(attempt?.state).toBe('unknown');
    expect(attempt?.usage?.partial).toBe(true);
    expect(harness.db.repos.steps.get(stepRunId).state).toBe('unknown');
    expect(harness.db.repos.runs.get(runId).pauseReason).toBe('unknown_outcome');
  });

  it('exhausted schema repair fails the step and pauses output_invalid', async () => {
    const { harness, runId, stepRunId } = await readyReview({ scenario: 'malformed-twice' });

    await executeModelAttempt(harness.ctx, runId, stepRunId);
    await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(harness.db.repos.steps.get(stepRunId).state).toBe('failed');
    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'output_invalid' }));
  });
});

// ---------------------------------------------------------------- F4 putArtifact failures (06 F4 helpers)

/** Replaces `ctx.artifacts.put`: the `n`-th put from now on fails (`fail`: an error result; `throw`: the store throws). */
function failNthPut(x: Harness, n: number, how: 'fail' | 'throw'): { readonly calls: () => number } {
  const base = x.ctx.artifacts;
  let count = 0;
  (x.ctx as { artifacts: EngineCtx['artifacts'] }).artifacts = {
    ...base,
    put: (req) => {
      count += 1;
      if (count !== n) return base.put(req);
      if (how === 'throw') throw new Error('disk full');
      return Promise.resolve(err(errors.artifactWriteFailed()));
    },
  };
  return { calls: () => count };
}

const kindsOf = (x: Harness, runId: RunId) => x.db.repos.artifacts.listForRun(runId).map((a) => a.kind).filter((k) => k !== 'input_file').sort();
const writeFailures = (x: Harness, runId: RunId) =>
  x.db.repos.events.list(runId, 0, 500).filter((e) => e.type === 'artifact.write_failed').map((e) => e.payload['kind']);

describe('executeModelAttempt: artifact write failures (F4 putArtifact)', () => {
  it('a failed raw_response put is logged + artifact.write_failed; the step outcome is unaffected (succeeded, settled)', async () => {
    const { harness, runId, stepRunId } = await readyReview();
    const puts = failNthPut(harness, 1, 'fail'); // 1st put = raw_response

    await executeModelAttempt(harness.ctx, runId, stepRunId);

    const [attempt] = harness.db.repos.attempts.listForRun(runId);
    expect(puts.calls()).toBe(3); // raw, manifest, canonical findings
    expect([attempt?.state, harness.db.repos.steps.get(stepRunId).state, harness.db.repos.runs.get(runId).status]).toEqual(['succeeded', 'succeeded', 'running']);
    expect(kindsOf(harness, runId)).toEqual(['context_manifest', 'findings']); // no raw_response row
    expect(writeFailures(harness, runId)).toEqual(['raw_response']);
    expect(harness.logger.entries.some((e) => e.event === 'artifact.write_failed' && e.fields?.['kind'] === 'raw_response')).toBe(true);
    expect(harness.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: 0 }));
    expect(harness.db.repos.ledger.runBalances(runId).C).toBeGreaterThan(0);
  });

  it('a manifest put that THROWS is caught (never escapes F4): logged + write_failed, the step still succeeds', async () => {
    const { harness, runId, stepRunId } = await readyReview();
    failNthPut(harness, 2, 'throw'); // 2nd put = context_manifest

    const out = await executeModelAttempt(harness.ctx, runId, stepRunId);

    expect(out.kind).not.toBe('blocked');
    expect(harness.db.repos.steps.get(stepRunId).state).toBe('succeeded');
    expect(kindsOf(harness, runId)).toEqual(['findings', 'raw_response']);
    expect(writeFailures(harness, runId)).toEqual(['context_manifest']);
    expect(harness.db.repos.attempts.listForRun(runId).map((a) => a.state)).toEqual(['succeeded']); // never left dispatching
  });

  it('a failed canonical-output put is a known failure: ARTIFACT_WRITE_FAILED, usage settled, step failed, paused(output_invalid) → retry_step recovers', async () => {
    const { harness, runId, stepRunId } = await readyReview();
    failNthPut(harness, 3, 'fail'); // 3rd put = the canonical findings.v1 output

    await executeModelAttempt(harness.ctx, runId, stepRunId);

    const [attempt] = harness.db.repos.attempts.listForRun(runId);
    expect([attempt?.state, attempt?.error?.code]).toEqual(['failed', 'ARTIFACT_WRITE_FAILED']);
    expect(harness.db.repos.ledger.attemptBalances(attempt?.id ?? ('' as never))).toEqual(expect.objectContaining({ reserved: 0, unknown: 0 }));
    expect(harness.db.repos.ledger.attemptBalances(attempt?.id ?? ('' as never)).settled).toBeGreaterThan(0); // usage still settled
    expect(harness.db.repos.steps.get(stepRunId)).toEqual(expect.objectContaining({ state: 'failed', outputArtifactId: null }));
    expect(kindsOf(harness, runId)).toEqual(['context_manifest', 'raw_response']); // no findings row
    expect(writeFailures(harness, runId)).toEqual(['findings']);
    const run = harness.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason]).toEqual(['paused', 'output_invalid']);
    const detail = await harness.engine.handle('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.availableActions).toContain('retry_step');

    const retried = await harness.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'artifact-retry-0001', runId, stepId: stepRunId });
    expect(retried.ok && retried.data.status).toBe('queued');
    await tick(harness.ctx); // CHECKS_PASSED
    const next = harness.db.repos.steps.latestFor(runId, REVIEW);
    if (next === undefined) throw new Error('retry row');
    await executeModelAttempt(harness.ctx, runId, next.id);
    expect([next.retryIndex, harness.db.repos.steps.get(next.id).state]).toEqual([1, 'succeeded']);
  });
});
