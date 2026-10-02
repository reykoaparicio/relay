// Behaviour pinned by the improvement-review refactor (items 3, 6, 8, 9, 11, 13, 15, 21): the shared idempotency
// helpers, the one fail-closed adapter-lookup policy, the step-cost certainty ordering, the single imported-diff
// reader, the `locked_field` draft-patch rule, the snapshot-binding statement, and the >100 paused-run re-evaluation.
import { createTwoFilesPatch } from 'diff';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayError, errors, ok } from '@relay/contracts';
import type { ApprovalId, ArtifactId, CostCertainty, Microusd, ProjectId, RunId } from '@relay/contracts';
import type { LedgerEntryRow } from '@relay/storage';
import { preservedApproval } from './approval-binding.js';
import { isAbortReason } from './cancellation.js';
import { requestHash } from './hash.js';
import { recordResult, replayStoredId } from './idempotency.js';
import { findProfileByName } from './profiles.js';
import { adapterOf, isModelRejected, liveCapabilities } from './provider-lookup.js';
import { stepCost } from './report.js';
import { RESNAPSHOT_KIND, PROJECT_CHANGED_MARK, hasSnapshotPreserved } from './snapshot.js';
import { readInputDiff } from './steps/input-diff.js';
import { SAMPLE_FILES, createHarness } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';
import { drive } from './testing/drive.js';
import { applyDraftPatch } from './workflows.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function harness(o: HarnessOptions = {}): Promise<Harness> {
  h = await createHarness(o);
  return h;
}

const noAdapters: HarnessOptions['providers'] = (base) => ({ list: () => base.list(), get: () => { throw new Error('no adapter'); } });
const GHOST_MODEL = 'claude-not-a-model';
/** Adapters that reject GHOST_MODEL the way the catalog-backed HTTP adapters reject any model missing from their catalog. */
const catalogAdapters: HarnessOptions['providers'] = (base) => ({ list: () => base.list(), get: (id) => {
  const adapter = base.get(id);
  return { ...adapter, capabilities: (modelId: string) => modelId === GHOST_MODEL
    ? Promise.reject(new RelayError(errors.modelUnsupported({ providerId: id, modelId, reason: 'not_in_catalog' })))
    : adapter.capabilities(modelId) };
} });
const MODEL_UNKNOWN_MESSAGE = 'This model is not in the price catalog, so its cost cannot be tracked.';
const errOf = (res: { ok: boolean; error?: { code: string; details?: Record<string, unknown> | undefined } }) =>
  res.ok ? null : [res.error?.code, res.error?.details?.['reason']];

describe('idempotency helpers (6)', () => {
  it('a stored result whose id is malformed replays as INTERNAL idempotency_result_invalid, never a cast', async () => {
    const x = await harness();
    const runId = await x.startRun();
    const input = { idempotencyKey: 'resume-bad-id-0001', runId, decision: { kind: 'continue' as const } };
    x.db.repos.idempotency.put('runs.resume', input.idempotencyKey, requestHash({ ...input }), { ids: { runId: 'not-a-run-id' } });

    const res = await x.engine.handle('relay/v1/runs.resume', input);

    expect(errOf(res)).toEqual(['INTERNAL', 'idempotency_result_invalid']);
  });

  it('replayStoredId: null for a new key, CONFLICT for another request hash; recordResult asserts the put', async () => {
    const x = await harness();
    const runId = await x.startRun();
    const req = { op: 'test.op', key: 'k-0000000000000001', hash: requestHash({ a: 1 }) };

    const fresh = replayStoredId(x.ctx, x.db.repos, req, 'runId', 'run');
    x.db.tx('immediate', (r) => { recordResult(r, req, { ids: { runId } }); });
    const replayed = replayStoredId(x.ctx, x.db.repos, req, 'runId', 'run');
    const other = replayStoredId(x.ctx, x.db.repos, { ...req, hash: requestHash({ a: 2 }) }, 'runId', 'run');

    expect(fresh).toBeNull();
    expect(replayed).toEqual(ok({ id: runId, status: undefined }));
    expect(other !== null && errOf(other)).toEqual(['CONFLICT', 'idempotency_key_reused']);
    expect(() => { x.db.tx('immediate', (r) => { recordResult(r, { ...req, hash: requestHash({ a: 3 }) }, { ids: {} }); }); }).toThrow(/idempotency put failed/);
  });
});

