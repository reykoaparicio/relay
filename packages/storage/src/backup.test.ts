import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackup } from './backup.js';
import { openNodeSqlite } from './driver-node-sqlite.js';
import type { FixtureDb } from './testing/fixtures.js';
import { newId, openFixtureDb, seedAttempt, seedProject, seedRun, seedStep, sha } from './testing/fixtures.js';

describe('createBackup', () => {
  let f: FixtureDb;
  let userData: string;

  beforeEach(async () => {
    f = await openFixtureDb();
    userData = join(dirname(f.db.path), 'userData');
    mkdirSync(join(userData, 'secrets'), { recursive: true });
    writeFileSync(join(userData, 'secrets', 'crd_X.bin'), 'encrypted');
  });
  afterEach(async () => {
    await f.db.dispose();
  });

  const seedArtifact = (runId: Parameters<typeof seedStep>[2], projectId: string, relPath: string, write: boolean) => {
    if (write) {
      mkdirSync(dirname(join(userData, relPath)), { recursive: true });
      writeFileSync(join(userData, relPath), 'bytes');
    }
    return f.db.repos.artifacts.insertIfAbsent({
      id: newId('artifact'),
      runId,
      projectId: projectId as never,
      kind: 'report',
      relPath,
      sha256: sha(relPath.length % 2 === 0 ? 'a' : 'b'),
      sizeBytes: 5,
      mediaType: 'application/json',
      createdAt: f.clock.now(),
    });
  };

  it('produces an openable DB with identical run_budget_v output, copies referenced artifacts, and never secrets/', async () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const step = seedStep(f.db, f.clock, run.id);
    const att = seedAttempt(f.db, f.clock, run.id, step.id);
    f.db.repos.ledger.append([
      { scope: 'run', type: 'allowance_set', bucket: 'allowance', deltaMicrousd: 900, runId: run.id, projectId: p.id },
      { scope: 'run', type: 'reserve', bucket: 'reserved', deltaMicrousd: 100, runId: run.id, projectId: p.id, attemptId: att.id },
    ]);
    seedArtifact(run.id, p.id, 'artifacts/run/a1', true);
    seedArtifact(run.id, p.id, 'artifacts/run/missing', false);
    seedArtifact(run.id, p.id, 'secrets/crd_X.bin', true);
    const purged = seedArtifact(run.id, p.id, 'artifacts/run/purged', true);
    f.db.repos.artifacts.markPurged(purged.id, f.clock.now());
    f.clock.set(Date.UTC(2026, 8, 30, 1, 2, 3));

    const b = await createBackup({ db: f.db, userDataDir: userData, clock: f.clock });
    const again = await createBackup({ db: f.db, userDataDir: userData, clock: f.clock });
    const copy = openNodeSqlite(b.dbPath, { readOnly: true });
    const live = openNodeSqlite(f.db.path, { readOnly: true });
    const q = 'SELECT * FROM run_budget_v ORDER BY run_id';

    expect(copy.prepare(q).all()).toEqual(live.prepare(q).all());
    expect(b.dir.endsWith(join('backups', '20260930-010203'))).toBe(true);
    expect(again.dir.endsWith('20260930-010203-1')).toBe(true);
    expect(readdirSync(b.dir).sort()).toEqual(['artifacts', 'manifest.json', 'relay.sqlite']);
    expect(existsSync(join(b.dir, 'artifacts', 'run', 'a1'))).toBe(true);
    expect(existsSync(join(b.dir, 'artifacts', 'run', 'purged'))).toBe(false);
    expect(existsSync(join(b.dir, 'secrets'))).toBe(false);
    expect(JSON.parse(readFileSync(join(b.dir, 'manifest.json'), 'utf8'))).toMatchObject({ schemaVersion: 1, artifactCount: 1 });
    expect(b.sizeBytes).toBeGreaterThan(5);
    copy.close();
    live.close();
  });

  it('builds the manifest from the snapshot, not the live DB changed after backupTo (B3)', async () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const inSnapshot = seedArtifact(run.id, p.id, 'artifacts/run/in-snapshot', true);
    let late: ReturnType<typeof seedArtifact> | undefined;
    // Hook: the live DB changes right after the snapshot is taken.
    const db = {
      ...f.db,
      backupTo: async (dest: string): Promise<void> => {
        await f.db.backupTo(dest);
        late = seedArtifact(run.id, p.id, 'artifacts/run/late-x', true);
        f.db.repos.artifacts.markPurged(inSnapshot.id, f.clock.now());
      },
    };

    const b = await createBackup({ db, userDataDir: userData, clock: f.clock });

    expect(late).toBeDefined();
    expect(b.manifest).toMatchObject({ schemaVersion: 1, artifactCount: 1, sha256s: [inSnapshot.sha256] });
    expect(existsSync(join(b.dir, 'artifacts', 'run', 'in-snapshot'))).toBe(true);
    expect(existsSync(join(b.dir, 'artifacts', 'run', 'late-x'))).toBe(false);
  });
});
