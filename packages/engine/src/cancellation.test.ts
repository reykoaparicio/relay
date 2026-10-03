// F11 pause / cancel completeness, plus the run-inspector detail fields (OUTPUT_INVALID repair details, stream
// progress events, usageKnown settlement) and the artifacts.get / app.createBackup handlers.
import { afterEach, describe, expect, it } from 'vitest';
import type { RunId } from '@relay/contracts';
import type { ModelResult } from '@relay/providers';
import { settleAmount } from './budget.js';
import { classify } from './retry.js';
import { tick } from './runner.js';
import { createHarness, sleep } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';
import { drive, wrapAdapters } from './testing/drive.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function start(o: HarnessOptions = {}): Promise<{ x: Harness; runId: RunId }> {
  const x = await createHarness(o);
  h = x;
  return { x, runId: await x.startRun() };
}

describe('runs.pause / runs.cancel (F11)', () => {
  it('pause lets the in-flight call finish (inFlight "waiting"), then paused(user) before the next dispatch', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { x, runId } = await start({ providers: wrapAdapters({ generate: async (base, req, gctx) => {
      await gate;
      return base.get(req.providerId).generate(req, gctx);
    } }) });
    await tick(x.ctx); // running
    await tick(x.ctx); // intake
    const inFlight = tick(x.ctx); // review dispatches and waits on the gate
    await x.waitFor(() => x.db.repos.attempts.listForRun(runId).some((a) => a.state === 'dispatching'));

    const paused = await x.engine.handle('relay/v1/runs.pause', { runId });
    release();
    await inFlight;
    await tick(x.ctx);

    expect(paused.ok && paused.data).toEqual({ status: 'running', inFlight: 'waiting' });
    expect(x.db.repos.attempts.listForRun(runId).map((a) => a.state)).toEqual(['succeeded']);
    expect(x.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'user', pauseRequested: false }));
    const again = await x.engine.handle('relay/v1/runs.pause', { runId });
    expect(again.ok ? null : again.error.code).toBe('CONFLICT');
  });

  it('cancel between steps: nothing further is dispatched, open steps are skipped, the report is generated', async () => {
    const { x, runId } = await start();
    await drive(x, runId, ['awaiting_approval']);
    const calls = x.callLog.entries().length;

    const res = await x.engine.handle('relay/v1/runs.cancel', { runId });

    expect(res.ok && res.data).toEqual({ status: 'cancelled', unresolvedCharges: [] });
    expect(x.db.repos.steps.latestPerStepKey(runId).filter((s) => s.state !== 'succeeded').every((s) => s.state === 'skipped')).toBe(true);
    await tick(x.ctx);
    expect(x.callLog.entries()).toHaveLength(calls);
    await x.waitFor(() => x.db.repos.artifacts.listForRun(runId, ['report']).length === 1);
    const terminal = await x.engine.handle('relay/v1/runs.cancel', { runId });
    expect(terminal.ok ? null : terminal.error.details?.['reason']).toBe('run_terminal');
  });

  it('stop on a paused(unknown_outcome) run: no unresolved charge (decision 1: the uncertain attempt is already settled as an estimate)', async () => {
    const { x, runId } = await start({ scenario: 'midstream-error' });
    await drive(x, runId, ['paused']);
    const [a] = x.db.repos.attempts.listForRun(runId);
    const settled = x.db.repos.ledger.attemptBalances(a!.id).settled;

    const res = await x.engine.handle('relay/v1/runs.cancel', { runId });

    expect(res.ok && res.data).toEqual({ status: 'cancelled', unresolvedCharges: [] });
    expect(settled).toBeGreaterThan(0);
    expect(x.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: 0, C: settled }));
  });

  it('cancel of a queued run is immediate; a running run goes cancelling → cancelled via WORK_STOPPED once nothing is in flight', async () => {
    const { x, runId } = await start();
    const second = await x.startRun();
    await tick(x.ctx); // first → running

    const queued = await x.engine.handle('relay/v1/runs.cancel', { runId: second });
    const running = await x.engine.handle('relay/v1/runs.cancel', { runId });
    const twice = await x.engine.handle('relay/v1/runs.cancel', { runId });
    await tick(x.ctx);

    expect(queued.ok && queued.data.status).toBe('cancelled');
    expect(running.ok && running.data.status).toBe('cancelling');
    expect(twice.ok && twice.data.status).toBe('cancelling');
    expect(x.db.repos.runs.get(runId).status).toBe('cancelled');
  });
});

