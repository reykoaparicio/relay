// 02 §B5 error-code conformance (table-driven): every runner-routed operation's reachable error branches — unknown
// ids (NOT_FOUND), stale revisions and reused idempotency keys (CONFLICT), bad references (VALIDATION_FAILED /
// PERMISSION_DENIED) — return only codes in `op.errors ∪ UNIVERSAL_ERROR_CODES`. The harness's `withErrorConformance`
// wrapper already throws on an undeclared code for EVERY `engine.handle` in the engine suites; this table makes sure
// each channel's error paths are actually driven, and that no channel is left out.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUNNER_CHANNELS, UNIVERSAL_ERROR_CODES, errors, getRunnerOperation } from '@relay/contracts';
import type { ErrorCode, IpcEnvelope, RunId, RunnerChannel, WorkflowId } from '@relay/contracts';
import { undeclaredErrorCode } from './error-conformance.js';
import { createHarness } from './testing/harness.js';
import type { ProfileRow } from '@relay/storage';
import type { Harness } from './testing/harness.js';

const BODY = '01J9ZZZZZZZZZZZZZZZZZZZZZ0';
const missing = {
  project: `prj_${BODY}`, workflow: `wfl_${BODY}`, profile: `prf_${BODY}`, run: `run_${BODY}`, step: `stp_${BODY}`,
  attempt: `att_${BODY}`, artifact: `art_${BODY}`, approval: `apr_${BODY}`, memory: `mem_${BODY}`,
} as const;
const HASH = 'a'.repeat(64);

interface World {
  readonly h: Harness;
  /** A profile the seeded workflow references (delete → CONFLICT profile_in_use). */
  readonly inUseProfile: ProfileRow;
  readonly runId: RunId;
  readonly stepId: string;
  readonly workflowId: WorkflowId;
}

/** One driven call: the channel, its input (built from the world), and the code it must return (null = success). */
interface Case {
  readonly name: string;
  readonly channel: RunnerChannel;
  readonly input: (w: World) => unknown;
  /** A call to make first (e.g. the original request of an idempotency-reuse case). */
  readonly before?: (w: World) => Promise<unknown>;
  readonly expected: ErrorCode | null;
}

const prj = (w: World) => w.h.projectId;
/** `profiles.upsert` input re-saving the in-use profile unchanged. */
const profileOf = (w: World) => {
  const p = w.inUseProfile;
  return { profile: { id: p.id, name: p.name, providerId: p.providerId, modelId: p.modelId, params: p.params } };
};
const call = (w: World, channel: RunnerChannel, input: unknown) => w.h.engine.handle(channel, input as never);

