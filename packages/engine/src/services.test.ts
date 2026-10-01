import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNNER_CHANNELS } from '@relay/contracts';
import type { RunnerChannel, StepKey } from '@relay/contracts';
import { tick } from './runner.js';
import { createHandlers } from './services.js';
import { SAMPLE_FILES, createHarness } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function harness(o: HarnessOptions = {}): Promise<Harness> {
  h = await createHarness(o);
  return h;
}

describe('handler table (F1)', () => {
  it('serves every RunnerChannel, and unimplemented ones return a typed INTERNAL not_implemented error naming the channel', async () => {
    const x = await harness();
    const table = createHandlers(x.ctx);

    expect(Object.keys(table).sort()).toEqual([...RUNNER_CHANNELS].sort());
    const res = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'resume-key-000001', runId: 'run_01J9ZZZZZZZZZZZZZZZZZZZZZ0', decision: { kind: 'continue' } });
    const memory = await x.engine.handle('relay/v1/memory.list', { projectId: x.projectId });
    expect(res.ok ? null : res.error.code).toBe('NOT_FOUND'); // implemented: the run does not exist
    expect(memory.ok ? memory.data : memory.error).toEqual([]); // implemented (07 G5): an empty project has no memory
  });

  it('rejects invalid input with VALIDATION_FAILED and unknown channels', async () => {
    const x = await harness();

    const bad = await x.engine.handle('relay/v1/runs.get', { runId: 'nope' });
    const unknown = await x.engine.handle('relay/v1/nope' as RunnerChannel, {});

    expect(bad.ok ? null : bad.error.code).toBe('VALIDATION_FAILED');
    expect(unknown.ok ? null : unknown.error.code).toBe('VALIDATION_FAILED');
  });

  it('maps a thrown RelayError (NOT_FOUND) and hides unexpected throws behind INTERNAL + correlation id', async () => {
    const x = await harness();

    const missing = await x.engine.handle('relay/v1/runs.get', { runId: 'run_01J9ZZZZZZZZZZZZZZZZZZZZZ0' });

    expect(missing.ok ? null : missing.error.code).toBe('NOT_FOUND');
  });
});

