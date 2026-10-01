// 13 §M3 / §18.4: demo reset may only ever replace a dir named exactly `Relay-Demo`, and must be repeatable.
// Every child runs with HOME pointed at a fresh temp dir, so even a guard bug could never reach the real
// ~/Library/Application Support. All dirs come from tests/helpers/temp-dirs.ts and are removed through its guard.
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, toDisplayPath } from '@relay/contracts';
import { createRuntime } from '@relay/engine';
import { cleanupTempDirs, makeTempDir } from '../helpers/temp-dirs.js';
import { REPO_ROOT, runScript } from './run-script.js';

afterEach(async () => {
  await cleanupTempDirs();
});

const VAULT_FILE = 'secrets/crd_01J0000000000000000000ABCD.bin';
const quietLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

async function fakeHome(): Promise<string> {
  const home = await makeTempDir('relay-demo-home-');
  await mkdir(join(home, 'Library', 'Application Support'), { recursive: true });
  return home;
}

async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

async function withRuntime<T>(userDataDir: string, fn: (rt: Awaited<ReturnType<typeof createRuntime>>) => Promise<T>): Promise<T> {
  const rt = await createRuntime({ userDataDir, providerMode: 'fake', fakeScenario: 'happy-path', credentials: { resolve: () => Promise.resolve(ok('k')) }, logger: quietLogger });
  try {
    return await fn(rt);
  } finally {
    await rt.dispose();
  }
}

describe('demo-reset refuses every non-demo path', () => {
  it.each([
    ['the home dir', (h: string) => h],
    ['the filesystem root', () => '/'],
    ['the temp dir', () => tmpdir()],
    ['Application Support itself', (h: string) => join(h, 'Library', 'Application Support')],
    ['a near-miss name', (h: string) => join(h, 'Relay-Demo-x')],
    ['a relative path', () => 'Relay-Demo'],
  ])('refuses RELAY_USER_DATA_DIR = %s', async (_label, pick) => {
    const home = await fakeHome();
    const before = await listing(home);

    const r = await runScript('demo-reset.ts', [], { HOME: home, RELAY_USER_DATA_DIR: pick(home) });

    expect(r.code, r.stdout).toBe(3);
    expect(r.stderr).toContain('demo-reset refused');
    expect(await listing(home)).toEqual(before);
  });

  it('refuses a symlink named Relay-Demo and leaves its target untouched', async () => {
    const home = await fakeHome();
    const parent = await makeTempDir('relay-demo-parent-');
    const elsewhere = join(parent, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'canary.txt'), 'keep me');
    await symlink(elsewhere, join(parent, 'Relay-Demo'));

    const r = await runScript('demo-reset.ts', [], { HOME: home, RELAY_USER_DATA_DIR: join(parent, 'Relay-Demo') });

    expect(r.code).toBe(3);
    expect(r.stderr).toContain('is a symlink');
    expect(await listing(elsewhere)).toEqual(['canary.txt']);
    expect(await readFile(join(elsewhere, 'canary.txt'), 'utf8')).toBe('keep me');
    expect(await listing(parent)).toEqual(['Relay-Demo', 'elsewhere']);
  });

  it('refuses --dir whose parent is not Application Support (only RELAY_USER_DATA_DIR may name another parent)', async () => {
    const home = await fakeHome();
    const parent = await makeTempDir('relay-demo-parent-');
    await mkdir(join(parent, 'Relay-Demo'));
    await writeFile(join(parent, 'Relay-Demo', 'canary.txt'), 'keep me');

    const r = await runScript('demo-reset.ts', ['--dir', join(parent, 'Relay-Demo')], { HOME: home });

    expect(r.code).toBe(3);
    expect(r.stderr).toContain('its parent is not');
    expect(await listing(parent)).toEqual(['Relay-Demo']);
    expect(await listing(join(parent, 'Relay-Demo'))).toEqual(['canary.txt']);
  });

  it('refuses the default path when Application Support has no such parent', async () => {
    const home = await makeTempDir('relay-demo-home-'); // no Library/Application Support at all

    const r = await runScript('demo-reset.ts', [], { HOME: home });

    expect(r.code).toBe(3);
    expect(await listing(home)).toEqual([]);
  });
});

