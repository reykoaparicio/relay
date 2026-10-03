import type { CatalogModel, StepKey } from '@relay/contracts';
import { catalogModelSchema, epochMs } from '@relay/contracts';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { FixtureDb } from '../testing/fixtures.js';
import { CAPABILITIES, SPEC, newId, openFixtureDb, profileSnapshot, seedProject, seedRun, seedStep, sha } from '../testing/fixtures.js';
import type { ProjectRow, ProjectWithRoot } from '../types.js';

describe('ProjectRepo', () => {
  let f: FixtureDb;
  beforeEach(async () => {
    f = await openFixtureDb();
  });
  afterEach(async () => {
    await f.db.dispose();
  });

  it('never exposes root_realpath on the renderer-safe row type or object', () => {
    const p = seedProject(f.db, f.clock, { root: '/Users/me/code/app' });

    const withRoot = f.db.repos.projects.getWithRoot(p.id);

    expectTypeOf<ProjectRow>().not.toHaveProperty('rootRealpath');
    expectTypeOf<ProjectWithRoot>().toHaveProperty('rootRealpath');
    expect(Object.keys(f.db.repos.projects.get(p.id))).not.toContain('rootRealpath');
    expect(JSON.stringify(f.db.repos.projects.list())).not.toContain('/Users/me');
    expect(withRoot.rootRealpath).toBe('/Users/me/code/app');
    expect(() => f.db.repos.projects.getWithRoot(newId('project'))).toThrow();
  });

  it('updates with optimistic concurrency, archives, and lists', () => {
    const p = seedProject(f.db, f.clock);
    f.clock.advance(10);

    const updated = f.db.repos.projects.update(p.id, { name: 'renamed', monthlyAllowanceMicrousd: null, exclusions: ['*.log'] }, p.updatedAt);
    const stale = f.db.repos.projects.update(p.id, { name: 'again' }, p.updatedAt);
    const missing = f.db.repos.projects.update(newId('project'), {}, p.updatedAt);
    const archived = f.db.repos.projects.archive(p.id);

    expect(updated.ok && updated.value.name).toBe('renamed');
    expect(updated.ok && updated.value.exclusions).toEqual(['*.log']);
    expect(!stale.ok && stale.error.code).toBe('CONFLICT');
    expect(!missing.ok && missing.error.code).toBe('NOT_FOUND');
    expect(archived).toBe(true);
    expect(f.db.repos.projects.archive(p.id)).toBe(false);
    expect(f.db.repos.projects.list()).toEqual([]);
    expect(f.db.repos.projects.list({ includeArchived: true })).toHaveLength(1);
    expect(f.db.repos.projects.find(newId('project'))).toBeUndefined();
    expect(() => f.db.repos.projects.get(newId('project'))).toThrow();
  });

  it('archive strictly advances updated_at at the same ms, so a stale update CAS conflicts (B1)', () => {
    const p = seedProject(f.db, f.clock);
    // Clock frozen at the insert ms: archive must still move updated_at forward.

    expect(f.db.repos.projects.archive(p.id)).toBe(true);
    const archived = f.db.repos.projects.get(p.id);
    const stale = f.db.repos.projects.update(p.id, { name: 'ghost' }, p.updatedAt);
    const current = f.db.repos.projects.update(p.id, { name: 'ghost' }, archived.updatedAt);

    expect(archived.updatedAt).toBe(p.updatedAt + 1);
    expect(archived.archivedAt).toBe(f.clock.now());
    expect(!stale.ok && stale.error.code).toBe('CONFLICT');
    // Even with the current updated_at, an archived project is read-only.
    expect(!current.ok && current.error.code).toBe('CONFLICT');
    expect(f.db.repos.projects.get(p.id).name).toBe('sample-api');
  });

  it('archive never moves updated_at backwards when the clock goes back (B1)', () => {
    const p = seedProject(f.db, f.clock);
    f.clock.advance(100);
    const r = f.db.repos.projects.update(p.id, { name: 'renamed' }, p.updatedAt);
    f.clock.advance(-500);

    f.db.repos.projects.archive(p.id);

    expect(r.ok && f.db.repos.projects.get(p.id).updatedAt).toBe(r.ok && r.value.updatedAt + 1);
  });

  it('computes dashboard stats', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    f.db.repos.ledger.append([
      { scope: 'run', type: 'settle', bucket: 'settled', deltaMicrousd: 42, certainty: 'reported', runId: run.id, projectId: p.id, createdAt: epochMs(500) },
      { scope: 'run', type: 'settle', bucket: 'settled', deltaMicrousd: 8, certainty: 'reported', runId: run.id, projectId: p.id, createdAt: epochMs(50) },
    ]);

    const stats = f.db.repos.projects.stats(p.id, epochMs(100));

    expect(stats).toEqual({ runs: 1, activeRunId: run.id, approvedMemory: 0, suggestions: 0, trackedMonthMicrousd: 42 });
  });
});

