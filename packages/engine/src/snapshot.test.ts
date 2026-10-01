import { afterEach, describe, expect, it } from 'vitest';
import type { StepKey } from '@relay/contracts';
import { SnapshotError, effectiveStepSnapshot, hasSnapshotPreserved, modelStepKeys, parseRunSnapshot, requiresApproval, snapshotOf } from './snapshot.js';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('run snapshot (FR-03, R3-13)', () => {
  it('parses the stored snapshot and resolves approval binding and model steps', async () => {
    h = await createHarness();
    const run = h.db.repos.runs.get(await h.startRun());
    const snap = snapshotOf(run);

    expect(modelStepKeys(snap)).toEqual(['review', 'plan', 'implement', 'verify']);
    expect(['review', 'plan', 'implement', 'verify'].map((k) => requiresApproval(snap, k as StepKey))).toEqual([false, false, true, true]);
    expect(hasSnapshotPreserved(h.db.repos, run.id)).toBe(false);
    h.db.repos.events.append(run.id, 'run.snapshot_preserved', {});
    expect(hasSnapshotPreserved(h.db.repos, run.id)).toBe(true);
  });

  it('applies the latest config revision as the effective profile (revision 0 is never mutated)', async () => {
    h = await createHarness();
    const run = h.db.repos.runs.get(await h.startRun());
    const before = effectiveStepSnapshot(h.db.repos, run, 'review' as StepKey);
    const plan = effectiveStepSnapshot(h.db.repos, run, 'plan' as StepKey);
    h.db.tx('immediate', (r) => r.configRevisions.append(run.id, 'review' as StepKey, before.profile, plan.profile, 'user_switch'));

    const after = effectiveStepSnapshot(h.db.repos, run, 'review' as StepKey);

    expect(after.profile.name).toBe('Balanced');
    expect(snapshotOf(h.db.repos.runs.get(run.id)).steps['review' as StepKey]).toEqual(before);
    expect(() => effectiveStepSnapshot(h!.db.repos, run, 'approve' as StepKey)).toThrow(SnapshotError);
  });

  it.each([
    ['root', null],
    ['steps', { steps: [] }],
    ['step kind', { steps: { x: { kind: 'weird', dependsOn: [] } }, workflowContentHash: 'a'.repeat(64), catalogVersion: 'v', memoryIncludeIds: [] }],
    ['deps', { steps: { x: { kind: 'intake', dependsOn: ['BAD KEY'] } }, workflowContentHash: 'a'.repeat(64), catalogVersion: 'v', memoryIncludeIds: [] }],
    ['approval', { steps: { x: { kind: 'approval', bindTo: ['nope'], dependsOn: [] } }, workflowContentHash: 'a'.repeat(64), catalogVersion: 'v', memoryIncludeIds: [] }],
    ['model', { steps: { x: { kind: 'model', dependsOn: [] } }, workflowContentHash: 'a'.repeat(64), catalogVersion: 'v', memoryIncludeIds: [] }],
    ['meta', { steps: {}, workflowContentHash: 'nope', catalogVersion: 'v', memoryIncludeIds: [] }],
    ['memory ids', { steps: {}, workflowContentHash: 'a'.repeat(64), catalogVersion: 'v', memoryIncludeIds: ['nope'] }],
    ['step not object', { steps: { x: 3 }, workflowContentHash: 'a'.repeat(64), catalogVersion: 'v', memoryIncludeIds: [] }],
    ['deps not array', { steps: { x: { kind: 'finalize', dependsOn: 'intake' } }, workflowContentHash: 'a'.repeat(64), catalogVersion: 'v', memoryIncludeIds: [] }],
  ])('rejects a malformed snapshot (%s)', (_n, raw) => {
    expect(() => parseRunSnapshot(raw)).toThrow(SnapshotError);
  });

  it('rejects a model step with an invalid instruction version / output allowance', async () => {
    h = await createHarness();
    const raw = h.db.repos.runs.get(await h.startRun()).snapshot as { steps: Record<string, Record<string, unknown>> };
    const review = raw.steps['review' as StepKey] ?? {};

    expect(() => parseRunSnapshot({ ...raw, steps: { ...raw.steps, review: { ...review, maxOutputTokens: 0 } } })).toThrow(SnapshotError);
  });
});