const CASES: readonly Case[] = [
  { name: 'diagnostics', channel: 'relay/v1/app.getDiagnostics', input: () => ({}), expected: null },
  { name: 'backup', channel: 'relay/v1/app.createBackup', input: () => ({ idempotencyKey: 'conf-backup-key-0001' }), expected: null },
  { name: 'settings', channel: 'relay/v1/app.getSettings', input: () => ({}), expected: null },
  { name: 'settings: unknown active project', channel: 'relay/v1/app.updateSettings', input: () => ({ activeProjectId: missing.project }), expected: 'VALIDATION_FAILED' },
  { name: 'projects', channel: 'relay/v1/projects.list', input: () => ({}), expected: null },
  { name: 'project: unknown', channel: 'relay/v1/projects.get', input: () => ({ projectId: missing.project }), expected: 'NOT_FOUND' },
  { name: 'project update: unknown', channel: 'relay/v1/projects.update', input: () => ({ projectId: missing.project, expectedUpdatedAt: 0, patch: { name: 'x' } }), expected: 'NOT_FOUND' },
  { name: 'project update: stale', channel: 'relay/v1/projects.update', input: (w) => ({ projectId: prj(w), expectedUpdatedAt: 1, patch: { name: 'x' } }), expected: 'CONFLICT' },
  { name: 'project archive: unknown', channel: 'relay/v1/projects.archive', input: () => ({ projectId: missing.project }), expected: 'NOT_FOUND' },
  { name: 'providers', channel: 'relay/v1/providers.list', input: () => ({}), expected: null },
  { name: 'provider test', channel: 'relay/v1/providers.test', input: () => ({ providerId: 'fake' }), expected: null },
  { name: 'catalog', channel: 'relay/v1/providers.catalog', input: () => ({}), expected: null },
  { name: 'profiles', channel: 'relay/v1/profiles.list', input: () => ({}), expected: null },
  { name: 'profile upsert: unknown id with a revision', channel: 'relay/v1/profiles.upsert', input: (w) => ({ ...profileOf(w), profile: { ...profileOf(w).profile, id: missing.profile, name: 'Ghost' }, expectedRevision: 1 }), expected: 'NOT_FOUND' },
  { name: 'profile upsert: stale revision', channel: 'relay/v1/profiles.upsert', input: (w) => ({ ...profileOf(w), expectedRevision: 99 }), expected: 'CONFLICT' },
  { name: 'profile upsert: unknown model', channel: 'relay/v1/profiles.upsert', input: () => ({ profile: { name: 'Nope', providerId: 'openai', modelId: 'gpt-none', params: { maxOutputTokens: 100 } } }), expected: 'MODEL_UNSUPPORTED' },
  { name: 'profile delete: unknown', channel: 'relay/v1/profiles.delete', input: () => ({ profileId: missing.profile }), expected: 'NOT_FOUND' },
  { name: 'profile delete: in use', channel: 'relay/v1/profiles.delete', input: (w) => ({ profileId: w.inUseProfile.id }), expected: 'CONFLICT' },
  { name: 'workflows', channel: 'relay/v1/workflows.list', input: () => ({}), expected: null },
  { name: 'workflow: unknown', channel: 'relay/v1/workflows.get', input: () => ({ workflowId: missing.workflow }), expected: 'NOT_FOUND' },
  { name: 'draft: unknown workflow', channel: 'relay/v1/workflows.saveDraft', input: () => ({ workflowId: missing.workflow, expectedDraftRevision: 0, patch: {} }), expected: 'NOT_FOUND' },
  { name: 'draft: no draft at that revision', channel: 'relay/v1/workflows.saveDraft', input: (w) => ({ workflowId: w.workflowId, expectedDraftRevision: 7, patch: {} }), expected: 'NOT_FOUND' },
  {
    name: 'draft: already exists', channel: 'relay/v1/workflows.saveDraft', expected: 'CONFLICT',
    input: (w) => ({ workflowId: w.workflowId, expectedDraftRevision: 0, patch: {} }),
    before: (w) => call(w, 'relay/v1/workflows.saveDraft', { workflowId: w.workflowId, expectedDraftRevision: 0, patch: {} }),
  },
  { name: 'validate: unknown', channel: 'relay/v1/workflows.validate', input: () => ({ workflowId: missing.workflow, version: 1 }), expected: 'NOT_FOUND' },
  { name: 'publish: unknown', channel: 'relay/v1/workflows.publish', input: () => ({ idempotencyKey: 'conf-publish-key-01', workflowId: missing.workflow }), expected: 'NOT_FOUND' },
  { name: 'preflight: unknown project', channel: 'relay/v1/runs.preflight', input: (w) => ({ projectId: missing.project, workflowId: w.workflowId, workflowVersion: 1, goal: 'Fix it.', input: { kind: 'files', relPaths: ['src/errors.ts'] } }), expected: 'NOT_FOUND' },
  { name: 'start: unknown project', channel: 'relay/v1/runs.start', input: (w) => ({ idempotencyKey: 'conf-start-key-0001', projectId: missing.project, workflowId: w.workflowId, workflowVersion: 1, goal: 'Fix it.', input: { kind: 'files', relPaths: ['src/errors.ts'] } }), expected: 'NOT_FOUND' },
  { name: 'start: unknown workflow version', channel: 'relay/v1/runs.start', input: (w) => ({ idempotencyKey: 'conf-start-key-0002', projectId: prj(w), workflowId: w.workflowId, workflowVersion: 99, goal: 'Fix it.', input: { kind: 'files', relPaths: ['src/errors.ts'] } }), expected: 'NOT_FOUND' },
  {
    name: 'start: idempotency key reused', channel: 'relay/v1/runs.start', expected: 'CONFLICT',
    input: (w) => ({ idempotencyKey: 'conf-start-key-0003', projectId: prj(w), workflowId: w.workflowId, workflowVersion: 1, goal: 'Another goal.', input: { kind: 'files', relPaths: ['src/errors.ts'] } }),
    before: (w) => call(w, 'relay/v1/runs.start', { idempotencyKey: 'conf-start-key-0003', projectId: prj(w), workflowId: w.workflowId, workflowVersion: 1, goal: 'First goal.', input: { kind: 'files', relPaths: ['src/errors.ts'] } }),
  },
  { name: 'runs', channel: 'relay/v1/runs.list', input: () => ({ projectId: missing.project }), expected: null },
  { name: 'run: unknown', channel: 'relay/v1/runs.get', input: () => ({ runId: missing.run }), expected: 'NOT_FOUND' },
  { name: 'step: unknown', channel: 'relay/v1/runs.getStep', input: (w) => ({ runId: w.runId, stepId: missing.step }), expected: 'NOT_FOUND' },
  { name: 'pause: unknown', channel: 'relay/v1/runs.pause', input: () => ({ runId: missing.run }), expected: 'NOT_FOUND' },
  { name: 'resume: unknown', channel: 'relay/v1/runs.resume', input: () => ({ idempotencyKey: 'conf-resume-key-001', runId: missing.run, decision: { kind: 'continue' } }), expected: 'NOT_FOUND' },
  { name: 'resume: not paused', channel: 'relay/v1/runs.resume', input: (w) => ({ idempotencyKey: 'conf-resume-key-002', runId: w.runId, decision: { kind: 'continue' } }), expected: 'CONFLICT' },
  { name: 'cancel: unknown', channel: 'relay/v1/runs.cancel', input: () => ({ runId: missing.run }), expected: 'NOT_FOUND' },
  { name: 'allowance: unknown', channel: 'relay/v1/runs.increaseAllowance', input: () => ({ idempotencyKey: 'conf-allow-key-0001', runId: missing.run, newAllowanceMicrousd: 1 }), expected: 'NOT_FOUND' },
  {
    name: 'allowance: idempotency key reused', channel: 'relay/v1/runs.increaseAllowance', expected: 'CONFLICT',
    input: (w) => ({ idempotencyKey: 'conf-allow-key-0002', runId: w.runId, newAllowanceMicrousd: 20_000_000 }),
    before: (w) => call(w, 'relay/v1/runs.increaseAllowance', { idempotencyKey: 'conf-allow-key-0002', runId: w.runId, newAllowanceMicrousd: 10_000_000 }),
  },
  { name: 'decide unknown: unknown run', channel: 'relay/v1/runs.decideUnknown', input: () => ({ idempotencyKey: 'conf-unknown-key-01', runId: missing.run, attemptId: missing.attempt, decision: 'accept_estimated_charge' }), expected: 'NOT_FOUND' },
  { name: 'decide unknown: no such unknown attempt', channel: 'relay/v1/runs.decideUnknown', input: (w) => ({ idempotencyKey: 'conf-unknown-key-02', runId: w.runId, attemptId: missing.attempt, decision: 'accept_estimated_charge' }), expected: 'CONFLICT' },
  { name: 'retry step: unknown', channel: 'relay/v1/runs.retryStep', input: () => ({ idempotencyKey: 'conf-retry-key-0001', runId: missing.run, stepId: missing.step }), expected: 'NOT_FOUND' },
  { name: 'retry step: not failed', channel: 'relay/v1/runs.retryStep', input: (w) => ({ idempotencyKey: 'conf-retry-key-0002', runId: w.runId, stepId: w.stepId }), expected: 'CONFLICT' },
  { name: 'events: unknown run', channel: 'relay/v1/runs.events', input: () => ({ runId: missing.run, afterSeq: 0 }), expected: null },
  { name: 'approval: unknown', channel: 'relay/v1/approvals.decide', input: () => ({ idempotencyKey: 'conf-approve-key-01', approvalId: missing.approval, planHash: HASH, contextHash: HASH, decision: 'approved' }), expected: 'NOT_FOUND' },
  { name: 'memory', channel: 'relay/v1/memory.list', input: () => ({ projectId: missing.project }), expected: null },
  { name: 'memory: unknown', channel: 'relay/v1/memory.get', input: () => ({ recordId: missing.memory }), expected: 'NOT_FOUND' },
  { name: 'memory create: unknown project', channel: 'relay/v1/memory.create', input: () => ({ idempotencyKey: 'conf-memory-key-001', projectId: missing.project, type: 'user_rule', title: 'Rule', content: 'Be terse.', scope: { roles: 'all' } }), expected: 'NOT_FOUND' },
  { name: 'memory update: unknown', channel: 'relay/v1/memory.update', input: () => ({ recordId: missing.memory, expectedRevision: 1, title: 'x' }), expected: 'NOT_FOUND' },
  { name: 'memory approve: unknown', channel: 'relay/v1/memory.approve', input: () => ({ suggestionId: missing.memory, expectedRevision: 1 }), expected: 'NOT_FOUND' },
  { name: 'memory reject: unknown', channel: 'relay/v1/memory.reject', input: () => ({ suggestionId: missing.memory }), expected: 'NOT_FOUND' },
  { name: 'memory archive: unknown', channel: 'relay/v1/memory.archive', input: () => ({ recordId: missing.memory }), expected: 'NOT_FOUND' },
  { name: 'memory delete: unknown', channel: 'relay/v1/memory.delete', input: () => ({ recordId: missing.memory, confirm: true }), expected: 'NOT_FOUND' },
  { name: 'memory conflict: unknown', channel: 'relay/v1/memory.resolveConflict', input: () => ({ idempotencyKey: 'conf-resolve-key-01', recordIds: [missing.memory, `mem_${BODY.slice(0, -1)}1`], resolution: { keep: missing.memory } }), expected: 'NOT_FOUND' },
  { name: 'purge: unknown project', channel: 'relay/v1/memory.purgeProjectHistory', input: () => ({ projectId: missing.project, confirmPhrase: 'purge' }), expected: 'NOT_FOUND' },
  { name: 'artifact: unknown', channel: 'relay/v1/artifacts.get', input: () => ({ artifactId: missing.artifact }), expected: 'NOT_FOUND' },
  { name: 'run summary: unknown', channel: 'relay/v1/ledger.runSummary', input: () => ({ runId: missing.run }), expected: 'NOT_FOUND' },
  { name: 'project summary: unknown', channel: 'relay/v1/ledger.projectSummary', input: () => ({ projectId: missing.project }), expected: 'NOT_FOUND' },
  { name: 'ledger entries: unknown run', channel: 'relay/v1/ledger.entries', input: () => ({ runId: missing.run }), expected: null },
  { name: 'credential ref', channel: 'relay/v1/providers.recordCredentialRef', input: () => ({ providerId: 'fake', storageMode: 'session', vaultFile: null, redactedLabel: 'sk-…test' }), expected: null },
  { name: 'credential ref delete', channel: 'relay/v1/providers.deleteCredentialRef', input: () => ({ providerId: 'gemini' }), expected: null },
  { name: 'credential refs', channel: 'relay/v1/providers.listCredentialRefs', input: () => ({}), expected: null },
  { name: 'create project: root registered', channel: 'relay/v1/projects.createFromRoot', input: (w) => ({ idempotencyKey: 'conf-project-key-01', rootRealpath: w.h.projectRoot, rootDisplayPath: '~/x', name: 'Twice', exclusions: [], allowedProviderIds: ['fake'], monthlyAllowanceMicrousd: null, isDemo: false }), expected: 'CONFLICT' },
  {
    name: 'create project: idempotency key reused', channel: 'relay/v1/projects.createFromRoot', expected: 'CONFLICT',
    input: (w) => ({ idempotencyKey: 'harness-project-0001', rootRealpath: w.h.projectRoot, rootDisplayPath: '~/other', name: 'Other', exclusions: [], allowedProviderIds: ['fake'], monthlyAllowanceMicrousd: null, isDemo: false }),
  },
  { name: 'unarchive: unknown project', channel: 'relay/v1/projects.unarchive', input: () => ({ projectId: missing.project }), expected: 'NOT_FOUND' },
  { name: 'unarchive: not archived', channel: 'relay/v1/projects.unarchive', input: (w) => ({ projectId: prj(w) }), expected: 'CONFLICT' },
  { name: 'relocate root: unknown project', channel: 'relay/v1/projects.relocateRoot', input: (w) => ({ projectId: missing.project, rootRealpath: w.h.projectRoot, rootDisplayPath: '~/x' }), expected: 'NOT_FOUND' },
  { name: 'relocate root: folder gone', channel: 'relay/v1/projects.relocateRoot', input: (w) => ({ projectId: prj(w), rootRealpath: `${w.h.projectRoot}-gone`, rootDisplayPath: '~/x' }), expected: 'PROJECT_ROOT_MISSING' },
  { name: 'preview: unknown project', channel: 'relay/v1/projects.previewRoot', input: () => ({ projectId: missing.project }), expected: 'NOT_FOUND' },
  { name: 'import diff: unknown project', channel: 'relay/v1/artifacts.importDiffText', input: () => ({ projectId: missing.project, text: 'not a diff', fileName: 'x.diff' }), expected: 'NOT_FOUND' },
  { name: 'import diff: not a diff', channel: 'relay/v1/artifacts.importDiffText', input: (w) => ({ projectId: prj(w), text: 'not a diff', fileName: 'x.diff' }), expected: 'VALIDATION_FAILED' },
  { name: 'export artifacts: unknown run', channel: 'relay/v1/artifacts.exportTo', input: (w) => ({ runId: missing.run, what: 'report', destinationRealpath: w.h.userDataDir }), expected: 'NOT_FOUND' },
  { name: 'export project: unknown', channel: 'relay/v1/projects.exportTo', input: (w) => ({ projectId: missing.project, destinationRealpath: w.h.userDataDir }), expected: 'NOT_FOUND' },
  { name: 'export ledger: unknown run', channel: 'relay/v1/ledger.exportTo', input: (w) => ({ runId: missing.run, destinationRealpath: w.h.userDataDir }), expected: 'NOT_FOUND' },
];

