import type { MemoryRecordScope, MemoryType, ProjectId } from '@relay/contracts';
import { epochMs } from '@relay/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FixtureDb } from '../testing/fixtures.js';
import { newId, openFixtureDb, seedProject, seedRun } from '../testing/fixtures.js';
import type { MemoryRepo } from '../types.js';

describe('MemoryRepo', () => {
  let f: FixtureDb;

  beforeEach(async () => {
    f = await openFixtureDb();
  });
  afterEach(async () => {
    await f.db.dispose();
  });

  const add = (
    projectId: ProjectId,
    o: { status?: 'suggested' | 'approved' | 'archived'; scope?: MemoryRecordScope; expiresAt?: number; title?: string; type?: MemoryType } = {},
  ) =>
    f.db.repos.memory.insertRecord(
      {
        id: newId('memory'),
        projectId,
        type: o.type ?? 'user_rule',
        status: o.status ?? 'approved',
        scope: o.scope ?? { roles: 'all' },
        ...(o.expiresAt === undefined ? {} : { expiresAt: epochMs(o.expiresAt) }),
        createdAt: f.clock.now(),
      },
      { id: newId('memoryRevision'), title: o.title ?? 'Use pnpm', content: 'Never npm.', sourceRefs: [], author: 'user', createdAt: f.clock.now() },
    );

  it('requires projectId at the type level for list', () => {
    const repo: MemoryRepo = f.db.repos.memory;

    // @ts-expect-error — §10.5: projectId is mandatory
    const call = () => repo.list({ statuses: ['approved'] });

    expect(typeof call).toBe('function');
  });

  it('retrievable excludes suggested, archived, expired, other-project, and other-role records', () => {
    const p = seedProject(f.db, f.clock);
    const other = seedProject(f.db, f.clock);
    const now = f.clock.now();
    const all = add(p.id, { title: 'all roles' });
    const reviewer = add(p.id, { scope: { roles: ['reviewer'] }, title: 'reviewer' });
    add(p.id, { scope: { roles: ['planner'] } });
    add(p.id, { status: 'suggested' });
    add(p.id, { status: 'archived' });
    add(p.id, { expiresAt: now - 1 });
    const future = add(p.id, { expiresAt: now + 1000, title: 'not yet expired' });
    add(other.id);

    const got = f.db.repos.memory.retrievable(p.id, 'reviewer', now).map((m) => m.record.id);

    expect(new Set(got)).toEqual(new Set([all.record.id, reviewer.record.id, future.record.id]));
  });

  it('addRevision is CAS on current_revision', () => {
    const p = seedProject(f.db, f.clock);
    const m = add(p.id);
    const rev = () => ({ id: newId('memoryRevision'), title: 'v2', content: 'New.', sourceRefs: [], author: 'user', createdAt: f.clock.now() });

    const ok = f.db.repos.memory.addRevision(m.record.id, rev(), 1);
    const stale = f.db.repos.memory.addRevision(m.record.id, rev(), 1);
    const detail = f.db.repos.memory.getWithRevisions(m.record.id);

    expect(ok.ok && ok.value.revision).toBe(2);
    expect(!stale.ok && stale.error.code).toBe('CONFLICT');
    expect(detail?.item.current.title).toBe('v2');
    expect(detail?.revisions.map((r) => r.revision)).toEqual([1, 2]);
  });

  it('lists with status/type/query filters, sets status, records events, and supersedes', () => {
    const p = seedProject(f.db, f.clock);
    const a = add(p.id, { title: '100% literal_match' });
    const b = add(p.id, { status: 'suggested', type: 'project_decision', title: 'Other' });
    const repo = f.db.repos.memory;

    const byQuery = repo.list({ projectId: p.id, query: '100%' }).map((x) => x.record.id);
    const noWildcard = repo.list({ projectId: p.id, query: 'l_teral' });
    const byType = repo.list({ projectId: p.id, types: ['project_decision'], statuses: ['suggested'] }).map((x) => x.record.id);
    const moved = repo.setStatus(b.record.id, ['suggested'], 'deleted', epochMs(99));
    const lost = repo.setStatus(b.record.id, ['suggested'], 'approved', epochMs(99));
    repo.setSupersededBy(a.record.id, b.record.id, epochMs(100));
    const ev = repo.recordEvent({ recordId: a.record.id, event: 'approved', revision: 1, actor: 'user', createdAt: epochMs(5) });

    expect(byQuery).toEqual([a.record.id]);
    expect(noWildcard).toEqual([]);
    expect(byType).toEqual([b.record.id]);
    expect(moved).toBe(true);
    expect(lost).toBe(false);
    expect(repo.get(b.record.id)?.record.deletedAt).toBe(99);
    expect(repo.get(a.record.id)?.record.supersededById).toBe(b.record.id);
    expect(repo.getWithRevisions(a.record.id)?.events.map((e) => e.id)).toEqual([ev.id]);
    expect(repo.get(newId('memory'))).toBeUndefined();
    expect(repo.getWithRevisions(newId('memory'))).toBeUndefined();
    expect(() => repo.setStatus(a.record.id, [], 'archived', epochMs(1))).toThrow();
  });

  it('snapshots memory per run and purges the snapshots of one project only', () => {
    const p = seedProject(f.db, f.clock);
    const other = seedProject(f.db, f.clock);
    const m = add(p.id);
    const o = add(other.id);
    const run = seedRun(f.db, f.clock, p.id);
    const otherRun = seedRun(f.db, f.clock, other.id);
    f.db.repos.memory.snapshotForRun(run.id, [{ recordId: m.record.id, revision: 1, title: 'T', content: 'C', included: true }]);
    f.db.repos.memory.snapshotForRun(otherRun.id, [{ recordId: o.record.id, revision: 1, title: 'T', content: 'C', included: false }]);

    const snap = f.db.repos.memory.runSnapshot(run.id);
    const purged = f.db.repos.memory.purgeRunSnapshots(p.id);

    expect(snap.map((s) => [s.recordId, s.included])).toEqual([[m.record.id, true]]);
    expect(purged).toEqual({ deleted: 1, recordIds: [m.record.id] });
    expect(f.db.repos.memory.runSnapshot(run.id)).toEqual([]);
    expect(f.db.repos.memory.runSnapshot(otherRun.id)).toHaveLength(1);
  });

  it('insertRecord leaves no orphan record when the revision is invalid (B2)', () => {
    const p = seedProject(f.db, f.clock);
    const id = newId('memory');

    expect(() =>
      f.db.repos.memory.insertRecord(
        { id, projectId: p.id, type: 'user_rule', status: 'approved', scope: { roles: 'all' }, createdAt: f.clock.now() },
        { id: newId('memoryRevision'), title: '', content: 'C', sourceRefs: [], author: 'user', createdAt: f.clock.now() },
      ),
    ).toThrow(/CHECK constraint failed/);

    expect(f.db.repos.memory.get(id)).toBeUndefined();
    expect(f.db.repos.memory.list({ projectId: p.id })).toEqual([]);
  });

  it('addRevision does not move current_revision when the new revision is invalid (B2)', () => {
    const p = seedProject(f.db, f.clock);
    const m = add(p.id);

    expect(() =>
      f.db.repos.memory.addRevision(
        m.record.id,
        { id: newId('memoryRevision'), title: 'ok', content: '', sourceRefs: [], author: 'user', createdAt: f.clock.now() },
        1,
      ),
    ).toThrow(/CHECK constraint failed/);

    expect(f.db.repos.memory.get(m.record.id)?.record.currentRevision).toBe(1);
  });

  it('snapshotForRun is all-or-nothing (B2)', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const m = add(p.id);
    const row = { recordId: m.record.id, revision: 1, title: 'T', content: 'C', included: true };

    expect(() => { f.db.repos.memory.snapshotForRun(run.id, [row, row]); }).toThrow(/UNIQUE constraint failed/);

    expect(f.db.repos.memory.runSnapshot(run.id)).toEqual([]);
  });
});
