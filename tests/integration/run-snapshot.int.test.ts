// 11 §K6 run-snapshot (FR-03, @m3): a started run keeps its snapshotted model and prompts even when the profile and the
// workflow change afterwards; runs.retryStep with a new profile appends a run_config_revisions row, later calls use the
// new modelId, and every HISTORICAL ledger entry is unchanged row for row.
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScenario } from '@relay/providers';
import { createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

const REFUSE_FIRST_REVIEW: FakeScenario = { name: 'refuse-first-review', steps: [{ match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'refused' } }] };

describe('run snapshot (FR-03) @m3', () => {
  it('profile edit + new workflow version after start do not leak into the run; retryStep with a new profile revises config without rewriting history @m3', async () => {
    h = await createHarness({ scenario: REFUSE_FIRST_REVIEW, start: false });
    const r = h.db.repos;
    const economy = r.profiles.getByName('Economy')!;
    const oldModel = economy.modelId;

    const runA = await h.startRun({ key: 'snapshot-run-a-0001' }); // snapshotted now (engine not started yet)

    // Edit the profile and publish a new workflow version with a different reviewer prompt.
    const edited = await h.call('relay/v1/profiles.upsert', { profile: { id: economy.id, name: 'Economy', providerId: 'anthropic', modelId: 'claude-sonnet-5-5',
      params: { maxOutputTokens: 8_000, refusalFallback: 'off' } }, expectedRevision: economy.revision });
    expect(edited.ok).toBe(true);
    expect(r.profiles.getByName('Economy')?.modelId).toBe('claude-sonnet-5-5');
    const draft = await h.call('relay/v1/workflows.saveDraft', { workflowId: h.workflowId, expectedDraftRevision: 0,
      patch: { prompts: { 'reviewer.v1': 'EDITED reviewer instructions: be terse.' } } });
    expect(draft.ok).toBe(true);
    const published = await h.call('relay/v1/workflows.publish', { idempotencyKey: 'publish-v2-key-0001', workflowId: h.workflowId });
    expect(published.ok && published.data.version).toBe(2);

    await h.engine.start();
    const pausedA = await h.waitFor(runA, 'paused');
    expect(pausedA.pauseReason).toBe('model_refused');

    // Run B starts after the edits on version 2 (the edited profile + prompt).
    const started = await h.call('relay/v1/runs.start', { idempotencyKey: 'snapshot-run-b-0001', projectId: h.projectId, workflowId: h.workflowId,
      workflowVersion: 2, goal: 'Fix the defects in the handlers.', input: { kind: 'files', relPaths: ['src/handlers/user.ts', 'src/handlers/orders.ts', 'src/lib/format.ts', 'src/lib/validate.ts', 'src/errors.ts', 'src/handlers/health.ts'] } });
    if (!started.ok) throw new Error(started.error.code);
    const runB = started.data.runId;
    await h.waitFor(runB, 'awaiting_approval');

    const [reviewA] = h.calls({ runId: runA, stepKey: 'review' });
    const [reviewB] = h.calls({ runId: runB, stepKey: 'review' });
    expect(reviewA?.modelId).toBe(oldModel); // the snapshot, not the edited profile
    expect(reviewB?.modelId).toBe('claude-sonnet-5-5');
    expect(reviewA?.systemSha256).not.toBe(reviewB?.systemSha256); // v1 prompt snapshot vs the edited v2 prompt
    expect(h.attempts(runA, 'review')[0]?.profileSnapshot.modelId).toBe(oldModel);

    // retryStep with a new profile on the paused step.
    const ledgerBefore = (() => {
      const p = r.ledger.list(runA, { limit: 500, sort: 'created_asc' });
      return p.ok ? p.value.items : [];
    })();
    const capable = r.profiles.getByName('Capable')!;
    const retried = await h.retryStep(runA, 'review', { profileId: capable.id });
    expect(retried.ok).toBe(true);
    expect(r.configRevisions.list(runA).map((c) => [c.revision, c.stepKey, c.previousProfile.modelId, c.profileSnapshot.modelId])).toEqual([[1, 'review', oldModel, capable.modelId]]);
    await h.waitFor(runA, 'awaiting_approval');
    expect(h.calls({ runId: runA, stepKey: 'review' }).map((c) => c.modelId)).toEqual([oldModel, capable.modelId]);
    expect(h.calls({ runId: runA, stepKey: 'plan' }).map((c) => c.modelId)).toEqual([r.profiles.getByName('Balanced')!.modelId]);
    const ledgerAfter = (() => {
      const p = r.ledger.list(runA, { limit: 500, sort: 'created_asc' });
      return p.ok ? p.value.items : [];
    })();
    expect(ledgerAfter.slice(0, ledgerBefore.length)).toEqual(ledgerBefore); // history unchanged, row for row
    expect(ledgerAfter.length).toBeGreaterThan(ledgerBefore.length);
  });
});
