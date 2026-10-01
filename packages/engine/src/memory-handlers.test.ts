import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { err, errors, getRunnerOperation, memoryRecordDetailSchema, memoryRecordViewSchema } from '@relay/contracts';
import { createMaintenance } from '@relay/storage';
import type { EngineCtx } from './ports.js';
import type { MemoryId } from '@relay/contracts';
import { tick } from './runner.js';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function harness(): Promise<Harness> {
  h = await createHarness();
  return h;
}

const memoryOutput = getRunnerOperation('relay/v1/memory.purgeProjectHistory')?.output;

let keySeq = 0;
async function create(x: Harness, o: Record<string, unknown> = {}) {
  keySeq += 1;
  return x.engine.handle('relay/v1/memory.create', {
    idempotencyKey: `mem-handler-key-${String(keySeq).padStart(4, '0')}`, projectId: x.projectId, type: 'user_rule', title: 'Keep fields',
    content: 'Keep existing public response fields.', scope: { roles: 'all' }, ...o,
  } as never);
}

function suggest(x: Harness, title = 'Suggested rule'): MemoryId {
  return x.db.repos.memory.insertRecord(
    { id: x.ids.next('memory'), projectId: x.projectId, type: 'project_decision', status: 'suggested', scope: { roles: 'all' }, createdAt: x.clock.now(),
      proposal: { rationale: 'Seen twice.', suggestedScope: { roles: 'all' }, conflictsWith: ['not-an-id'] } },
    { id: x.ids.next('memoryRevision'), title, content: 'Validate with helpers.', sourceRefs: [], author: 'user', createdAt: x.clock.now() },
  ).record.id;
}