describe('adapter lookup: one fail-closed policy (8)', () => {
  it('adapterOf / liveCapabilities: no adapter → MODEL_UNSUPPORTED no_adapter; a throwing capabilities() is logged and fails closed', async () => {
    const x = await harness();
    const throwing = { ...x.ctx, providers: { list: () => x.ctx.providers.list(), get: () => ({ ...x.ctx.providers.get('anthropic'),
      capabilities: () => Promise.reject(new Error('boom sk-ant-api03-SECRETSECRETSECRET')) }) } };

    const none = adapterOf({ providers: { list: () => [], get: () => { throw new Error('none'); } } }, 'openai');
    const live = await liveCapabilities(x.ctx, 'anthropic', 'claude-haiku-4-5');
    const threw = await liveCapabilities(throwing, 'anthropic', 'claude-haiku-4-5');

    expect(errOf(none)).toEqual(['MODEL_UNSUPPORTED', 'no_adapter']);
    expect(live.ok).toBe(true);
    expect(threw.ok ? null : [threw.error.code, threw.error.details?.['reason'], threw.error.details?.['modelId']]).toEqual(['MODEL_UNSUPPORTED', 'no_adapter', 'claude-haiku-4-5']);
    const logged = x.logger.entries.find((e) => e.event === 'provider.capabilities_failed');
    expect(logged?.fields?.['err']).toContain('boom');
    expect(JSON.stringify(logged)).not.toContain('SECRETSECRETSECRET');
  });

  it('liveCapabilities passes an adapter\'s MODEL_UNSUPPORTED through unlogged (impr bug-hunt finding 2)', async () => {
    const x = await harness({ providers: catalogAdapters });

    const ghost = await liveCapabilities(x.ctx, 'anthropic', GHOST_MODEL);
    const known = await liveCapabilities(x.ctx, 'anthropic', 'claude-haiku-4-5');
    const none = await liveCapabilities({ ...x.ctx, providers: { list: () => [], get: () => { throw new Error('none'); } } }, 'anthropic', GHOST_MODEL);

    expect(errOf(ghost)).toEqual(['MODEL_UNSUPPORTED', 'not_in_catalog']);
    expect(isModelRejected(ghost)).toBe(true);
    expect(isModelRejected(known)).toBe(false);
    expect(errOf(none)).toEqual(['MODEL_UNSUPPORTED', 'no_adapter']);
    expect(isModelRejected(none)).toBe(false);
    expect(x.logger.entries.filter((e) => e.event === 'provider.capabilities_failed')).toEqual([]);
  });

  it('a model the adapter does not serve is one model_unknown in profiles.upsert, workflows.validate and runs.preflight, not no_adapter', async () => {
    const x = await harness({ providers: catalogAdapters });
    const workflow = x.db.repos.workflows.listWorkflows()[0];
    const spec = workflow === undefined ? undefined : x.db.repos.workflows.getVersion(workflow.id, 1)?.spec;
    const firstModelStep = spec?.steps.find((s) => s.kind === 'model');
    const row = firstModelStep?.kind === 'model' ? findProfileByName(x.db.repos, firstModelStep.profile) : undefined;
    if (workflow === undefined || spec === undefined || row === undefined) throw new Error('fixture');
    const ghostSteps = spec.steps.flatMap((s, i) => (s.kind === 'model' && findProfileByName(x.db.repos, s.profile)?.id === row.id ? [{ i, id: s.id }] : []));
    x.db.tx('immediate', (r) => {
      const saved = r.profiles.upsert({ id: row.id, name: row.name, providerId: row.providerId, modelId: GHOST_MODEL, params: row.params,
        capabilitiesSnapshot: row.capabilitiesSnapshot, catalogVersion: row.catalogVersion }, row.revision);
      if (!saved.ok) throw new Error('upsert');
    });

    const upsert = await x.engine.handle('relay/v1/profiles.upsert', { profile: { name: 'Ghost', providerId: 'anthropic', modelId: GHOST_MODEL,
      params: { maxOutputTokens: 4000, refusalFallback: 'off' } } });
    const validate = await x.engine.handle('relay/v1/workflows.validate', { workflowId: workflow.id, version: 1 });
    const preflight = await x.engine.handle('relay/v1/runs.preflight', { projectId: x.projectId, workflowId: workflow.id, workflowVersion: 1,
      goal: 'Check the adapters.', input: { kind: 'files', relPaths: Object.keys(SAMPLE_FILES) } });

    expect(errOf(upsert)).toEqual(['MODEL_UNSUPPORTED', 'model_unknown']);
    expect(upsert.ok ? null : upsert.error.userMessage).toBe(MODEL_UNKNOWN_MESSAGE);
    expect(ghostSteps.length).toBeGreaterThan(0);
    for (const { i, id } of ghostSteps) {
      expect(validate.ok && validate.data.issues.filter((v) => v.path === `steps[${String(i)}].profile`).map((v) => [v.code, v.message]))
        .toEqual([['model_unknown', MODEL_UNKNOWN_MESSAGE]]);
      expect(preflight.ok && preflight.data.issues.filter((v) => v.path === `profileOverrides.${id}`).map((v) => v.code)).toEqual(['model_unknown']);
    }
    expect(validate.ok && validate.data.issues.some((v) => v.code === 'no_adapter')).toBe(false);
    expect(preflight.ok && preflight.data.issues.some((v) => v.code === 'no_adapter')).toBe(false);
    expect(x.logger.entries.filter((e) => e.event === 'provider.capabilities_failed')).toEqual([]);
  });

  it('profiles.upsert, providers.test, workflows.validate and runs.preflight all report no_adapter when no adapter serves the provider', async () => {
    const x = await harness({ providers: noAdapters });
    const workflow = x.db.repos.workflows.listWorkflows()[0];
    if (workflow === undefined) throw new Error('workflow');

    const upsert = await x.engine.handle('relay/v1/profiles.upsert', { profile: { name: 'Mine', providerId: 'anthropic', modelId: 'claude-haiku-4-5',
      params: { maxOutputTokens: 4000, refusalFallback: 'off' } } });
    const test = await x.engine.handle('relay/v1/providers.test', { providerId: 'anthropic' });
    const validate = await x.engine.handle('relay/v1/workflows.validate', { workflowId: workflow.id, version: 1 });
    const preflight = await x.engine.handle('relay/v1/runs.preflight', { projectId: x.projectId, workflowId: workflow.id, workflowVersion: 1,
      goal: 'Check the adapters.', input: { kind: 'files', relPaths: Object.keys(SAMPLE_FILES) } });

    expect(errOf(upsert)).toEqual(['MODEL_UNSUPPORTED', 'no_adapter']);
    expect(errOf(test)).toEqual(['MODEL_UNSUPPORTED', 'no_adapter']);
    expect(validate.ok && validate.data.valid).toBe(false);
    expect(validate.ok && validate.data.issues.filter((i) => i.code === 'no_adapter').map((i) => i.path)).toEqual(['steps[0].profile', 'steps[1].profile', 'steps[3].profile', 'steps[4].profile']);
    expect(preflight.ok && preflight.data.issues.filter((i) => i.code === 'no_adapter').length).toBe(4);
  });
});