describe('settings, credentials, catalog, workflows, config revisions, approvals, events', () => {
  let f: FixtureDb;
  beforeEach(async () => {
    f = await openFixtureDb();
  });
  afterEach(async () => {
    await f.db.dispose();
  });

  it('SettingsRepo round-trips JSON values', () => {
    f.db.repos.settings.set('theme', 'dark');
    f.db.repos.settings.set('theme', { v: 2 });

    expect(f.db.repos.settings.get('theme')).toEqual({ v: 2 });
    expect(f.db.repos.settings.get('none')).toBeUndefined();
  });

  it('CredentialRefRepo upserts one ref per provider and records tests', () => {
    const repo = f.db.repos.credentials;
    const id = newId('credentialRef');

    repo.upsert({ id, providerId: 'anthropic', storageMode: 'os_protected', vaultFile: `secrets/${id}.bin`, redactedLabel: 'sk-…a1F9' });
    const tested = repo.recordTest('anthropic', false, 'AUTH_REQUIRED', epochMs(5), 'run');
    const afterTest = repo.get('anthropic');
    const replaced = repo.upsert({ id: newId('credentialRef'), providerId: 'anthropic', storageMode: 'session', vaultFile: null, redactedLabel: 'sk-…zz' });

    expect(tested).toBe(true);
    expect(afterTest?.lastTest).toEqual({ at: 5, ok: false, code: 'AUTH_REQUIRED', source: 'run' });
    expect(replaced.id).toBe(id);
    expect(replaced.storageMode).toBe('session');
    expect(replaced.lastTest).toBeNull();
    expect(repo.list()).toHaveLength(1);
    expect(repo.recordTest('anthropic', true, null, epochMs(6), 'connection_test')).toBe(true);
    expect(repo.get('anthropic')?.lastTest).toEqual({ at: 6, ok: true, code: null, source: 'connection_test' });
    expect(repo.recordTest('openai', true, null, epochMs(1), 'connection_test')).toBe(false);
    expect(repo.delete('anthropic')).toBe(true);
    expect(repo.get('anthropic')).toBeUndefined();
  });

  it('CatalogRepo keeps versions immutable and returns the latest', () => {
    const entry = (version: string, input: number): CatalogModel =>
      catalogModelSchema.parse({
        providerId: 'fake',
        modelId: 'fake-model',
        catalogVersion: version,
        displayName: 'Fake',
        capabilities: CAPABILITIES,
        prices: { input, output: 1, cacheRead: 1, cacheWrite: 1 },
        effectiveDate: version,
        source: 'https://relay.invalid/pricing',
        sourceRetrievedAt: version,
      });
    const repo = f.db.repos.catalog;

    const first = repo.upsertMany([entry('2026-09-25', 5), entry('2026-10-01', 7)]);
    const again = repo.upsertMany([entry('2026-09-25', 999)]);

    expect(first).toBe(2);
    expect(again).toBe(0);
    expect(repo.get('fake', 'fake-model')?.prices.input).toBe(7);
    expect(repo.get('fake', 'fake-model', '2026-09-25')?.prices.input).toBe(5);
    expect(repo.get('fake', 'nope')).toBeUndefined();
    expect(repo.list('fake').map((c) => c.catalogVersion)).toEqual(['2026-10-01']);
    expect(repo.list()).toHaveLength(1);
    expect(repo.latestVersion()).toBe('2026-10-01');
  });

  it('CatalogRepo.upsertMany is all-or-nothing (B2)', () => {
    const good = catalogModelSchema.parse({
      providerId: 'fake',
      modelId: 'atomic',
      catalogVersion: '2026-09-25',
      displayName: 'Atomic',
      capabilities: CAPABILITIES,
      prices: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      effectiveDate: '2026-09-25',
      source: 'https://relay.invalid/pricing',
      sourceRetrievedAt: '2026-09-25',
    });
    const bad = { ...good, modelId: 'broken', displayName: null as unknown as string };

    expect(() => f.db.repos.catalog.upsertMany([good, bad])).toThrow(/NOT NULL constraint failed/);
    expect(f.db.repos.catalog.get('fake', 'atomic')).toBeUndefined();
  });

  it('WorkflowRepo manages drafts with CAS and validated versions', () => {
    const repo = f.db.repos.workflows;
    const wf = repo.ensureWorkflow('rpf', 'Review');
    const same = repo.ensureWorkflow('rpf', 'Ignored');
    const draftId = newId('workflowVersion');
    repo.insertVersion({
      id: draftId,
      workflowId: wf.id,
      version: 1,
      status: 'draft',
      schemaVersion: 1,
      spec: SPEC,
      prompts: { 'reviewer.v1': 'a' },
      contentHash: sha('1'),
      basedOnVersion: null,
      createdAt: f.clock.now(),
    });

    const edited = repo.updateDraft(wf.id, { prompts: { 'reviewer.v1': 'b' }, contentHash: sha('2') }, 1);
    const stale = repo.updateDraft(wf.id, { contentHash: sha('3') }, 1);
    const validated = repo.markValidated(draftId, epochMs(9));
    const noDraft = repo.updateDraft(wf.id, { contentHash: sha('4') }, 2);

    expect(same.id).toBe(wf.id);
    expect(edited.ok && edited.value.prompts).toEqual({ 'reviewer.v1': 'b' });
    expect(edited.ok && edited.value.draftRevision).toBe(2);
    expect(!stale.ok && stale.error.code).toBe('CONFLICT');
    expect(validated).toBe(true);
    expect(repo.markValidated(draftId, epochMs(10))).toBe(false);
    expect(!noDraft.ok && noDraft.error.code).toBe('NOT_FOUND');
    expect(repo.latestValidated(wf.id)?.id).toBe(draftId);
    expect(repo.getVersion(wf.id, 1)?.spec.steps[0]?.id).toBe('review');
    expect(repo.getVersion(wf.id, 'draft')).toBeUndefined();
    expect(repo.getWorkflow(wf.id)?.slug).toBe('rpf');
    expect(repo.getWorkflow(newId('workflow'))).toBeUndefined();
    expect(repo.listWorkflows()).toHaveLength(1);
    expect(repo.listVersions(wf.id).map((v) => [v.version, v.status])).toEqual([[1, 'validated']]);
    expect(repo.listVersions(newId('workflow'))).toEqual([]);
  });

  it('ConfigRevisionRepo appends max+1 and resolves the effective profile', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const prev = profileSnapshot();
    const next = { ...prev, name: 'Balanced' };

    const none = f.db.repos.configRevisions.effectiveProfile(run.id, 'review' as StepKey);
    const r1 = f.db.repos.configRevisions.append(run.id, 'review' as StepKey, prev, next, 'budget_cheaper_profile');
    const r2 = f.db.repos.configRevisions.append(run.id, 'plan' as StepKey, prev, prev, 'user_switch');

    expect(none).toBeNull();
    expect([r1.revision, r2.revision]).toEqual([1, 2]);
    expect(f.db.repos.configRevisions.effectiveProfile(run.id, 'review' as StepKey)?.name).toBe('Balanced');
    expect(f.db.repos.configRevisions.list(run.id).map((r) => r.reason)).toEqual(['budget_cheaper_profile', 'user_switch']);
  });

  it('L-1: a config revision records the step output limit (null when absent); latestFor returns the newest row', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const prev = profileSnapshot();
    const repo = f.db.repos.configRevisions;

    expect(repo.latestFor(run.id, 'review' as StepKey)).toBeNull();
    repo.append(run.id, 'review' as StepKey, prev, { ...prev, name: 'Economy' }, 'user_switch', 64_000);
    repo.append(run.id, 'plan' as StepKey, prev, prev, 'user_switch');

    expect([repo.latestFor(run.id, 'review' as StepKey)?.profileSnapshot.name, repo.latestFor(run.id, 'review' as StepKey)?.maxOutputTokens]).toEqual(['Economy', 64_000]);
    expect(repo.latestFor(run.id, 'plan' as StepKey)?.maxOutputTokens).toBeNull();
    expect(repo.list(run.id).map((r) => r.maxOutputTokens)).toEqual([64_000, null]);
    expect(() => repo.append(run.id, 'review' as StepKey, prev, prev, 'user_switch', 0)).toThrow(/CHECK constraint failed/);
  });

  it('ApprovalRepo decides with CAS and tracks pending / latest approved', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const step = seedStep(f.db, f.clock, run.id, { stepKey: 'approve' });
    const plan = f.db.repos.artifacts.insertIfAbsent({
      id: newId('artifact'),
      runId: run.id,
      projectId: p.id,
      kind: 'plan',
      relPath: 'artifacts/run/plan',
      sha256: sha('1'),
      sizeBytes: 1,
      mediaType: 'application/json',
      createdAt: f.clock.now(),
    });
    const insert = () =>
      f.db.repos.approvals.insert({
        id: newId('approval'),
        runId: run.id,
        stepRunId: step.id,
        planArtifactId: plan.id,
        planHash: sha('2'),
        contextHash: sha('3'),
        fileScope: ['src/a.ts'] as never,
        requestedPermissions: { providers: ['fake'] },
        createdAt: f.clock.now(),
      });
    const a = insert();

    const pending = f.db.repos.approvals.pendingForRun(run.id)?.id;
    const decided = f.db.repos.approvals.decide(a.id, 'approved', 'ok', epochMs(7));
    const twice = f.db.repos.approvals.decide(a.id, 'rejected', null, epochMs(8));
    const approved = f.db.repos.approvals.latestApprovedForRun(run.id);
    const b = insert();
    f.db.repos.approvals.invalidate(b.id, 'scope_changed', epochMs(9));

    expect(pending).toBe(a.id);
    expect(decided).toBe(true);
    expect(twice).toBe(false);
    expect(approved?.decisionNote).toBe('ok');
    expect(approved?.fileScope).toEqual(['src/a.ts']);
    expect(f.db.repos.approvals.pendingForRun(run.id)).toBeUndefined();
    expect(f.db.repos.approvals.get(b.id)?.invalidatedReason).toBe('scope_changed');
    expect(f.db.repos.approvals.decide(b.id, 'approved', null, epochMs(10))).toBe(false);
    expect(f.db.repos.approvals.get(newId('approval'))).toBeUndefined();
  });

  it('EventRepo assigns per-run sequence numbers and pages after a seq', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const other = seedRun(f.db, f.clock, p.id);

    const e1 = f.db.repos.events.append(run.id, 'run.created', { goal: 'x' });
    f.db.repos.events.append(run.id, 'run.status_changed', { to: 'running' });
    const o1 = f.db.repos.events.append(other.id, 'run.created', {});

    expect([e1.seq, o1.seq]).toEqual([1, 1]);
    expect(f.db.repos.events.lastSeq(run.id)).toBe(2);
    expect(f.db.repos.events.list(run.id, 1, 10).map((e) => e.type)).toEqual(['run.status_changed']);
    expect(f.db.repos.events.lastSeq(newId('run'))).toBe(0);
  });
});
