// 11 §K5 "Memory suggestion generated" + §K6 memory-isolation (FR-06, @m3). The memory lifecycle and the memory.* runner
// ops land in Wave 3 (07 G5): until then the engine answers every memory.* op with INTERNAL `not_implemented`. The
// end-to-end cases below are written in full and SKIPPED while that is so (a probe decides at load time, so they
// switch on by themselves when G5 lands). The storage-level guarantees they rely on run now.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createIdGen, epochMs, systemClock } from '@relay/contracts';
import type { ContextManifest, MemoryId, ProjectId, RunId } from '@relay/contracts';
import { createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { cleanupTempDirs, copyFixture } from '../helpers/temp-dirs.js';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const x of harnesses.splice(0)) await x.dispose();
  await cleanupTempDirs();
});

async function open(o: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const x = await createHarness(o);
  harnesses.push(x);
  return x;
}

/** Wave-3 probe: true while memory.* is still the not_implemented stub. */
const MEMORY_PENDING = await (async () => {
  const probe = await createHarness({ start: false });
  try {
    const res = await probe.call('relay/v1/memory.list', { projectId: probe.projectId });
    return !res.ok && res.error.details?.['reason'] === 'not_implemented';
  } finally {
    await probe.dispose();
    await cleanupTempDirs();
  }
})();
const WAVE3 = 'memory.* is not_implemented until Wave 3 (07 G5)';

async function manifestOf(x: Harness, runId: RunId, stepKey = 'review'): Promise<ContextManifest> {
  const [a] = x.attempts(runId, stepKey);
  const row = x.db.repos.artifacts.listForRun(runId, ['context_manifest']).find((m) => m.attemptId === a?.id);
  if (row === undefined) throw new Error(`no context manifest for ${stepKey}`);
  return JSON.parse(await readFile(join(x.userDataDir, row.relPath), 'utf8')) as ContextManifest;
}

async function completeRun(x: Harness, projectId?: ProjectId): Promise<RunId> {
  const runId = await x.startRun(projectId === undefined ? {} : { projectId });
  await x.waitFor(runId, 'awaiting_approval');
  await x.approve(runId);
  await x.waitFor(runId, 'completed');
  return runId;
}

async function createRule(x: Harness, projectId: ProjectId, key: string, content: string): Promise<MemoryId> {
  const res = await x.call('relay/v1/memory.create', { idempotencyKey: key, projectId, type: 'user_rule', title: 'Rule', content, scope: { roles: 'all' } });
  if (!res.ok) throw new Error(`memory.create: ${res.error.code}`);
  return res.data.id;
}