describe('error-code conformance (02 §B5): op.errors ∪ UNIVERSAL_ERROR_CODES', () => {
  let w: World;
  beforeAll(async () => {
    const h = await createHarness();
    const runId = await h.startRun({ relPaths: ['src/errors.ts'] });
    const stepId = h.db.repos.steps.listForRun(runId)[0]?.id;
    const workflowId = h.db.repos.workflows.listWorkflows()[0]?.id;
    if (stepId === undefined || workflowId === undefined) throw new Error('conformance world: no step or workflow');
    const spec = h.db.repos.workflows.latestValidated(workflowId)?.spec;
    const used = new Set(spec?.steps.flatMap((s) => (s.kind === 'model' ? [s.profile.toLowerCase()] : [])));
    const inUseProfile = h.db.repos.profiles.list().find((p) => used.has(p.name.toLowerCase()));
    if (inUseProfile === undefined) throw new Error('conformance world: no referenced profile');
    w = { h, inUseProfile, runId, stepId, workflowId };
  });
  afterAll(async () => {
    await w.h.cleanup();
  });

  it('drives every runner-routed channel at least once', () => {
    const driven = new Set(CASES.map((c) => c.channel));

    expect(RUNNER_CHANNELS.filter((c) => !driven.has(c))).toEqual([]);
  });

  it.each(CASES)('$channel — $name', async (c) => {
    await c.before?.(w);

    // The harness wrapper already throws on an undeclared code; the explicit check keeps this table self-contained.
    const res = await call(w, c.channel, c.input(w));

    expect(undeclaredErrorCode(c.channel, res)).toBeNull();
    expect(res.ok ? null : res.error.code).toBe(c.expected);
  });

  it('the checker flags an undeclared code, accepts declared and universal ones, and ignores successes', () => {
    const fail = (code: ErrorCode): IpcEnvelope<unknown> => ({ ok: false, error: code === 'INTERNAL' ? errors.internal(undefined) : { ...errors.conflict(), code } });
    const projectsGet = getRunnerOperation('relay/v1/projects.get');

    expect(projectsGet?.errors).toEqual(['NOT_FOUND']);
    expect(undeclaredErrorCode('relay/v1/projects.get', fail('BUDGET_BLOCKED'))).toBe('BUDGET_BLOCKED');
    expect(undeclaredErrorCode('relay/v1/projects.get', fail('NOT_FOUND'))).toBeNull();
    for (const code of UNIVERSAL_ERROR_CODES) expect(undeclaredErrorCode('relay/v1/projects.get', fail(code))).toBeNull();
    expect(undeclaredErrorCode('relay/v1/projects.get', { ok: true, data: null })).toBeNull();
    expect(undeclaredErrorCode('relay/v1/nope', fail('BUDGET_BLOCKED'))).toBeNull();
  });
});
