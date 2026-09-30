// F14: workflows.saveDraft / validate / publish and profiles.upsert / delete with capability warnings.
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowId } from '@relay/contracts';
import { applyDraftPatch } from './workflows.js';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function harness(): Promise<{ x: Harness; wf: WorkflowId }> {
  const x = await createHarness();
  h = x;
  const wf = x.db.repos.workflows.listWorkflows()[0]?.id;
  if (wf === undefined) throw new Error('no workflow');
  return { x, wf };
}

const issuesOf = (res: { ok: boolean; error?: { details?: Record<string, unknown> } }) =>
  ((res.error?.details?.['issues'] ?? []) as { path: string; code: string }[]).map((i) => `${i.path}:${i.code}`);

describe('workflows.saveDraft (P0 patch only)', () => {
  it('creates the draft from the latest validated version (revision 0 → 1), then updates it with a CAS on draftRevision', async () => {
    const { x, wf } = await harness();

    const created = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 0,
      patch: { prompts: { 'reviewer.v1': 'Review carefully.' }, limits: { maxAttempts: 12 }, steps: { review: { maxOutputTokens: 4000, profile: 'Economy' } } } });
    const updated = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 1,
      patch: { steps: { plan: { retryPolicy: { transport: 2, schemaRepair: 0, rateLimitWaits: 1 } } } } });
    const stale = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 1, patch: {} });
    const again = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 0, patch: {} });

    expect(created.ok && [created.data.version, created.data.status, created.data.draftRevision, created.data.spec.limits.maxAttempts]).toEqual(['draft', 'draft', 1, 12]);
    expect(created.ok && created.data.prompts['reviewer.v1']?.text).toBe('Review carefully.');
    expect(updated.ok && [updated.data.draftRevision, updated.data.spec.steps.find((s) => s.id === 'review')]).toEqual([2, expect.objectContaining({ profile: 'Economy', maxOutputTokens: 4000 })]);
    expect(stale.ok ? null : stale.error.code).toBe('CONFLICT');
    expect(again.ok ? null : again.error.details?.['reason']).toBe('draft_exists');
    const list = await x.engine.handle('relay/v1/workflows.list', {});
    expect(list.ok && list.data[0]).toEqual(expect.objectContaining({ latestValidatedVersion: 1, draftVersion: 2 }));
    expect(x.db.repos.workflows.getVersion(wf, 1)?.spec.limits.maxAttempts).toBe(10); // v1 is immutable
  });

  it('rejects structural edits with structural_edit_p1 (unknown keys, approval steps, unknown steps, unused prompts)', async () => {
    const { x, wf } = await harness();

    const unknownKey = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 0, patch: { steps: {}, dependsOn: [] } as never });
    const approval = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 0, patch: { steps: { approve: { profile: 'Economy' } } } });
    const unknownStep = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 0, patch: { steps: { nope: {} } } });
    const prompt = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 0, patch: { prompts: { 'poet.v1': 'x' } } });
    const noDraft = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 3, patch: {} });
    const noWf = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: x.ids.next('workflow'), expectedDraftRevision: 0, patch: {} });

    expect(issuesOf(unknownKey as never)).toEqual(['patch.dependsOn:structural_edit_p1']);
    expect(issuesOf(approval as never)).toEqual(['steps.approve:structural_edit_p1']);
    expect(issuesOf(unknownStep as never)).toEqual(['steps.nope:structural_edit_p1']);
    expect(issuesOf(prompt as never)).toEqual(['prompts.poet.v1:structural_edit_p1']);
    expect(noDraft.ok ? null : noDraft.error.code).toBe('NOT_FOUND');
    expect(noWf.ok ? null : noWf.error.code).toBe('NOT_FOUND');
  });

  it('applyDraftPatch re-validates the whole spec (limits out of range → VALIDATION_FAILED)', async () => {
    const { x, wf } = await harness();
    const v1 = x.db.repos.workflows.getVersion(wf, 1);
    if (v1 === undefined) throw new Error('v1');

    const res = applyDraftPatch(v1, { limits: { maxAttempts: 9999 } });

    expect(res.ok ? null : res.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('workflows.validate / publish (F14)', () => {
  it('validates v1: no issues; a missing credential is a warning per step, not an error', async () => {
    const { x, wf } = await harness();

    const res = await x.engine.handle('relay/v1/workflows.validate', { workflowId: wf, version: 1 });
    await x.engine.handle('relay/v1/providers.recordCredentialRef', { providerId: 'anthropic', storageMode: 'session', vaultFile: null, redactedLabel: 'sk-…' });
    const after = await x.engine.handle('relay/v1/workflows.validate', { workflowId: wf, version: 1 });
    const none = await x.engine.handle('relay/v1/workflows.validate', { workflowId: wf, version: 'draft' });

    expect(res.ok && [res.data.valid, res.data.issues]).toEqual([true, []]);
    expect(res.ok && res.data.warnings.map((w) => [w.stepKey, w.code])).toEqual([['review', 'missing_credential'], ['plan', 'missing_credential'],
      ['implement', 'missing_credential'], ['verify', 'missing_credential']]);
    expect(after.ok && after.data.warnings).toEqual([]);
    expect(none.ok ? null : none.error.code).toBe('NOT_FOUND');
  });

  it('reports field paths: unknown profile, output allowance above the model, a budget that cannot cover the first step', async () => {
    const { x, wf } = await harness();
    await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 0,
      patch: { limits: { budgetMicrousd: 10 }, steps: { review: { profile: 'Nope' }, plan: { maxOutputTokens: 1_000_000 } } } });

    const res = await x.engine.handle('relay/v1/workflows.validate', { workflowId: wf, version: 'draft' });
    const publish = await x.engine.handle('relay/v1/workflows.publish', { idempotencyKey: 'publish-key-00001', workflowId: wf });

    expect(res.ok && res.data.valid).toBe(false);
    expect(res.ok && res.data.issues.map((i) => `${i.path}:${i.code}`)).toEqual(['steps[0].profile:unknown_profile', 'steps[1].maxOutputTokens:output_budget_low', 'limits.budgetMicrousd:budget_too_small']);
    expect(publish.ok ? null : publish.error.code).toBe('VALIDATION_FAILED');
  });

  it('publishes a valid draft as the next immutable validated version (idempotent); runs can then start on it', async () => {
    const { x, wf } = await harness();
    await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 0, patch: { steps: { review: { profile: 'Economy' } } } });

    const pub = await x.engine.handle('relay/v1/workflows.publish', { idempotencyKey: 'publish-key-00002', workflowId: wf });
    const replay = await x.engine.handle('relay/v1/workflows.publish', { idempotencyKey: 'publish-key-00002', workflowId: wf });
    const nothing = await x.engine.handle('relay/v1/workflows.publish', { idempotencyKey: 'publish-key-00003', workflowId: wf });

    expect(pub.ok && [pub.data.version, pub.data.status]).toEqual([2, 'validated']);
    expect(replay.ok && replay.data.version).toBe(2);
    expect(nothing.ok ? null : nothing.error.code).toBe('NOT_FOUND');
    const started = await x.engine.handle('relay/v1/runs.start', { idempotencyKey: 'run-on-v2-000001', projectId: x.projectId, workflowId: wf, workflowVersion: 2,
      goal: 'g', input: { kind: 'files', relPaths: ['src/lib/format.ts'] } });
    expect(started.ok).toBe(true);
  });
});

