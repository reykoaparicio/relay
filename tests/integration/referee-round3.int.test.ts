// Referee round-3 back-end rulings over the real runtime. Each fails on the pre-fix code:
// L1 a backup restore killed mid-swap is completed by the next launch (createRuntime) before the database opens;
// M3 relocateRoot accepts a folder without confirmation only when a clear majority of the known files match;
// M4 a suspected-secret acknowledgement is bound to the file's content hash: a changed file is flagged again by
// preflight, by intake, and by the resnapshot after approval_stale (so a real key pasted later is never sent).
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createIdGen, ok, systemClock } from '@relay/contracts';
import { createRuntime } from '@relay/engine';
import { createBackup, openDb } from '@relay/storage';
import { DEFAULT_REL_PATHS, createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { cleanupTempDirs, makeTempDir } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

// Built at runtime so the source never holds a credential-shaped literal.
const FAKE = `ghp_${'Q7w8E9r0T1'.repeat(4)}`;
const REAL = `sk-ant-api03-${'Zx9Yw8Vu7T'.repeat(5)}`;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

async function copyKnown(x: Harness, to: string, relPaths: readonly string[]): Promise<void> {
  for (const p of relPaths) {
    await mkdir(dirname(join(to, p)), { recursive: true });
    await writeFile(join(to, p), await readFile(join(x.projectRoot, p)));
  }
}

describe('M3: relocateRoot needs a clear majority of matching files', () => {
  it('an unrelated folder sharing ONE identical file is CONFLICT root_unverified (with the verification) until confirmed', async () => {
    const x = await createHarness();
    h = x;
    const runId = await x.startRun();
    await x.waitFor(runId, 'awaiting_approval');
    expect(DEFAULT_REL_PATHS.length).toBeGreaterThanOrEqual(3);
    const other = await makeTempDir('relay-r3-other-');
    await copyKnown(x, other, [DEFAULT_REL_PATHS[0] ?? '']);
    await writeFile(join(other, 'main.py'), 'print("a different project")\n');

    const refused = await x.call('relay/v1/projects.relocateRoot', { projectId: x.projectId, rootRealpath: other, rootDisplayPath: '~/other' });

    expect(refused.ok ? null : [refused.error.code, refused.error.details?.['reason']]).toEqual(['CONFLICT', 'root_unverified']);
    expect(refused.ok ? null : refused.error.details?.['verification']).toMatchObject({ checkedFiles: DEFAULT_REL_PATHS.length, matchedFiles: 1 });
    const confirmed = await x.call('relay/v1/projects.relocateRoot', { projectId: x.projectId, rootRealpath: other, rootDisplayPath: '~/other', confirm: true });
    expect(confirmed.ok && confirmed.data.verification).toMatchObject({ checkedFiles: DEFAULT_REL_PATHS.length, matchedFiles: 1 });
  });

  it('a folder where at least half (and at least min(3, checked)) of the known files match is accepted without confirm', async () => {
    const x = await createHarness();
    h = x;
    const runId = await x.startRun();
    await x.waitFor(runId, 'awaiting_approval');
    const half = Math.max(3, Math.ceil(DEFAULT_REL_PATHS.length / 2));
    const other = await makeTempDir('relay-r3-mostly-');
    await copyKnown(x, other, DEFAULT_REL_PATHS.slice(0, half));

    const res = await x.call('relay/v1/projects.relocateRoot', { projectId: x.projectId, rootRealpath: other, rootDisplayPath: '~/mostly' });

    expect(res.ok).toBe(true);
    expect(res.ok && res.data.verification).toMatchObject({ checkedFiles: DEFAULT_REL_PATHS.length, matchedFiles: half });
  });
});

describe('M4: a suspected-secret acknowledgement is bound to the content hash', () => {
  const deployFake = `export const token = '${FAKE}';\n`;

  it('a resnapshot after approval_stale re-checks a changed acknowledged file: the new secret is refused, never snapshotted', async () => {
    const x = await createHarness({ start: false });
    h = x;
    const file = join(x.projectRoot, 'src', 'deploy.ts');
    await writeFile(file, deployFake);
    const input = { kind: 'files' as const, relPaths: [...DEFAULT_REL_PATHS, 'src/deploy.ts'], acknowledgedSuspectedSecrets: [{ relPath: 'src/deploy.ts', sha256: sha(deployFake) }] };
    const started = await x.call('relay/v1/runs.start', { projectId: x.projectId, workflowId: x.workflowId, workflowVersion: 1, goal: 'Fix the defects in the handlers.', input, idempotencyKey: 'r3-ack-bind-0001' });
    if (!started.ok) throw new Error(started.error.code);
    await x.engine.start();
    const runId = started.data.runId;
    await x.waitFor(runId, 'awaiting_approval');
    expect(x.db.repos.runs.inputFiles(runId).map((f) => f.relPath)).toContain('src/deploy.ts'); // the acknowledged content went in

    await writeFile(file, `export const token = '${REAL}';\n`); // the user pastes a real key into the acknowledged file
    await x.approve(runId);
    await x.waitFor(runId, (r) => r.status === 'paused' && r.pauseReason === 'approval_stale');
    const res = await x.resume(runId, { kind: 'resnapshot_and_replan' } as never);

    expect(res.ok).toBe(false);
    expect(res.ok ? null : [res.error.code, res.error.details?.['reason']]).toEqual(['PERMISSION_DENIED', 'suspected_secret']);
    expect(JSON.stringify(res)).not.toContain(REAL);
    const snap = x.db.repos.artifacts.listWhere({ unpurgedOnly: true }).filter((a) => a.kind === 'input_file');
    const contents = await Promise.all(snap.map((a) => readFile(join(x.userDataDir, a.relPath), 'utf8').catch(() => '')));
    expect(contents.some((c) => c.includes('Zx9Yw8Vu7T'))).toBe(false);
  });

  it('preflight and intake flag an acknowledged file whose content changed (hash mismatch); a matching hash is honoured', async () => {
    const x = await createHarness({ start: false });
    h = x;
    await writeFile(join(x.projectRoot, 'src', 'deploy.ts'), `export const token = '${REAL}';\n`);
    const stale = { kind: 'files' as const, relPaths: ['src/errors.ts', 'src/deploy.ts'], acknowledgedSuspectedSecrets: [{ relPath: 'src/deploy.ts', sha256: sha(deployFake) }] };
    const base = { projectId: x.projectId, workflowId: x.workflowId, workflowVersion: 1, goal: 'Fix the defects in the handlers.' };

    const pre = await x.call('relay/v1/runs.preflight', { ...base, input: stale });
    if (!pre.ok) throw new Error(pre.error.code);
    expect(pre.data.issues.filter((i) => i.code === 'suspected_secret').map((i) => i.path)).toEqual(['input.relPaths.1']);
    const started = await x.call('relay/v1/runs.start', { ...base, input: stale, idempotencyKey: 'r3-ack-stale-0001' });
    if (!started.ok) throw new Error(started.error.code);
    await x.engine.start();
    const run = await x.waitFor(started.data.runId, ['paused', 'awaiting_approval']);
    expect([run.status, run.pauseReason]).toEqual(['paused', 'setup_blocked']);
    expect(JSON.stringify(run.statusDetail)).toContain('suspected_secret');
    expect(x.calls({ runId: run.id })).toEqual([]);

    const current = { ...stale, acknowledgedSuspectedSecrets: [{ relPath: 'src/deploy.ts', sha256: sha(`export const token = '${REAL}';\n`) }] };
    const ok = await x.call('relay/v1/runs.preflight', { ...base, input: current });
    expect(ok.ok && ok.data.issues.filter((i) => i.code === 'suspected_secret')).toEqual([]);
  });

  it('the preview gives the sha256 of a flagged file (what the New-run form binds its confirmation to)', async () => {
    const x = await createHarness();
    h = x;
    await writeFile(join(x.projectRoot, 'src', 'deploy.ts'), deployFake);
    const preview = await x.call('relay/v1/projects.previewRoot', { projectId: x.projectId, extraExclusions: [] });
    expect(preview.ok && preview.data.included.find((f) => f.relPath === 'src/deploy.ts')).toMatchObject({ suspectedSecret: true, sha256: sha(deployFake) });
  });

  it('runs.start refuses the legacy string form of an acknowledgement (VALIDATION_FAILED)', async () => {
    const x = await createHarness({ start: false });
    h = x;
    const input = { kind: 'files' as const, relPaths: ['src/errors.ts'], acknowledgedSuspectedSecrets: ['src/errors.ts'] };
    const res = await x.call('relay/v1/runs.start', { projectId: x.projectId, workflowId: x.workflowId, workflowVersion: 1, goal: 'Fix.', input, idempotencyKey: 'r3-ack-legacy-0001' } as never);
    expect(res.ok ? null : res.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('L1: a restore killed mid-swap is completed by the next launch', () => {
  it('createRuntime finishes the swap before opening the database: the restored data, the old files kept aside', async () => {
    const dir = await makeTempDir('relay-r3-restore-');
    const path = join(dir, 'relay.sqlite');
    const ids = createIdGen(systemClock, (n) => new Uint8Array(randomBytes(n)));
    const db = await openDb({ path, clock: systemClock, ids, backupsDir: join(dir, 'backups') });
    db.tx('immediate', (r) => {
      r.settings.set('marker', 'from-backup');
    });
    const backup = await createBackup({ db, userDataDir: dir, clock: systemClock });
    db.tx('immediate', (r) => {
      r.settings.set('marker', 'old');
    });
    db.close();
    // The restore was killed after the marker and after the old database was moved aside (no live relay.sqlite).
    const aside = 'relay.sqlite.before-restore-20261001-120000';
    copyFileSync(join(backup.dir, 'relay.sqlite'), `${path}.partial`);
    mkdirSync(join(dir, `${aside}.partial`));
    writeFileSync(join(dir, 'relay.sqlite.restore-pending.json'), JSON.stringify({ asidePartial: `${aside}.partial`, aside }));
    renameSync(path, join(dir, `${aside}.partial`, 'relay.sqlite'));

    const rt = await createRuntime({ userDataDir: dir, providerMode: 'fake', credentials: { resolve: () => Promise.resolve(ok('k')) } });
    try {
      expect(rt.db.repos.settings.get('marker')).toBe('from-backup');
    } finally {
      await rt.dispose();
    }
    expect(existsSync(join(dir, 'relay.sqlite.restore-pending.json'))).toBe(false);
    expect(readdirSync(join(dir, aside))).toContain('relay.sqlite');
  });
});
