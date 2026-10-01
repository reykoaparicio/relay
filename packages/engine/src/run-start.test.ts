import { afterEach, describe, expect, it } from 'vitest';
import type { RunStartInput, StepKey } from '@relay/contracts';
import { snapshotOf } from './snapshot.js';
import { createHarness } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function setup(o: HarnessOptions = {}): Promise<{ harness: Harness; input: RunStartInput }> {
  const harness = await createHarness(o);
  h = harness;
  const wf = harness.db.repos.workflows.listWorkflows()[0];
  const input: RunStartInput = {
    idempotencyKey: 'start-key-000001', projectId: harness.projectId, workflowId: wf?.id ?? ('' as never), workflowVersion: 1,
    goal: 'Fix it', input: { kind: 'files', relPaths: ['src/lib/format.ts' as never] },
  };
  return { harness, input };
}

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? null : r.error?.code);

describe('runs.start (F15)', () => {
  it('snapshots every step (synthetic intake/finalize included), writes allowance_set, and replays by idempotency key', async () => {
    const { harness, input } = await setup();

    const first = await harness.engine.handle('relay/v1/runs.start', input);
    const replay = await harness.engine.handle('relay/v1/runs.start', input);
    const reused = await harness.engine.handle('relay/v1/runs.start', { ...input, goal: 'Different' });

    if (!first.ok) throw new Error(first.error.code);
    expect(first.data.status).toBe('queued');
    expect(replay.ok && replay.data.runId).toBe(first.data.runId);
    expect(code(reused)).toBe('CONFLICT');
    const r = harness.db.repos;
    const run = r.runs.get(first.data.runId);
    const snap = snapshotOf(run);
    expect(Object.keys(snap.steps)).toEqual(['intake', 'review', 'plan', 'approve', 'implement', 'verify', 'finalize']);
    expect(snap.steps['review' as StepKey]?.dependsOn).toEqual(['intake']);
    expect(snap.steps['finalize' as StepKey]?.dependsOn).toEqual(['verify']);
    const review = snap.steps['review' as StepKey];
    expect(review?.kind === 'model' && [review.profile.name, review.profile.modelId, review.maxOutputTokens, review.profile.priceCatalogVersion])
      .toEqual(['Economy', 'claude-haiku-4-5', 8_000, '2026-09-25']);
    expect(r.steps.listForRun(run.id).map((s) => [s.stepKey, s.ordinal, s.state])).toEqual([
      ['intake', 0, 'pending'], ['review', 1, 'pending'], ['plan', 2, 'pending'], ['approve', 3, 'pending'],
      ['implement', 4, 'pending'], ['verify', 5, 'pending'], ['finalize', 6, 'pending'],
    ]);
    expect(r.ledger.runBalances(run.id).L).toBe(3_000_000);
    expect(run.limits).toEqual({ budgetMicrousd: 3_000_000, maxRevisionCycles: 2, maxAttempts: 10, maxConcurrentSteps: 1, executionTimeoutSeconds: 900, maxToolCalls: 0 });
    expect(r.events.list(run.id, 0, 10).map((e) => e.type)).toEqual(['run.created']);
  });

  it('applies profile and limit overrides', async () => {
    const { harness, input } = await setup();
    const capable = harness.db.repos.profiles.getByName('Capable');

    const res = await harness.engine.handle('relay/v1/runs.start', { ...input, profileOverrides: { review: capable?.id ?? '' }, limitOverrides: { maxAttempts: 20 } });

    if (!res.ok) throw new Error(res.error.code);
    const run = harness.db.repos.runs.get(res.data.runId);
    const review = snapshotOf(run).steps['review' as StepKey];
    expect(review?.kind === 'model' && review.profile.name).toBe('Capable');
    expect(run.limits.maxAttempts).toBe(20);
  });

  it('rejects bad inputs with typed errors', async () => {
    const { harness, input } = await setup({ allowedProviderIds: ['openai'] });
    const start = (over: Partial<RunStartInput>, key: string) => harness.engine.handle('relay/v1/runs.start', { ...input, ...over, idempotencyKey: key });

    expect(code(await start({}, 'start-key-000010'))).toBe('PERMISSION_DENIED');
    expect(code(await start({ projectId: 'prj_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as never }, 'start-key-000011'))).toBe('NOT_FOUND');
    expect(code(await start({ workflowVersion: 7 }, 'start-key-000012'))).toBe('NOT_FOUND');
    expect(code(await start({ profileOverrides: { approve: 'prf_01J9ZZZZZZZZZZZZZZZZZZZZZ0' } as never }, 'start-key-000013'))).toBe('VALIDATION_FAILED');
    expect(code(await start({ profileOverrides: { review: 'prf_01J9ZZZZZZZZZZZZZZZZZZZZZ0' } as never }, 'start-key-000014'))).toBe('NOT_FOUND');
    expect(code(await start({ limitOverrides: { maxAttempts: 999 } }, 'start-key-000015'))).toBe('VALIDATION_FAILED');
    expect(code(await start({ input: { kind: 'diff', diffArtifactId: 'art_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as never } }, 'start-key-000016'))).toBe('NOT_FOUND');
    harness.db.repos.projects.archive(harness.projectId);
    expect(code(await start({}, 'start-key-000017'))).toBe('CONFLICT');
  });

  it('fails closed with MODEL_UNSUPPORTED when no adapter serves the provider', async () => {
    const { harness, input } = await setup({ providers: (base) => ({ list: () => base.list(), get: () => { throw new Error('no adapter'); } }) });

    expect(code(await harness.engine.handle('relay/v1/runs.start', input))).toBe('MODEL_UNSUPPORTED');
  });
});

describe('runs.preflight', () => {
  it('summarizes input, estimates the first reservation locally, and shows the admission breakdown', async () => {
    const { harness, input } = await setup({ monthlyAllowanceMicrousd: 5_000_000 });
    const res = await harness.engine.handle('relay/v1/runs.preflight', { ...input });

    if (!res.ok) throw new Error(res.error.code);
    expect(res.data.inputSummary).toEqual(expect.objectContaining({ files: 1, memoryRecords: [], providersReceivingContext: ['anthropic'] }));
    expect(res.data.inputSummary.bytes).toBeGreaterThan(0);
    expect(res.data.firstReservation.basis).toBe('local_estimate');
    expect(res.data.firstReservation.N).toBeGreaterThan(0);
    expect(res.data.budget).toEqual(expect.objectContaining({ scope: 'run', allowed: true, L: 3_000_000 }));
    expect(harness.db.repos.runs.list({ projectId: harness.projectId, limit: 10 })).toEqual({ ok: true, value: { items: [], nextCursor: null } });
  });

  it('returns PERMISSION_DENIED for a selected file that cannot be read', async () => {
    const { harness, input } = await setup();
    const res = await harness.engine.handle('relay/v1/runs.preflight', { ...input, input: { kind: 'files', relPaths: ['.env'] } });

    expect(code(res)).toBe('PERMISSION_DENIED');
  });
});