describe('report step cost certainty (9)', () => {
  const e = (bucket: LedgerEntryRow['bucket'], certainty: CostCertainty | null, delta: number): LedgerEntryRow =>
    ({ attemptId: 'att_a', type: bucket === 'settled' ? 'settle' : bucket === 'unknown' ? 'move_to_unknown' : 'reserve', bucket, certainty, deltaMicrousd: delta }) as unknown as LedgerEntryRow;

  it('an all-reported step reports reported; mixed takes the weakest; an open unknown liability is unknown; nothing settled is calculated', () => {
    expect(stepCost([e('reserved', null, 10), e('settled', 'reported', 7), e('settled', 'reported', 3)])).toEqual({ settledMicrousd: 10 as Microusd, certainty: 'reported', unknownMicrousd: 0 as Microusd });
    expect(stepCost([e('settled', 'reported', 7), e('settled', 'calculated', 3)]).certainty).toBe('calculated');
    expect(stepCost([e('settled', 'reported', 7), e('settled', 'estimated', 3)]).certainty).toBe('estimated');
    expect(stepCost([e('settled', 'reported', 7), e('unknown', 'unknown', 5)])).toEqual({ settledMicrousd: 7 as Microusd, certainty: 'unknown', unknownMicrousd: 5 as Microusd });
    expect(stepCost([e('reserved', null, 10)]).certainty).toBe('calculated');
    expect(stepCost([])).toEqual({ settledMicrousd: 0 as Microusd, certainty: 'calculated', unknownMicrousd: 0 as Microusd });
  });
});