describe('profiles.upsert / delete (F14)', () => {
  it('upserts a valid profile with its warnings; MODEL_UNSUPPORTED for an unknown model or effort; CONFLICT on a stale revision', async () => {
    const { x } = await harness();

    const created = await x.engine.handle('relay/v1/profiles.upsert', { profile: { name: 'Mine', providerId: 'anthropic', modelId: 'claude-haiku-4-5', params: { maxOutputTokens: 4000, refusalFallback: 'off' } } });
    const id = created.ok ? created.data.profile.id : undefined;
    const updated = await x.engine.handle('relay/v1/profiles.upsert', { profile: { id, name: 'Mine', providerId: 'anthropic', modelId: 'claude-haiku-4-5', params: { maxOutputTokens: 2000, refusalFallback: 'off' } }, expectedRevision: 1 });
    const stale = await x.engine.handle('relay/v1/profiles.upsert', { profile: { id, name: 'Mine', providerId: 'anthropic', modelId: 'claude-haiku-4-5', params: { maxOutputTokens: 1000, refusalFallback: 'off' } }, expectedRevision: 1 });
    const unknown = await x.engine.handle('relay/v1/profiles.upsert', { profile: { name: 'Bad', providerId: 'anthropic', modelId: 'nope', params: { maxOutputTokens: 10, refusalFallback: 'off' } } });
    const effort = await x.engine.handle('relay/v1/profiles.upsert', { profile: { name: 'Bad2', providerId: 'anthropic', modelId: 'claude-haiku-4-5', params: { maxOutputTokens: 10, effort: 'max', refusalFallback: 'off' } } });

    expect(created.ok && [created.data.profile.revision, created.data.warnings.map((w) => w.code)]).toEqual([1, ['missing_credential']]);
    expect(updated.ok && [updated.data.profile.revision, updated.data.profile.params.maxOutputTokens]).toEqual([2, 2000]);
    expect(stale.ok ? null : stale.error.code).toBe('CONFLICT');
    expect(unknown.ok ? null : [unknown.error.code, unknown.error.details?.['reason']]).toEqual(['MODEL_UNSUPPORTED', 'model_unknown']);
    expect(effort.ok ? null : effort.error.details?.['reason']).toBe('effort_unsupported');
    expect(x.db.repos.profiles.get(id ?? ('' as never))?.capabilitiesSnapshot.structuredOutput).toBe(true);
  });

  it('delete: CONFLICT while a workflow references the profile, NOT_FOUND when absent, ok otherwise', async () => {
    const { x } = await harness();
    const balanced = x.db.repos.profiles.getByName('Balanced');
    const openai = x.db.repos.profiles.getByName('Balanced · OpenAI');

    const inUse = await x.engine.handle('relay/v1/profiles.delete', { profileId: balanced?.id ?? '' });
    const del = await x.engine.handle('relay/v1/profiles.delete', { profileId: openai?.id ?? '' });
    const gone = await x.engine.handle('relay/v1/profiles.delete', { profileId: openai?.id ?? '' });

    expect(inUse.ok ? null : [inUse.error.code, inUse.error.details?.['reason']]).toEqual(['CONFLICT', 'profile_in_use']);
    expect(del.ok && del.data).toEqual({ deleted: true });
    expect(gone.ok ? null : gone.error.code).toBe('NOT_FOUND');
  });
});