describe('memory.* handlers (07 G5 / 02 memory ops)', () => {
  it('create → approved immediately (author user), get returns revisions/events, list filters by status/type/query', async () => {
    const x = await harness();

    const created = await create(x, { pinned: true, reviewAt: 5 });
    const other = await create(x, { type: 'project_decision', title: 'Other', content: 'Prefer small diffs.' });
    const id = created.ok ? created.data.id : ('' as MemoryId);
    const got = await x.engine.handle('relay/v1/memory.get', { recordId: id });
    const byType = await x.engine.handle('relay/v1/memory.list', { projectId: x.projectId, type: ['project_decision'] });
    const byQuery = await x.engine.handle('relay/v1/memory.list', { projectId: x.projectId, query: 'public response' });
    const suggested = await x.engine.handle('relay/v1/memory.list', { projectId: x.projectId, status: ['suggested'] });

    expect(created.ok && memoryRecordDetailSchema.parse(created.data)).toEqual(expect.objectContaining({ status: 'approved', pinned: true, reviewAt: 5, source: { kind: 'user' }, usedByRuns: 0 }));
    expect(got.ok && [got.data.revisions.map((r) => r.author), got.data.events.map((e) => e.event)]).toEqual([['user'], ['approved']]);
    expect(other.ok).toBe(true);
    expect(byType.ok && byType.data.map((v) => v.title)).toEqual(['Other']);
    expect(byQuery.ok && byQuery.data.map((v) => memoryRecordViewSchema.parse(v).id)).toEqual([id]);
    expect(suggested.ok && suggested.data).toEqual([]);
    expect(x.events.filter((e) => e.type === 'memory.changed')).toHaveLength(2);
  });

  it('create is idempotent per key, rejects key reuse with a different request, secrets, and an unknown project', async () => {
    const x = await harness();
    const input = { idempotencyKey: 'mem-idem-key-000001', projectId: x.projectId, type: 'user_rule' as const, title: 'T', content: 'C.', scope: { roles: 'all' as const } };

    const first = await x.engine.handle('relay/v1/memory.create', input);
    const replay = await x.engine.handle('relay/v1/memory.create', input);
    const reused = await x.engine.handle('relay/v1/memory.create', { ...input, content: 'Different.' });
    const secret = await create(x, { content: 'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA' });
    const unknown = await create(x, { projectId: 'prj_01J9ZZZZZZZZZZZZZZZZZZZZZ0' });

    expect(first.ok && replay.ok && first.data.id === replay.data.id).toBe(true);
    expect(x.db.repos.memory.list({ projectId: x.projectId })).toHaveLength(1);
    expect(reused.ok ? null : reused.error.code).toBe('CONFLICT');
    expect(secret.ok ? null : [secret.error.code, secret.error.userMessage]).toEqual(['VALIDATION_FAILED', "Provider credentials and secrets don't belong in memory"]);
    expect(unknown.ok ? null : unknown.error.code).toBe('NOT_FOUND');
  });

  it('source_reference reads the file path-confined and stores {relPath, sha256}; a live edit marks it stale; outside the root is refused', async () => {
    const x = await harness();

    const ref = await create(x, { type: 'source_reference', title: 'Errors', content: 'Error codes.', sourceFile: { relPath: 'src/errors.ts' } });
    const outside = await create(x, { type: 'source_reference', title: 'Escape', content: 'x', sourceFile: { relPath: '../outside.ts' } });
    const missing = await create(x, { type: 'source_reference', title: 'Missing', content: 'x', sourceFile: { relPath: 'src/nope.ts' } });
    await writeFile(join(x.projectRoot, 'src', 'errors.ts'), 'export const CHANGED = 1;\n');
    const listed = await x.engine.handle('relay/v1/memory.list', { projectId: x.projectId });

    expect(ref.ok && [ref.data.source, ref.data.stale, ref.data.revisions[0]?.sourceRefs[0]]).toEqual([
      { kind: 'file', relPath: 'src/errors.ts' }, false, { kind: 'file', relPath: 'src/errors.ts', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown },
    ]);
    expect(outside.ok).toBe(false);
    expect(missing.ok).toBe(false);
    expect(listed.ok && listed.data.map((v) => v.stale)).toEqual([true]);
  });

  it('update / archive / unarchive / delete (retainedInRunSnapshots) through the handlers', async () => {
    const x = await harness();
    const created = await create(x);
    const id = created.ok ? created.data.id : ('' as MemoryId);
    const runId = await x.startRun();
    await tick(x.ctx);
    await tick(x.ctx);

    const updated = await x.engine.handle('relay/v1/memory.update', { recordId: id, expectedRevision: 1, content: 'Edited.', pinned: true });
    const stale = await x.engine.handle('relay/v1/memory.update', { recordId: id, expectedRevision: 1, content: 'Again.' });
    const archived = await x.engine.handle('relay/v1/memory.archive', { recordId: id });
    const unarchived = await x.engine.handle('relay/v1/memory.update', { recordId: id, expectedRevision: 2, unarchive: true });
    const deleted = await x.engine.handle('relay/v1/memory.delete', { recordId: id, confirm: true });
    const deleteAgain = await x.engine.handle('relay/v1/memory.delete', { recordId: id, confirm: true });
    const got = await x.engine.handle('relay/v1/memory.get', { recordId: id });

    expect(updated.ok && [updated.data.currentRevision, updated.data.content, updated.data.pinned, updated.data.usedByRuns]).toEqual([2, 'Edited.', true, 1]);
    expect(stale.ok ? null : stale.error.code).toBe('CONFLICT');
    expect(archived.ok && archived.data.status).toBe('archived');
    expect(unarchived.ok && unarchived.data.status).toBe('approved');
    expect(deleted.ok && deleted.data).toEqual({ deleted: true, retainedInRunSnapshots: 1 });
    expect(deleteAgain.ok ? null : deleteAgain.error.code).toBe('CONFLICT');
    expect(got.ok && got.data.status).toBe('deleted');
    expect(x.db.repos.memory.runSnapshot(runId)).toEqual([expect.objectContaining({ recordId: id, revision: 1, content: 'Keep existing public response fields.' })]);
  });

  it('approve / reject a suggestion; the view exposes the proposal and filters invalid conflict ids', async () => {
    const x = await harness();
    const s1 = suggest(x, 'First suggestion');
    const s2 = suggest(x, 'Second suggestion');

    const view = await x.engine.handle('relay/v1/memory.get', { recordId: s1 });
    const approved = await x.engine.handle('relay/v1/memory.approve', { suggestionId: s1, expectedRevision: 1, finalTitle: 'First rule' });
    const rejected = await x.engine.handle('relay/v1/memory.reject', { suggestionId: s2, reason: 'Not durable.' });
    const rejectAgain = await x.engine.handle('relay/v1/memory.reject', { suggestionId: s2 });

    expect(view.ok && [view.data.proposal, view.data.conflictsWith]).toEqual([{ rationale: 'Seen twice.', suggestedScope: { roles: 'all' }, conflictsWith: [] }, []]);
    expect(approved.ok && [approved.data.status, approved.data.title, approved.data.currentRevision]).toEqual(['approved', 'First rule', 2]);
    expect(rejected.ok && rejected.data).toEqual({ status: 'rejected' });
    expect(rejectAgain.ok ? null : rejectAgain.error.code).toBe('CONFLICT');
  });

  it('resolveConflict is idempotent per key and returns the affected views; an unknown record is NOT_FOUND', async () => {
    const x = await harness();
    const a = await create(x, { title: 'A' });
    const b = await create(x, { title: 'B' });
    const ids = [a.ok ? a.data.id : ('' as MemoryId), b.ok ? b.data.id : ('' as MemoryId)] as [MemoryId, MemoryId];
    const input = { idempotencyKey: 'mem-resolve-key-0001', recordIds: ids, resolution: { keep: ids[0] } };

    const first = await x.engine.handle('relay/v1/memory.resolveConflict', input);
    const replay = await x.engine.handle('relay/v1/memory.resolveConflict', input);
    const reused = await x.engine.handle('relay/v1/memory.resolveConflict', { ...input, resolution: { keep: ids[1] } });
    const missing = await x.engine.handle('relay/v1/memory.resolveConflict', { idempotencyKey: 'mem-resolve-key-0002', recordIds: [ids[0], x.ids.next('memory')], resolution: { keep: ids[0] } });

    expect(first.ok && first.data.map((v) => [v.id, v.status, v.supersededById])).toEqual([[ids[0], 'approved', null], [ids[1], 'archived', ids[0]]]);
    expect(replay.ok && replay.data.map((v) => v.id)).toEqual(ids);
    expect(reused.ok ? null : reused.error.code).toBe('CONFLICT');
    expect(missing.ok ? null : missing.error.code).toBe('NOT_FOUND');
  });

  it('purgeProjectHistory removes the run snapshot copies (records and revisions stay); unknown project → NOT_FOUND; get unknown → NOT_FOUND', async () => {
    const x = await harness();
    const created = await create(x);
    const runId = await x.startRun();
    await tick(x.ctx);
    await tick(x.ctx);

    const purged = await x.engine.handle('relay/v1/memory.purgeProjectHistory', { projectId: x.projectId, confirmPhrase: 'purge' });
    const unknown = await x.engine.handle('relay/v1/memory.purgeProjectHistory', { projectId: 'prj_01J9ZZZZZZZZZZZZZZZZZZZZZ0', confirmPhrase: 'purge' });
    const missing = await x.engine.handle('relay/v1/memory.get', { recordId: x.ids.next('memory') });

    expect(purged.ok && purged.data).toEqual({ purgedSnapshots: 1, purgedArtifacts: 0, failed: 0 }); // intake only: no responses yet
    expect(x.db.repos.memory.runSnapshot(runId)).toEqual([]);
    expect(created.ok && x.db.repos.memory.get(created.data.id)?.record.status).toBe('approved');
    expect(unknown.ok ? null : unknown.error.code).toBe('NOT_FOUND');
    expect(missing.ok ? null : missing.error.code).toBe('NOT_FOUND');
  });

  it('purgeProjectHistory returns purgedArtifacts and the failed count (a failed file purge is reported, then retried)', async () => {
    const x = await harness();
    await create(x); // one approved rule → one run snapshot copy
    await x.engine.start();
    const runId = await x.startRun();
    await x.waitForStatus(runId, ['awaiting_approval']);
    const history = x.db.repos.artifacts.listForRun(runId, ['raw_response', 'context_manifest']).length;
    const real = x.ctx.maintenance;
    (x.ctx as { maintenance: EngineCtx['maintenance'] }).maintenance = createMaintenance({ db: x.db, clock: x.clock,
      artifacts: { purge: () => Promise.resolve(err(errors.artifactWriteFailed())) } });

    const failing = await x.engine.handle('relay/v1/memory.purgeProjectHistory', { projectId: x.projectId, confirmPhrase: 'purge' });
    (x.ctx as { maintenance: EngineCtx['maintenance'] }).maintenance = real;
    const retried = await x.engine.handle('relay/v1/memory.purgeProjectHistory', { projectId: x.projectId, confirmPhrase: 'purge' });

    expect(history).toBeGreaterThan(0);
    expect(failing.ok && failing.data).toEqual({ purgedSnapshots: 1, purgedArtifacts: 0, failed: history });
    expect(retried.ok && retried.data).toEqual({ purgedSnapshots: 0, purgedArtifacts: history, failed: 0 });
    expect(memoryOutput?.parse(failing.ok ? failing.data : null)).toEqual({ purgedSnapshots: 1, purgedArtifacts: 0, failed: history });
  });

  it('a completed-run suggestion shows its run source and the run_summary is listed as approved', async () => {
    const x = await harness();
    await x.engine.start();
    const runId = await x.startRun();
    await x.waitForStatus(runId, ['awaiting_approval']);
    const detail = await x.engine.handle('relay/v1/runs.get', { runId });
    const a = detail.ok ? detail.data.pendingApproval : null;
    await x.engine.handle('relay/v1/approvals.decide', { idempotencyKey: 'approve-mem-handler-1', approvalId: a?.id ?? '', planHash: a?.planHash ?? '',
      contextHash: a?.contextHash ?? '', decision: 'approved' });
    await x.waitForStatus(runId, ['completed']);

    const listed = await x.engine.handle('relay/v1/memory.list', { projectId: x.projectId });

    if (!listed.ok) throw new Error(listed.error.code);
    const suggestion = listed.data.find((v) => v.status === 'suggested');
    expect(suggestion?.source).toEqual(expect.objectContaining({ kind: 'run', runId }));
    expect(listed.data.filter((v) => v.type === 'run_summary').map((v) => v.status)).toEqual(['approved']);
  });
});