describe('memory isolation @m3', () => {
  it('Wave-3 status: memory.* answers INTERNAL not_implemented (never a silent success) until G5 lands @m3', async () => {
    const x = await open({ start: false });
    const res = await x.call('relay/v1/memory.create', { idempotencyKey: 'memory-probe-0001', projectId: x.projectId, type: 'user_rule', title: 'Rule', content: 'Never cast body fields.', scope: { roles: 'all' } });
    if (MEMORY_PENDING) expect(res.ok ? null : [res.error.code, res.error.details?.['reason']]).toEqual(['INTERNAL', 'not_implemented']);
    else expect(res.ok).toBe(true);
  });

  it('storage level: approved memory survives a DB reopen, is retrievable only in its own project, and a new revision keeps the old one @m3', async () => {
    const a = await open({ start: false });
    const other = await a.call('relay/v1/projects.createFromRoot', { idempotencyKey: 'memory-project-b-01', rootRealpath: await copyFixture('sample-api'), rootDisplayPath: '~/b',
      name: 'Project B', exclusions: [], allowedProviderIds: ['anthropic'], monthlyAllowanceMicrousd: null, isDemo: false });
    if (!other.ok) throw new Error(other.error.code);
    const ids = createIdGen(systemClock, (n) => new Uint8Array(randomBytes(n)));
    const now = epochMs(Date.now());
    const id = ids.next('memory');
    a.db.tx('immediate', (r) => r.memory.insertRecord(
      { id, projectId: a.projectId, type: 'user_rule', status: 'approved', scope: { roles: 'all' }, createdAt: now },
      { id: ids.next('memoryRevision'), title: 'Rule A', content: 'Project A rule: validate with src/lib/validate.ts.', sourceRefs: [], author: 'user', createdAt: now },
    ));
    const revised = a.db.tx('immediate', (r) => r.memory.addRevision(id, { id: ids.next('memoryRevision'), title: 'Rule A', content: 'Project A rule, revised.', sourceRefs: [], author: 'user', createdAt: now }, 1));
    expect(revised.ok).toBe(true);
    const userDataDir = a.userDataDir;
    const root = a.projectRoot;
    await a.dispose();

    const b = await open({ userDataDir, projectRoot: root, start: false });
    const got = b.db.repos.memory.getWithRevisions(id);
    expect(got?.item.record.status).toBe('approved');
    expect(got?.revisions.map((r) => [r.revision, r.content])).toEqual([[1, 'Project A rule: validate with src/lib/validate.ts.'], [2, 'Project A rule, revised.']]);
    expect(b.db.repos.memory.retrievable(b.projectId, 'reviewer', now).map((m) => m.record.id)).toEqual([id]);
    expect(b.db.repos.memory.retrievable(other.data.id, 'reviewer', now)).toEqual([]);
    expect(b.db.repos.memory.list({ projectId: other.data.id })).toEqual([]);
  });

  it.skipIf(MEMORY_PENDING)(`#suggestion: run 1 suggests → run 2 manifest has no suggestion; approve → run 3 manifest includes it with its revision @m3 (${WAVE3})`, async () => {
    const x = await open();
    const run1 = await completeRun(x);
    const suggestions = await x.call('relay/v1/memory.list', { projectId: x.projectId, status: ['suggested'] });
    if (!suggestions.ok) throw new Error(suggestions.error.code);
    expect(suggestions.data.length).toBeGreaterThanOrEqual(1);
    const s = suggestions.data[0]!;
    expect(s.source).toEqual(expect.objectContaining({ runId: run1 }));

    const run2 = await completeRun(x);
    expect((await manifestOf(x, run2)).memory.map((m) => m.recordId)).not.toContain(s.id);

    const approved = await x.call('relay/v1/memory.approve', { suggestionId: s.id, expectedRevision: s.currentRevision });
    expect(approved.ok).toBe(true);
    const run3 = await completeRun(x);
    expect((await manifestOf(x, run3)).memory).toEqual(expect.arrayContaining([expect.objectContaining({ recordId: s.id, revision: s.currentRevision, included: true })]));
  });

  it.skipIf(MEMORY_PENDING)(`a project A rule never appears in a project B manifest @m3 (${WAVE3})`, async () => {
    const x = await open();
    const ruleA = await createRule(x, x.projectId, 'memory-rule-a-0001', 'Project A only: never cast body fields.');
    const b = await x.call('relay/v1/projects.createFromRoot', { idempotencyKey: 'memory-project-b-02', rootRealpath: await copyFixture('sample-api'), rootDisplayPath: '~/b',
      name: 'Project B', exclusions: [], allowedProviderIds: ['anthropic', 'openai', 'gemini', 'fake'], monthlyAllowanceMicrousd: null, isDemo: false });
    if (!b.ok) throw new Error(b.error.code);

    const runA = await completeRun(x);
    const runB = await completeRun(x, b.data.id);

    expect((await manifestOf(x, runA)).memory.map((m) => m.recordId)).toContain(ruleA);
    expect((await manifestOf(x, runB)).memory.map((m) => m.recordId)).not.toContain(ruleA);
  });

  it.skipIf(MEMORY_PENDING)(`approved memory survives a close/open; an edit creates a new revision while the old run snapshot keeps the old text @m3 (${WAVE3})`, async () => {
    const x = await open();
    const rule = await createRule(x, x.projectId, 'memory-rule-a-0002', 'Original rule text.');
    const run1 = await completeRun(x);
    const userDataDir = x.userDataDir;
    const root = x.projectRoot;
    await x.dispose();

    const y = await open({ userDataDir, projectRoot: root });
    const got = await y.call('relay/v1/memory.get', { recordId: rule });
    expect(got.ok && [got.data.status, got.data.content]).toEqual(['approved', 'Original rule text.']);
    const edited = await y.call('relay/v1/memory.update', { recordId: rule, expectedRevision: 1, content: 'Edited rule text.' });
    expect(edited.ok && edited.data.currentRevision).toBe(2);
    expect(y.db.repos.memory.runSnapshot(run1).find((s) => s.recordId === rule)).toEqual(expect.objectContaining({ revision: 1, content: 'Original rule text.' }));
  });
});