describe('run-inspector detail fields', () => {
  it('OUTPUT_INVALID carries { schemaId, repairsUsed, repairsMax, rawResponseArtifactId, issues }', async () => {
    const { x, runId } = await start({ scenario: 'malformed-twice' });
    await drive(x, runId, ['paused']);

    const [first, second] = [...x.db.repos.attempts.listForRun(runId)].sort((a, b) => a.seq - b.seq);
    const raw = x.db.repos.artifacts.listForRun(runId, ['raw_response']).find((art) => art.attemptId === second?.id);

    expect(first?.error?.details).toEqual(expect.objectContaining({ schemaId: 'findings.v1', repairsUsed: 0, repairsMax: 1 }));
    expect(second?.error?.details).toEqual(expect.objectContaining({ schemaId: 'findings.v1', repairsUsed: 1, repairsMax: 1, rawResponseArtifactId: raw?.id }));
    expect(x.db.repos.runs.get(runId).statusDetail?.details?.['rawResponseArtifactId']).toBe(raw?.id);
  });

  it('attempt.stream_progress events carry only { attemptId, stepRunId, outputTokensSoFar, elapsedMs } and are throttled to one per 500 ms', async () => {
    const { x, runId } = await start({ providers: wrapAdapters({ generate: (base, req, gctx) => {
      for (const n of [10, 20, 30]) gctx.hooks?.onProgress?.({ outputTokensSoFar: n, elapsedMs: n });
      x.clock.advance(600);
      gctx.hooks?.onProgress?.({ outputTokensSoFar: 40, elapsedMs: 600 });
      return base.get(req.providerId).generate(req, gctx);
    } }) });
    await drive(x, runId, ['awaiting_approval']);

    const progress = x.db.repos.events.list(runId, 0, 1000).filter((e) => e.type === 'attempt.stream_progress');
    const review = x.db.repos.attempts.listForRun(runId)[0];

    expect(progress.filter((e) => e.payload['attemptId'] === review?.id).map((e) => e.payload)).toEqual([
      { attemptId: review?.id, stepRunId: review?.stepRunId, outputTokensSoFar: 10, elapsedMs: 10 },
      { attemptId: review?.id, stepRunId: review?.stepRunId, outputTokensSoFar: 40, elapsedMs: 600 },
    ]);
    expect(x.events.some((e) => e.type === 'run.event' && e.event.type === 'attempt.stream_progress')).toBe(true);
  });

  it('usageKnown=false settles the reservation N as estimated (never $0 calculated); priceTierMismatch marks estimated', () => {
    const usage = { uncachedInputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 };
    const success: ModelResult = { kind: 'success', json: {}, rawText: '{}', usage, rawUsage: null, stopReason: 'end_turn', latencyMs: 0 };
    const prices = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } as never;
    const o = { aborted: false, attemptId: 'att_x' as never };

    const unknownUsage = classify({ ...success, usageKnown: false }, { ok: true, value: {} }, true, o);
    const tier = classify({ ...success, usage: { ...usage, outputTokens: 10 }, priceTierMismatch: true }, { ok: true, value: {} }, true, o);
    const truncated = classify({ kind: 'truncated', rawText: '', usage, rawUsage: null, usageKnown: false }, null, true, o);

    expect(settleAmount(unknownUsage, prices, undefined, 1234 as never)).toEqual({ kind: 'known', microusd: 1234, certainty: 'estimated' });
    expect(settleAmount(tier, prices)).toEqual({ kind: 'known', microusd: 1, certainty: 'estimated' }); // ceil(10 × 1 / 1e6)
    expect(settleAmount(truncated, prices, undefined, 55 as never)).toEqual({ kind: 'known', microusd: 55, certainty: 'estimated' });
    expect(settleAmount(classify(success, { ok: true, value: {} }, true, o), prices)).toEqual({ kind: 'known', microusd: 0, certainty: 'calculated' });
  });
});

describe('artifacts.get / app.createBackup', () => {
  it('returns JSON artifacts inline, text truncated at maxBytes, NOT_FOUND(purged) for a purged file', async () => {
    const { x, runId } = await start({ scenario: 'malformed-twice' });
    await drive(x, runId, ['paused']);
    const r = x.db.repos;
    const manifest = r.artifacts.listForRun(runId, ['context_manifest'])[0];
    const rawText = r.artifacts.listForRun(runId, ['raw_response']).find((a) => a.mediaType === 'text/plain');

    const json = await x.engine.handle('relay/v1/artifacts.get', { artifactId: manifest?.id ?? '' });
    const text = await x.engine.handle('relay/v1/artifacts.get', { artifactId: rawText?.id ?? '', maxBytes: 10 });
    await x.ctx.artifacts.purge(rawText?.relPath ?? '');
    x.db.tx('immediate', (tx) => tx.artifacts.markPurged(rawText?.id ?? ('' as never), x.clock.now()));
    const purged = await x.engine.handle('relay/v1/artifacts.get', { artifactId: rawText?.id ?? '' });
    const missing = await x.engine.handle('relay/v1/artifacts.get', { artifactId: x.ids.next('artifact') });

    expect(json.ok && [json.data.content.kind, json.data.meta.kind, json.data.meta.purged]).toEqual(['json', 'context_manifest', false]);
    expect(text.ok && text.data.content).toEqual({ kind: 'text', text: 'Here are m', truncated: true });
    expect(purged.ok ? null : [purged.error.code, purged.error.details?.['purged']]).toEqual(['NOT_FOUND', true]);
    expect(missing.ok ? null : missing.error.code).toBe('NOT_FOUND');
  });

  it('creates a backup through the storage port (display path), idempotent per key', async () => {
    const { x } = await start();

    const first = await x.engine.handle('relay/v1/app.createBackup', { idempotencyKey: 'backup-key-000001' });
    await sleep(1);
    const replay = await x.engine.handle('relay/v1/app.createBackup', { idempotencyKey: 'backup-key-000001' });

    expect(first.ok && first.data.backupDisplayPath.startsWith('~/backups/')).toBe(true);
    expect(first.ok && first.data.sizeBytes).toBeGreaterThan(0);
    expect(replay.ok && replay.data).toEqual(first.ok ? first.data : null);
  });
});