describe('demo-reset failing after the move aside', () => {
  /** A snapshot that passes every pre-flight check (valid snapshot.json) but has no userdata/, so the copy step fails. */
  async function snapshotWithoutUserdata(): Promise<string> {
    const snapshot = await makeTempDir('relay-demo-snap-');
    await writeFile(join(snapshot, 'snapshot.json'), await readFile(join(REPO_ROOT, 'docs', 'demo', 'snapshot', 'snapshot.json'), 'utf8'));
    return snapshot;
  }

  it('says where the previous profile was moved, and deletes nothing', async () => {
    const home = await fakeHome();
    const parent = join(home, 'Library', 'Application Support');
    const target = join(parent, 'Relay-Demo');
    await mkdir(target);
    await writeFile(join(target, 'canary.txt'), 'keep me');
    const snapshot = await snapshotWithoutUserdata();

    const r = await runScript('demo-reset.ts', ['--snapshot', snapshot], { HOME: home, RELAY_USER_DATA_DIR: target });

    expect(r.code, r.stdout).toBe(1);
    const previous = (await listing(parent)).filter((n) => n.startsWith('Relay-Demo.previous-'));
    expect(previous).toHaveLength(1);
    const previousDir = join(parent, previous[0] ?? '');
    expect(r.stderr).toContain(`demo-reset stopped after moving the demo dir aside; the previous demo profile is at ${toDisplayPath(previousDir, home)} (nothing was deleted).`);
    expect(toDisplayPath(previousDir, home)).toMatch(/^~\/Library\/Application Support\/Relay-Demo\.previous-/); // home-relative, never the raw home path
    expect(await readFile(join(previousDir, 'canary.txt'), 'utf8')).toBe('keep me');
    expect(await listing(parent)).toEqual(previous); // the failed copy left no partial Relay-Demo behind
  });

  it('says there was no previous profile when there was no demo dir to move', async () => {
    const home = await fakeHome();
    const target = join(home, 'Library', 'Application Support', 'Relay-Demo');
    const snapshot = await snapshotWithoutUserdata();

    const r = await runScript('demo-reset.ts', ['--snapshot', snapshot], { HOME: home, RELAY_USER_DATA_DIR: target });

    expect(r.code, r.stdout).toBe(1);
    expect(r.stderr).toContain('demo-reset stopped after moving the demo dir aside; there was no previous demo profile (nothing was deleted).');
  });
});

describe('demo-reset + demo-verify', () => {
  it('restores the snapshot twice in a row, keeps one previous dir, carries secrets and credential refs, never deletes a foreign dir', async () => {
    const home = await fakeHome();
    const parent = await makeTempDir('relay-demo-parent-');
    const target = join(parent, 'Relay-Demo');
    const env = { HOME: home, RELAY_USER_DATA_DIR: target };
    // A user's own dir that merely looks like a previous dir: no reset marker, so it must survive pruning.
    const foreign = 'Relay-Demo.previous-20200101-000000-000';
    await mkdir(join(parent, foreign));
    await writeFile(join(parent, foreign, 'mine.txt'), 'user data');

    const first = await runScript('demo-reset.ts', [], env);
    expect(first.code, first.stderr).toBe(0);
    const v1 = await runScript('demo-verify.ts', [], env);
    expect(v1.code, v1.stdout + v1.stderr).toBe(0);
    expect(v1.stdout).toContain('demo:verify OK');
    expect((await lstat(join(target, 'secrets'))).mode & 0o777).toBe(0o700);

    // A saved key (an OS-protected vault file + its credential ref), as the app would write it.
    await writeFile(join(target, VAULT_FILE), 'encrypted-bytes', { mode: 0o600 });
    await withRuntime(target, async (rt) => {
      const res = await rt.engine.handle('relay/v1/providers.recordCredentialRef', { providerId: 'anthropic', storageMode: 'os_protected', vaultFile: VAULT_FILE, redactedLabel: 'sk-…ABCD' });
      expect(res.ok).toBe(true);
    });

    const second = await runScript('demo-reset.ts', [], env);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain('1 credential ref(s) carried over');
    expect(await readFile(join(target, VAULT_FILE), 'utf8')).toBe('encrypted-bytes');
    const refs = await withRuntime(target, async (rt) => rt.engine.handle('relay/v1/providers.listCredentialRefs', {}));
    expect(refs.ok && refs.data.map((x) => x.vaultFile)).toEqual([VAULT_FILE]);
    const v2 = await runScript('demo-verify.ts', [], env);
    expect(v2.code, v2.stdout + v2.stderr).toBe(0);
    expect(v2.stdout).toContain('1 provider key file(s) present');

    const third = await runScript('demo-reset.ts', [], env);
    expect(third.code, third.stderr).toBe(0);
    const previous = (await listing(parent)).filter((n) => n.startsWith('Relay-Demo.previous-'));
    expect(previous).toHaveLength(2); // the newest kept + the foreign one, never deleted
    expect(previous).toContain(foreign);
    expect(await readFile(join(parent, foreign, 'mine.txt'), 'utf8')).toBe('user data');
    expect(await listing(parent)).toEqual(expect.arrayContaining(['Relay-Demo', 'Relay-Demo-samples']));
    expect(await listing(join(parent, 'Relay-Demo-samples'))).toEqual(['sample-api']);
    expect(await listing(join(parent, 'Relay-Demo-samples', 'sample-api'))).not.toContain('.env');
    const v3 = await runScript('demo-verify.ts', [], env);
    expect(v3.code, v3.stdout + v3.stderr).toBe(0);
  }, 180_000);
});