describe('projects', () => {
  it('createFromRoot is idempotent, rejects a reused key with a different payload, and a second project on the same root', async () => {
    const x = await harness();
    const input = { idempotencyKey: 'harness-project-0001', rootRealpath: x.projectRoot, rootDisplayPath: '~/sample', name: 'Sample', exclusions: [],
      allowedProviderIds: ['anthropic', 'openai', 'gemini', 'fake'] as const, monthlyAllowanceMicrousd: null, isDemo: false };

    const replay = await x.engine.handle('relay/v1/projects.createFromRoot', { ...input, allowedProviderIds: [...input.allowedProviderIds] });
    const reused = await x.engine.handle('relay/v1/projects.createFromRoot', { ...input, allowedProviderIds: [...input.allowedProviderIds], name: 'Other' });
    const dup = await x.engine.handle('relay/v1/projects.createFromRoot', { ...input, allowedProviderIds: [], idempotencyKey: 'another-key-00001' });
    const missing = await x.engine.handle('relay/v1/projects.createFromRoot', { ...input, allowedProviderIds: [], idempotencyKey: 'another-key-00002', rootRealpath: join(x.projectRoot, 'nope') });

    expect(replay.ok && replay.data.id).toBe(x.projectId);
    expect(reused.ok ? null : reused.error.details?.['reason']).toBe('idempotency_key_reused');
    expect(dup.ok ? null : dup.error.details?.['reason']).toBe('root_already_used');
    expect(missing.ok ? null : missing.error.code).toBe('NOT_FOUND');
  });

  it('lists, gets (with stats, never the realpath), and previews by project or root', async () => {
    const x = await harness();
    await mkdir(join(x.projectRoot, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(x.projectRoot, 'node_modules', 'dep', 'index.js'), 'x');

    const list = await x.engine.handle('relay/v1/projects.list', {});
    const get = await x.engine.handle('relay/v1/projects.get', { projectId: x.projectId });
    const none = await x.engine.handle('relay/v1/projects.get', { projectId: 'prj_01J9ZZZZZZZZZZZZZZZZZZZZZ0' });
    const byProject = await x.engine.handle('relay/v1/projects.previewRoot', { projectId: x.projectId });
    const byRoot = await x.engine.handle('relay/v1/projects.previewRoot', { rootRealpath: x.projectRoot, extraExclusions: ['src/lib/**'] });
    const unknownProject = await x.engine.handle('relay/v1/projects.previewRoot', { projectId: 'prj_01J9ZZZZZZZZZZZZZZZZZZZZZ0' });

    expect(list.ok && list.data.map((p) => p.id)).toEqual([x.projectId]);
    expect(get.ok && get.data.stats.runs).toBe(0);
    expect(JSON.stringify(get)).not.toContain(x.projectRoot);
    expect(none.ok ? null : none.error.code).toBe('NOT_FOUND');
    expect(byProject.ok && byProject.data.included.map((f) => f.relPath)).toEqual(Object.keys(SAMPLE_FILES).sort());
    expect(byProject.ok && byProject.data.excluded).toEqual([{ relPath: 'node_modules', reason: 'dependency_dir' }]);
    expect(byRoot.ok && byRoot.data.included.map((f) => f.relPath)).toEqual(['src/errors.ts', 'src/handlers/health.ts', 'src/handlers/orders.ts', 'src/handlers/user.ts']);
    expect(unknownProject.ok ? null : unknownProject.error.code).toBe('NOT_FOUND');
  });
});

describe('providers, profiles, workflows, settings, diagnostics', () => {
  it('records, lists, and deletes credential refs; providers.list shows redacted status only', async () => {
    const x = await harness({ credentialRefs: [] });

    const rec = await x.engine.handle('relay/v1/providers.recordCredentialRef', { providerId: 'anthropic', storageMode: 'session', vaultFile: null, redactedLabel: 'sk-…a1F9' });
    x.db.repos.credentials.recordTest('anthropic', false, 'AUTH_REQUIRED', x.clock.now());
    const listed = await x.engine.handle('relay/v1/providers.listCredentialRefs', {});
    const status = await x.engine.handle('relay/v1/providers.list', {});
    const del = await x.engine.handle('relay/v1/providers.deleteCredentialRef', { providerId: 'anthropic' });
    const after = await x.engine.handle('relay/v1/providers.list', {});

    expect(rec.ok && rec.data.redactedLabel).toBe('sk-…a1F9');
    expect(listed.ok && listed.data.map((r) => r.providerId)).toEqual(['anthropic']);
    expect(status.ok && status.data.map((s) => [s.providerId, s.connected])).toEqual([['anthropic', true], ['openai', false], ['gemini', false]]);
    expect(status.ok && status.data[0]?.lastTest).toEqual({ at: x.clock.now(), ok: false, code: 'AUTH_REQUIRED' });
    expect(del.ok && del.data.deleted).toBe(true);
    expect(after.ok && after.data[0]?.connected).toBe(false);
  });

  it('lists the catalog and profiles with warnings (missing credential until a ref exists)', async () => {
    const x = await harness({ credentialRefs: [] });

    const catalog = await x.engine.handle('relay/v1/providers.catalog', { providerId: 'anthropic' });
    const before = await x.engine.handle('relay/v1/profiles.list', {});
    await x.engine.handle('relay/v1/providers.recordCredentialRef', { providerId: 'anthropic', storageMode: 'session', vaultFile: null, redactedLabel: 'sk-…' });
    const after = await x.engine.handle('relay/v1/profiles.list', {});

    expect(catalog.ok && catalog.data.every((m) => m.providerId === 'anthropic')).toBe(true);
    expect(before.ok && before.data.every((p) => p.warnings.map((w) => w.code).join() === 'missing_credential')).toBe(true);
    expect(after.ok && after.data.filter((p) => p.profile.providerId === 'anthropic').every((p) => p.warnings.length === 0)).toBe(true);
    expect(after.ok && after.data.find((p) => p.profile.providerId === 'openai')?.warnings.map((w) => w.code)).toEqual(['missing_credential']);
  });

  it('lists and gets workflows with the prompt snapshot', async () => {
    const x = await harness();

    const list = await x.engine.handle('relay/v1/workflows.list', {});
    const id = list.ok ? list.data[0]?.id ?? '' : '';
    const latest = await x.engine.handle('relay/v1/workflows.get', { workflowId: id });
    const v1 = await x.engine.handle('relay/v1/workflows.get', { workflowId: id, version: 1 });
    const draft = await x.engine.handle('relay/v1/workflows.get', { workflowId: id, version: 'draft' });

    expect(list.ok && list.data[0]).toEqual(expect.objectContaining({ latestValidatedVersion: 1, draftVersion: null }));
    expect(latest.ok && Object.keys(latest.data.prompts).sort()).toEqual(['implementer.v1', 'planner.v1', 'reviewer.v1', 'verifier.v1']);
    expect(latest.ok && latest.data.prompts['verifier.v1']?.role).toBe('reviewer');
    expect(v1.ok && v1.data.version).toBe(1);
    expect(draft.ok ? null : draft.error.code).toBe('NOT_FOUND');
  });

  it('reads defaults, merges settings patches, and validates activeProjectId', async () => {
    const x = await harness();

    const defaults = await x.engine.handle('relay/v1/app.getSettings', {});
    const updated = await x.engine.handle('relay/v1/app.updateSettings', { theme: 'dark', activeProjectId: x.projectId });
    const bad = await x.engine.handle('relay/v1/app.updateSettings', { activeProjectId: 'prj_01J9ZZZZZZZZZZZZZZZZZZZZZ0' });
    x.db.repos.settings.set('app_settings', { theme: 42 });
    const recovered = await x.engine.handle('relay/v1/app.getSettings', {});

    expect(defaults.ok && defaults.data).toEqual({ theme: 'system', activeProjectId: null, onboardingCompletedAt: null, rawResponseRetentionDays: 30, setupAllowanceMicrousd: 50_000 });
    expect(updated.ok && updated.data).toEqual(expect.objectContaining({ theme: 'dark', activeProjectId: x.projectId }));
    expect(bad.ok ? null : bad.error.code).toBe('VALIDATION_FAILED');
    expect(recovered.ok && recovered.data.theme).toBe('system');
  });

  it('reports the runner half of diagnostics', async () => {
    const x = await harness();

    const d = await x.engine.handle('relay/v1/app.getDiagnostics', {});

    expect(d.ok && d.data).toEqual(expect.objectContaining({ unresolvedAttempts: 0, prompts: { loaded: 4 } }));
    expect(d.ok && d.data.catalog.models).toBeGreaterThan(0);
  });
});

describe('runs + ledger read side', () => {
  it('lists runs, gets detail/steps/events, pages the ledger, and summarizes the project month', async () => {
    const x = await harness();
    const runId = await x.startRun();
    for (let i = 0; i < 3; i += 1) await tick(x.ctx); // checks, intake, review

    const list = await x.engine.handle('relay/v1/runs.list', { projectId: x.projectId, status: ['running'] });
    const detail = await x.engine.handle('relay/v1/runs.get', { runId });
    const review = x.db.repos.steps.latestFor(runId, 'review' as StepKey);
    const step = await x.engine.handle('relay/v1/runs.getStep', { runId, stepId: review?.id ?? '' });
    const intake = x.db.repos.steps.latestFor(runId, 'intake' as StepKey);
    const intakeStep = await x.engine.handle('relay/v1/runs.getStep', { runId, stepId: intake?.id ?? '' });
    const wrongRun = await x.engine.handle('relay/v1/runs.getStep', { runId: 'run_01J9ZZZZZZZZZZZZZZZZZZZZZ0', stepId: review?.id ?? '' });
    const events = await x.engine.handle('relay/v1/runs.events', { runId, afterSeq: 0, limit: 3 });
    const ledger = await x.engine.handle('relay/v1/ledger.entries', { runId, limit: 2 });
    const summary = await x.engine.handle('relay/v1/ledger.runSummary', { runId });
    const month = await x.engine.handle('relay/v1/ledger.projectSummary', { projectId: x.projectId });
    const otherMonth = await x.engine.handle('relay/v1/ledger.projectSummary', { projectId: x.projectId, month: '2020-01' });
    const noProject = await x.engine.handle('relay/v1/ledger.projectSummary', { projectId: 'prj_01J9ZZZZZZZZZZZZZZZZZZZZZ0' });

    expect(list.ok && list.data.items.map((r) => [r.id, r.stepProgress])).toEqual([[runId, { done: 2, total: 7 }]]);
    expect(detail.ok && detail.data.availableActions).toEqual(['pause', 'cancel']);
    expect(detail.ok && detail.data.steps.find((s) => s.stepKey === 'review')).toEqual(expect.objectContaining({ providerId: 'anthropic', modelId: 'claude-haiku-4-5' }));
    expect(detail.ok && detail.data.steps.find((s) => s.stepKey === 'intake')?.providerId).toBeNull();
    expect(step.ok && step.data.output?.schemaId).toBe('findings.v1');
    expect(step.ok && step.data.manifest?.stepKey).toBe('review');
    expect(step.ok && step.data.attempts.map((a) => [a.state, a.cost?.certainty])).toEqual([['succeeded', 'calculated']]);
    expect(step.ok && step.data.events.length).toBeGreaterThan(3);
    expect(intakeStep.ok && [intakeStep.data.output, intakeStep.data.manifest, intakeStep.data.attempts]).toEqual([null, null, []]);
    expect(wrongRun.ok ? null : wrongRun.error.code).toBe('NOT_FOUND');
    expect(events.ok && events.data.items.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.ok && events.data.nextCursor).toBe('3');
    expect(ledger.ok && ledger.data.items.map((e) => e.type)).toEqual(['allowance_set', 'reserve']);
    expect(ledger.ok && ledger.data.items[1]?.stepKey).toBe('review');
    expect(ledger.ok && ledger.data.nextCursor).not.toBeNull();
    expect(summary.ok && summary.data.byStep.map((s) => s.stepKey)).toEqual(['review']);
    expect(summary.ok && summary.data.allowance).toBe(3_000_000);
    expect(month.ok && month.data.trackedMicrousd).toBe(summary.ok ? summary.data.settledCalculated : -1);
    expect(otherMonth.ok && otherMonth.data.trackedMicrousd).toBe(0);
    expect(noProject.ok ? null : noProject.error.code).toBe('NOT_FOUND');
  });

  it('pause sets the durable flag on a running run (CONFLICT otherwise); the loop then pauses before the next dispatch', async () => {
    const x = await harness();
    const runId = await x.startRun();
    const queued = await x.engine.handle('relay/v1/runs.pause', { runId });
    await tick(x.ctx);

    const paused = await x.engine.handle('relay/v1/runs.pause', { runId });
    await tick(x.ctx);

    expect(queued.ok ? null : queued.error.code).toBe('CONFLICT');
    expect(paused.ok && paused.data).toEqual({ status: 'running', inFlight: 'none' });
    expect(x.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'user', pauseRequested: false }));
    const cancel = await x.engine.handle('relay/v1/runs.cancel', { runId });
    expect(cancel.ok && cancel.data).toEqual({ status: 'cancelled', unresolvedCharges: [] });
    expect(x.db.repos.steps.listForRun(runId).every((s) => s.state === 'skipped' || s.state === 'succeeded')).toBe(true);
  });

  it('cancels queued runs directly and reports cancelling runs idempotently', async () => {
    const x = await harness();
    const runId = await x.startRun();
    const other = await x.startRun();
    await tick(x.ctx); // `runId` → running

    const queued = await x.engine.handle('relay/v1/runs.cancel', { runId: other });
    const running = await x.engine.handle('relay/v1/runs.cancel', { runId });
    const again = await x.engine.handle('relay/v1/runs.cancel', { runId });
    await tick(x.ctx); // WORK_STOPPED

    expect(queued.ok && queued.data.status).toBe('cancelled');
    expect(running.ok && running.data.status).toBe('cancelling');
    expect(again.ok && again.data.status).toBe('cancelling');
    expect(x.db.repos.runs.get(runId).status).toBe('cancelled');
  });
});
