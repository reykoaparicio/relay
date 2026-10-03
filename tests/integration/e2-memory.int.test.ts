// E2 memory / project fixes over the real runtime: purge never touches an active run (#14), intake drops a record
// that stopped being approvable instead of dead-ending in setup_blocked (#15), "Confirm still accurate" re-hashes the
// source and drives review-due from the last review (#16), the proposal's source refs / event details / per-revision
// usage reach the renderer (#17), and archived projects can be restored (#18).
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryId, MemoryRecordDetail } from '@relay/contracts';
import { DEFAULT_REL_PATHS, createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

let n = 0;
const key = (p: string): string => `${p}-${String(process.pid)}-${String((n += 1)).padStart(6, '0')}`;

async function rule(x: Harness, title: string, extra: Record<string, unknown> = {}): Promise<MemoryRecordDetail> {
  const r = await x.call('relay/v1/memory.create', { idempotencyKey: key('e2-mem'), projectId: x.projectId, type: 'project_decision', title,
    content: `${title}: keep it.`, scope: { roles: 'all' }, ...extra } as never);
  if (!r.ok) throw new Error(`memory.create ${r.error.code}`);
  return r.data;
}

async function detail(x: Harness, recordId: MemoryId): Promise<MemoryRecordDetail> {
  const r = await x.call('relay/v1/memory.get', { recordId });
  if (!r.ok) throw new Error(`memory.get ${r.error.code}`);
  return r.data;
}

describe('E2 memory', () => {
  it('#14: purge during an active run keeps its snapshot and evidence; after the run ends, a purge removes them', async () => {
    const x = await createHarness();
    h = x;
    await rule(x, 'Keep fields');
    const runId = await x.startRun();
    await x.waitFor(runId, 'awaiting_approval');
    const before = x.db.repos.memory.runSnapshot(runId).length;
    const evidence = x.db.repos.artifacts.listForRun(runId, ['raw_response', 'context_manifest']).filter((a) => a.purgedAt === null).length;

    const mid = await x.call('relay/v1/memory.purgeProjectHistory', { projectId: x.projectId, confirmPhrase: 'purge' });

    expect(before).toBeGreaterThan(0);
    expect(mid.ok && mid.data).toEqual({ purgedSnapshots: 0, purgedArtifacts: 0, failed: 0 });
    expect(x.db.repos.memory.runSnapshot(runId)).toHaveLength(before);
    expect(x.db.repos.artifacts.listForRun(runId, ['raw_response', 'context_manifest']).filter((a) => a.purgedAt === null)).toHaveLength(evidence);
    await x.approve(runId);
    await x.waitFor(runId, ['completed', 'incomplete']);

    const after = await x.call('relay/v1/memory.purgeProjectHistory', { projectId: x.projectId, confirmPhrase: 'purge' });

    expect(after.ok && after.data.purgedSnapshots).toBe(before);
    expect(x.db.repos.memory.runSnapshot(runId)).toEqual([]);
  });

  it('#15: a ticked record archived before intake is dropped (skipped event + log), and the run proceeds instead of setup_blocked', async () => {
    const x = await createHarness({ start: false });
    h = x;
    const kept = await rule(x, 'Use helpers');
    const dropped = await rule(x, 'Validate early');
    const started = await x.call('relay/v1/runs.start', { idempotencyKey: key('e2-run'), projectId: x.projectId, workflowId: x.workflowId, workflowVersion: 1,
      goal: 'Fix the defects in the handlers.', input: { kind: 'files', relPaths: [...DEFAULT_REL_PATHS] }, memoryRecordIds: [kept.id, dropped.id] });
    if (!started.ok) throw new Error(`runs.start ${started.error.code}`);
    const archived = await x.call('relay/v1/memory.archive', { recordId: dropped.id });
    expect(archived.ok).toBe(true);

    await x.engine.start();
    const run = await x.waitFor(started.data.runId, ['awaiting_approval', 'paused']);

    expect([run.status, run.pauseReason]).toEqual(['awaiting_approval', null]);
    expect(x.db.repos.memory.runSnapshot(run.id).map((s) => s.recordId)).toEqual([kept.id]);
    const events = (await detail(x, dropped.id)).events;
    expect(events.find((e) => e.event === 'skipped')).toMatchObject({ actor: `run:${run.id}`, detail: { runId: run.id, status: 'archived' } });
    expect(x.logger.lines.some((l) => l.includes('memory_record_skipped'))).toBe(true);
  });

  it('#16: confirmCurrent re-hashes the file source (clears stale), writes `reviewed`, keeps reviewAt; review-due follows the last review, not updatedAt', async () => {
    const x = await createHarness();
    h = x;
    const now = Date.now();
    const created = await rule(x, 'Error format', { type: 'source_reference', sourceFile: { relPath: 'src/errors.ts' }, reviewAt: now - 1_000 });
    expect([created.stale, created.reviewDue, created.lastReviewedAt]).toEqual([false, true, null]);
    await writeFile(join(x.projectRoot, 'src', 'errors.ts'), '// changed after the record was written\nexport {};\n');
    const stale = await detail(x, created.id);
    expect(stale.stale).toBe(true);

    // An unrelated edit moves updatedAt but is not a review: still due (the old renderer rule would have hidden it).
    const pinned = await x.call('relay/v1/memory.update', { recordId: created.id, expectedRevision: stale.currentRevision, pinned: true });
    expect(pinned.ok && [pinned.data.reviewDue, pinned.data.updatedAt > created.updatedAt]).toEqual([true, true]);

    const confirmed = await x.call('relay/v1/memory.update', { recordId: created.id, expectedRevision: stale.currentRevision, confirmCurrent: true } as never);

    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.data).toMatchObject({ stale: false, reviewDue: false, reviewAt: created.reviewAt, currentRevision: created.currentRevision + 1 });
    expect(confirmed.data.lastReviewedAt).not.toBeNull();
    expect(confirmed.data.events.at(-1)).toMatchObject({ event: 'reviewed', actor: 'user', detail: { fileRefs: 1, refreshed: 1 } });
    expect(confirmed.data.revisions.at(-1)?.content).toBe(created.content);

    // A future review date set later is kept and not due until it passes.
    const future = now + 86_400_000;
    const later = await x.call('relay/v1/memory.update', { recordId: created.id, expectedRevision: confirmed.data.currentRevision, reviewAt: future });
    const again = await x.call('relay/v1/memory.update', { recordId: created.id, expectedRevision: confirmed.data.currentRevision, confirmCurrent: true } as never);
    expect(later.ok && later.data.reviewDue).toBe(false);
    expect(again.ok && [again.data.reviewAt, again.data.currentRevision]).toEqual([future, confirmed.data.currentRevision]); // nothing changed on disk
  });

  it('#16: confirming a record whose source file is gone fails and writes nothing', async () => {
    const x = await createHarness();
    h = x;
    const created = await rule(x, 'Health', { type: 'source_reference', sourceFile: { relPath: 'src/handlers/health.ts' } });
    await writeFile(join(x.projectRoot, 'src', 'handlers', 'health.ts'), 'x'); // still there: confirm works
    const { rm } = await import('node:fs/promises');
    await rm(join(x.projectRoot, 'src', 'handlers', 'health.ts'));

    const r = await x.call('relay/v1/memory.update', { recordId: created.id, expectedRevision: 1, confirmCurrent: true } as never);

    expect(r.ok ? null : r.error.code).toBe('NOT_FOUND');
    expect((await detail(x, created.id)).events.map((e) => e.event)).not.toContain('reviewed');
  });

  it('#17: a run suggestion exposes proposal.sourceRefs; events carry their detail; revisions carry their run usage', async () => {
    const x = await createHarness();
    h = x;
    const used = await rule(x, 'Return types');
    const runId = await x.startRun();
    await x.waitFor(runId, 'awaiting_approval');
    await x.approve(runId);
    await x.waitFor(runId, ['completed', 'incomplete']);
    const suggestions = await x.call('relay/v1/memory.list', { projectId: x.projectId, status: ['suggested'] });
    const first = suggestions.ok ? suggestions.data[0] : undefined;
    expect(first).toBeDefined();
    if (first === undefined) return;

    const s = await detail(x, first.id);
    const rejected = await x.call('relay/v1/memory.reject', { suggestionId: first.id, reason: 'Not durable.' });
    const after = await detail(x, first.id);
    const usedDetail = await detail(x, used.id);

    expect(Array.isArray(s.proposal?.sourceRefs)).toBe(true);
    expect((s.proposal?.sourceRefs ?? []).every((r) => typeof r.relPath === 'string')).toBe(true);
    expect(rejected.ok).toBe(true);
    expect(after.events.find((e) => e.event === 'rejected')?.detail).toEqual({ reason: 'Not durable.' });
    expect(usedDetail.revisions[0]?.usedByRuns).toBe(1);
  });
});

describe('E2 projects', () => {
  it('#18: an archived project is listed with includeArchived and can be restored; restoring twice → CONFLICT', async () => {
    const x = await createHarness();
    h = x;

    const archived = await x.call('relay/v1/projects.archive', { projectId: x.projectId });
    const active = await x.call('relay/v1/projects.list', {});
    const all = await x.call('relay/v1/projects.list', { includeArchived: true });
    const restored = await x.call('relay/v1/projects.unarchive', { projectId: x.projectId });
    const twice = await x.call('relay/v1/projects.unarchive', { projectId: x.projectId });

    expect(archived.ok && archived.data.archivedAt).not.toBeNull();
    expect(active.ok && active.data.map((p) => p.id)).not.toContain(x.projectId);
    expect(all.ok && all.data.map((p) => p.id)).toContain(x.projectId);
    expect(restored.ok && restored.data.archivedAt).toBeNull();
    expect(twice.ok ? null : [twice.error.code, twice.error.details?.['reason']]).toEqual(['CONFLICT', 'not_archived']);
  });
});
