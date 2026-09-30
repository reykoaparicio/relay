import type { Result } from '@relay/contracts';
import { epochMs, err, errors, ok } from '@relay/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMaintenance } from './maintenance.js';
import type { FixtureDb } from './testing/fixtures.js';
import { newId, openFixtureDb, seedProject, seedRun, sha } from './testing/fixtures.js';
import type { ArtifactKind } from '@relay/contracts';

describe('maintenance (C8)', () => {
  let f: FixtureDb;
  beforeEach(async () => {
    f = await openFixtureDb();
  });
  afterEach(async () => {
    await f.db.dispose();
  });

  const purger = (failing: ReadonlySet<string> = new Set()) => {
    const calls: string[] = [];
    return {
      calls,
      purge: (relPath: string): Promise<Result<{ purgedAt: number }>> => {
        calls.push(relPath);
        return Promise.resolve(failing.has(relPath) ? err(errors.artifactWriteFailed()) : ok({ purgedAt: 777 }));
      },
    };
  };

  const art = (runId: Parameters<typeof seedRun>[3] extends never ? never : string, projectId: string, kind: ArtifactKind, createdAt: number, h: string) =>
    f.db.repos.artifacts.insertIfAbsent({
      id: newId('artifact'),
      runId: runId as never,
      projectId: projectId as never,
      kind,
      relPath: `artifacts/run/${h}-${kind}`,
      sha256: sha(h),
      sizeBytes: 1,
      mediaType: 'text/plain',
      createdAt: epochMs(createdAt),
    });

  it('purges project history: snapshot rows, raw responses and manifests, with memory events; the ledger is untouched', async () => {
    const p = seedProject(f.db, f.clock);
    const other = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const otherRun = seedRun(f.db, f.clock, other.id);
    const m = f.db.repos.memory.insertRecord(
      { id: newId('memory'), projectId: p.id, type: 'user_rule', status: 'approved', scope: { roles: 'all' }, createdAt: f.clock.now() },
      { id: newId('memoryRevision'), title: 'T', content: 'C', sourceRefs: [], author: 'user', createdAt: f.clock.now() },
    );
    f.db.repos.memory.snapshotForRun(run.id, [{ recordId: m.record.id, revision: 1, title: 'T', content: 'C', included: true }]);
    const raw = art(run.id, p.id, 'raw_response', 1, '1');
    const manifest = art(run.id, p.id, 'context_manifest', 1, '2');
    const plan = art(run.id, p.id, 'plan', 1, '3');
    const foreign = art(otherRun.id, other.id, 'raw_response', 1, '4');
    const failing = art(run.id, p.id, 'raw_response', 1, '5');
    f.db.repos.ledger.append([{ scope: 'run', type: 'allowance_set', bucket: 'allowance', deltaMicrousd: 1, runId: run.id, projectId: p.id }]);
    const store = purger(new Set([failing.relPath]));

    const summary = await createMaintenance({ db: f.db, artifacts: store, clock: f.clock }).purgeProjectHistory(p.id);

    expect(summary).toEqual({ purgedSnapshots: 1, purgedArtifacts: 2, failed: 1 });
    expect(f.db.repos.memory.runSnapshot(run.id)).toEqual([]);
    expect(f.db.repos.artifacts.get(raw.id)?.purgedAt).toBe(777);
    expect(f.db.repos.artifacts.get(manifest.id)?.purgedAt).toBe(777);
    expect(f.db.repos.artifacts.get(plan.id)?.purgedAt).toBeNull();
    expect(f.db.repos.artifacts.get(foreign.id)?.purgedAt).toBeNull();
    expect(f.db.repos.artifacts.get(failing.id)?.purgedAt).toBeNull();
    expect(f.db.repos.memory.getWithRevisions(m.record.id)?.events.map((e) => e.detail)).toEqual([{ action: 'project_history_purged' }]);
    expect(f.db.repos.ledger.runBalances(run.id).L).toBe(1);
  });

  it('sweeps raw responses older than the retention window only', async () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const day = 86_400_000;
    const now = 100 * day;
    const old = art(run.id, p.id, 'raw_response', now - 31 * day, '1');
    const fresh = art(run.id, p.id, 'raw_response', now - 29 * day, '2');
    const oldPlan = art(run.id, p.id, 'plan', now - 90 * day, '3');
    const store = purger();
    const maintenance = createMaintenance({ db: f.db, artifacts: store, clock: f.clock });

    const first = await maintenance.sweepRawResponses(epochMs(now), 30);
    const second = await maintenance.sweepRawResponses(epochMs(now), 30);

    expect(first).toEqual({ purgedArtifacts: 1, failed: 0 });
    expect(second).toEqual({ purgedArtifacts: 0, failed: 0 });
    expect(store.calls).toEqual([old.relPath]);
    expect(f.db.repos.artifacts.get(fresh.id)?.purgedAt).toBeNull();
    expect(f.db.repos.artifacts.get(oldPlan.id)?.purgedAt).toBeNull();
  });
});
