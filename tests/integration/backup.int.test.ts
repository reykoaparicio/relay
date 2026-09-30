// 11 §K6 backup (@m4): app.createBackup → the backup DB opens (integrity ok) and references the artifacts it copied;
// no secrets/ dir; the restore procedure (copy the backup DB + artifacts into an empty userData dir, open with the
// current build) is exercised programmatically and yields the same runs, ledger, and readable artifacts.
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { listFiles } from '../helpers/invariants.js';
import { integrityCheck, queryAll } from '../helpers/sqlite-inspect.js';
import { cleanupTempDirs, makeTempDir } from '../helpers/temp-dirs.js';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const x of harnesses.splice(0)) await x.dispose();
  await cleanupTempDirs();
});

describe('backup @m4', () => {
  it('createBackup → backup DB opens, artifacts referenced and copied, no secrets/; restore round-trips @m4', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const runId = await h.startRun();
    await h.waitFor(runId, 'awaiting_approval');
    await h.approve(runId);
    await h.waitFor(runId, 'completed');
    await h.waitUntil(() => h.db.repos.artifacts.listForRun(runId, ['report']).length === 1, 10_000, 'report');
    // A secrets/ dir in userData (credential vault files live there) must never enter a backup.
    await mkdir(join(h.userDataDir, 'secrets'), { recursive: true });
    await writeFile(join(h.userDataDir, 'secrets', 'anthropic.vault'), 'encrypted-vault-bytes');

    const res = await h.call('relay/v1/app.createBackup', { idempotencyKey: 'backup-key-000001' });

    expect(res.ok).toBe(true);
    const dirs = await readdir(join(h.userDataDir, 'backups'));
    expect(dirs).toHaveLength(1);
    const dir = join(h.userDataDir, 'backups', dirs[0]!);
    const backupDb = join(dir, 'relay.sqlite');
    expect(integrityCheck(backupDb)).toBe('ok');
    expect(existsSync(join(dir, 'secrets'))).toBe(false);
    const files = await listFiles(dir, dir);
    expect(files.some((f) => f.startsWith('secrets/') || f.includes('vault'))).toBe(false);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { artifactCount: number; sha256s: string[] };
    const rows = queryAll(backupDb, 'SELECT rel_path AS relPath, sha256 FROM artifacts WHERE purged_at IS NULL');
    expect(manifest.artifactCount).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(files).toContain(String(r['relPath']));
    expect(new Set(manifest.sha256s)).toEqual(new Set(rows.map((r) => String(r['sha256']))));

    // Restore: an empty userData gets the backup DB + artifacts; the current build opens it.
    const restored = await makeTempDir('relay-restore-ud-');
    await cp(backupDb, join(restored, 'relay.sqlite'));
    await cp(join(dir, 'artifacts'), join(restored, 'artifacts'), { recursive: true });
    const r = await createHarness({ userDataDir: restored, projectRoot: h.projectRoot, start: false });
    harnesses.push(r);
    expect(r.db.repos.runs.get(runId).status).toBe('completed');
    expect(r.db.repos.ledger.runBalances(runId)).toEqual(h.db.repos.ledger.runBalances(runId));
    const [report] = r.db.repos.artifacts.listForRun(runId, ['report']);
    const bytes = await r.artifacts.read(report!.relPath, 10_000_000);
    expect(bytes.ok).toBe(true);
    const replay = await h.call('relay/v1/app.createBackup', { idempotencyKey: 'backup-key-000001' });
    expect(replay.ok && res.ok && replay.data.backupDisplayPath).toBe(res.ok ? res.data.backupDisplayPath : null);
    expect(await readdir(join(h.userDataDir, 'backups'))).toHaveLength(1); // idempotent
  });
});