describe('snapshot binding in one statement (3)', () => {
  it('hasSnapshotPreserved / preservedApproval follow the latest re-snapshot, preserve, and invalidation events', async () => {
    const x = await harness();
    const runId = await x.startRun();
    const r = x.db.repos;
    const approvalId = 'apr_01J9ZZZZZZZZZZZZZZZZZZZZZ1' as ApprovalId;
    const append = (type: 'context.assembled' | 'run.snapshot_preserved' | 'error.recorded', payload: object) =>
      x.db.tx('immediate', (tx) => tx.events.append(runId, type, payload));

    const before = hasSnapshotPreserved(r, runId);
    append('error.recorded', { kind: PROJECT_CHANGED_MARK, approvalId });
    append('run.snapshot_preserved', { at: 1 });
    const preserved = hasSnapshotPreserved(r, runId);
    const noApprovalRow = preservedApproval(r, runId); // the id names no approval row → undefined
    append('context.assembled', { kind: RESNAPSHOT_KIND });
    const afterResnapshot = hasSnapshotPreserved(r, runId);

    expect([before, preserved, afterResnapshot]).toEqual([false, true, false]);
    expect(noApprovalRow).toBeUndefined();
  });
});

describe('readInputDiff: the intake checks everywhere (15)', () => {
  const diffText = (): string => {
    const [rel, text] = Object.entries(SAMPLE_FILES)[0] ?? ['', ''];
    return createTwoFilesPatch(`a/${rel}`, `b/${rel}`, text, `// changed\n${text}`);
  };

  it('returns the stored text for the project; NOT_FOUND for a missing / other-kind / other-project / oversized artifact; the store error for unreadable bytes', async () => {
    const x = await harness();
    const imported = await x.engine.handle('relay/v1/artifacts.importDiffText', { projectId: x.projectId, text: diffText(), fileName: 'a.diff' });
    if (!imported.ok) throw new Error(imported.error.code);
    const id = imported.data.artifactId;
    const row = x.db.repos.artifacts.get(id);
    if (row === undefined) throw new Error('row');
    const insert = (kind: 'input_diff' | 'report', sizeBytes: number, relPath: string): ArtifactId => {
      const art = x.db.tx('immediate', (tx) => tx.artifacts.insertIfAbsent({ id: x.ids.next('artifact'), runId: null, projectId: x.projectId, kind, relPath,
        sha256: 'b'.repeat(64), sizeBytes, mediaType: 'text/x-diff', createdAt: x.clock.now() }));
      return art.id;
    };

    const good = await readInputDiff(x.ctx, x.projectId, id);
    const missing = await readInputDiff(x.ctx, x.projectId, 'art_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as ArtifactId);
    const otherProject = await readInputDiff(x.ctx, 'prj_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as ProjectId, id);
    const otherKind = await readInputDiff(x.ctx, x.projectId, insert('report', 10, `artifacts/${x.projectId}/r1`));
    const oversized = await readInputDiff(x.ctx, x.projectId, insert('input_diff', 2 * 1024 * 1024, `artifacts/${x.projectId}/big`));
    const unreadable = await readInputDiff(x.ctx, x.projectId, insert('input_diff', 10, `artifacts/${x.projectId}/never-written`));

    expect(good.ok && good.value.text).toBe(diffText());
    expect([missing, otherProject, otherKind, oversized].map(errOf)).toEqual(Array(4).fill(['NOT_FOUND', undefined]));
    expect([missing, otherKind].map((res) => (res.ok ? null : res.error.details?.['entity']))).toEqual(['input_diff', 'input_diff']);
    expect(unreadable.ok).toBe(false);
  });
});

describe('workflow draft patch: editable flags (21)', () => {
  it('refuses a patch section whose editable flag is false with locked_field (limits stay editable in P0)', async () => {
    const x = await harness();
    const wf = x.db.repos.workflows.listWorkflows()[0];
    const v1 = wf === undefined ? undefined : x.db.repos.workflows.getVersion(wf.id, 1);
    if (v1 === undefined) throw new Error('v1');
    const all = { prompts: true, profiles: true, limits: true, maxOutputTokens: true, retryPolicy: true, memoryScope: true, structure: false as const };

    const p0 = applyDraftPatch(v1, { limits: { maxAttempts: 12 } });
    const locked = applyDraftPatch(v1, { limits: { maxAttempts: 12 }, steps: { review: { maxOutputTokens: 4000, profile: 'Economy' } } as never },
      { ...all, limits: false, profiles: false });

    expect(p0.ok && p0.value.spec.limits.maxAttempts).toBe(12);
    expect(locked.ok ? null : locked.error.details?.['issues']).toEqual([
      { path: 'limits', message: 'This field cannot be edited.', code: 'locked_field' },
      { path: 'steps.review.profile', message: 'This field cannot be edited.', code: 'locked_field' },
    ]);
  });
});

describe('re-evaluation after a project allowance edit (11)', () => {
  it('re-evaluates EVERY paused(budget_project) run of the project, not only the first 100', async () => {
    const x = await harness({ monthlyAllowanceMicrousd: 1_000 });
    const first = await x.startRun();
    expect(await drive(x, first, ['paused'])).toBe('paused');
    const template = x.db.repos.runs.get(first);
    const clones: RunId[] = [];
    x.db.tx('immediate', (r) => {
      for (let i = 0; i < 120; i++) {
        const id = x.ids.next('run');
        r.runs.insert({ id, projectId: template.projectId, workflowVersionId: template.workflowVersionId, goal: template.goal, input: template.input,
          snapshot: template.snapshot, limits: template.limits, idempotencyKey: `clone-${String(i)}`, createdAt: x.clock.now() });
        r.runs.updateStatus(id, ['queued'], 'paused', { pauseReason: 'budget_project' });
        clones.push(id);
      }
    });
    const project = x.db.repos.projects.get(x.projectId);

    const res = await x.engine.handle('relay/v1/projects.update', { projectId: x.projectId, expectedUpdatedAt: project.updatedAt,
      patch: { monthlyAllowanceMicrousd: 90_000_000 } });

    expect(res.ok).toBe(true);
    expect([first, ...clones].map((id) => x.db.repos.runs.get(id).status).filter((s) => s !== 'queued')).toEqual([]);
  });
});

describe('isAbortReason (13)', () => {
  it('accepts only the registry reasons', () => {
    expect([{ kind: 'cancel' }, { kind: 'deadline' }, { kind: 'other' }, 'cancel', null, undefined, new Error('x')].map(isAbortReason))
      .toEqual([true, true, false, false, false, false, false]);
  });
});
