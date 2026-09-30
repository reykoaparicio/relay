// Regression tests for Referee-confirmed security bugs B1–B8 (packages/tools). Each test reproduces the exploit.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RelPath } from '@relay/contracts';
import type { ImportedDiff } from './diff-intake.js';
import { checkDiffPaths } from './diff-intake.js';
import type { ProjectRoot } from './paths.js';
import { confinedReadHooks, isSecretRootPath, normalizeRelPath, openProjectRoot } from './paths.js';
import { hashFiles, readSelected } from './read.js';
import { scanProject } from './scan.js';
import { tempDirs, writeTree } from './testing/temp-dirs.js';

const tmp = tempDirs();
afterEach(async () => {
  delete confinedReadHooks.afterResolve;
  delete confinedReadHooks.afterOpen;
  await tmp.cleanup();
});

const SECRET = 'SECRET=hunter2\n';
const PUBLIC = 'public text\n';
const NFD = 'café'; // "café" decomposed
const NFC = 'café'; // "café" composed

async function makeRoot(files: Record<string, string | Uint8Array>): Promise<{ root: ProjectRoot; dir: string }> {
  const dir = await tmp.make();
  await writeTree(dir, files);
  const r = await openProjectRoot(dir, { userDataDir: path.join(dir, '..', 'relay-ud-never') });
  if (!r.ok) throw new Error('root refused');
  return { root: r.value, dir };
}

function rel(p: string): RelPath {
  const r = normalizeRelPath(p);
  if (!r.ok) throw new Error(`bad relPath ${p}`);
  return r.value;
}

function deniedOf(r: Awaited<ReturnType<typeof readSelected>>): unknown {
  return r.ok ? 'ok' : r.error.details?.['denied'];
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Atomically repoints symlink `link` at `target` (symlink to a temp name + rename over). */
async function repoint(link: string, target: string, n: number): Promise<void> {
  const t = `${link}.swap-${String(n)}`;
  await fs.promises.symlink(target, t);
  await fs.promises.rename(t, link);
}

/** Replaces directory `dir` with a symlink to `target`, keeping the original at `dir.orig` (and back). */
async function swapDirToLink(dir: string, target: string): Promise<void> {
  await fs.promises.rename(dir, `${dir}.orig`);
  await fs.promises.symlink(target, dir);
}
async function swapLinkToDir(dir: string): Promise<void> {
  await fs.promises.unlink(dir);
  await fs.promises.rename(`${dir}.orig`, dir);
}

describe('B1: readSelected TOCTOU (symlink swapped between classification and open)', () => {
  it('a symlink swap loop over 1000 reads never returns the secret', async () => {
    const { root, dir } = await makeRoot({ 'ok.txt': PUBLIC, '.env': SECRET });
    const link = path.join(dir, 'link');
    await fs.promises.symlink('ok.txt', link);
    const flag = { stop: false };
    let swaps = 0;
    const swapper = (async () => {
      while (!flag.stop) {
        await repoint(link, '.env', swaps);
        await repoint(link, 'ok.txt', swaps);
        swaps += 1;
      }
    })();
    let secretReads = 0;
    let publicReads = 0;
    try {
      for (let batch = 0; batch < 100; batch += 1) {
        const results = await Promise.all(Array.from({ length: 10 }, () => readSelected(root, ['link'])));
        for (const r of results) {
          if (!r.ok) continue;
          const content = r.value.files[0]?.content ?? '';
          if (content.includes('hunter2')) secretReads += 1;
          else if (content === PUBLIC) publicReads += 1;
        }
      }
    } finally {
      flag.stop = true;
      await swapper;
    }
    expect(secretReads).toBe(0);
    expect(swaps).toBeGreaterThan(0);
    expect(publicReads).toBeGreaterThan(0);
  });

  it('a symlink repointed at a secret right after resolution still reads only the classified file', async () => {
    const { root, dir } = await makeRoot({ 'ok.txt': PUBLIC, '.env': SECRET });
    const link = path.join(dir, 'link');
    await fs.promises.symlink('ok.txt', link);
    confinedReadHooks.afterResolve = () => repoint(link, '.env', 0);

    const r = await readSelected(root, ['link']);

    expect(r.ok && r.value.files[0]?.content).toBe(PUBLIC);
  });

  it('a parent dir swapped for a symlink into a secret dir before open is denied', async () => {
    const { root, dir } = await makeRoot({ 'pub/a.txt': PUBLIC, '.ssh/a.txt': SECRET });
    confinedReadHooks.afterResolve = () => swapDirToLink(path.join(dir, 'pub'), '.ssh');

    const r = await readSelected(root, ['pub/a.txt']);

    expect(deniedOf(r)).toEqual([{ relPath: 'pub/a.txt', reason: 'outside_root' }]);
  });

  it('a swap before open that is swapped back after open is caught by the inode identity check', async () => {
    const { root, dir } = await makeRoot({ 'pub/a.txt': PUBLIC, '.ssh/a.txt': SECRET });
    const pub = path.join(dir, 'pub');
    confinedReadHooks.afterResolve = () => swapDirToLink(pub, '.ssh');
    confinedReadHooks.afterOpen = () => swapLinkToDir(pub);

    const r = await readSelected(root, ['pub/a.txt']);

    expect(deniedOf(r)).toEqual([{ relPath: 'pub/a.txt', reason: 'outside_root' }]);
  });
});

describe('B6: hashFiles classifies the real name through the same pipeline', () => {
  it('a symlink with an innocent name pointing at .env hashes to null', async () => {
    const { root, dir } = await makeRoot({ 'ok.txt': PUBLIC, '.env': SECRET });
    await fs.promises.symlink('.env', path.join(dir, 'notes.txt'));

    const r = await hashFiles(root, ['notes.txt', 'ok.txt']);

    expect(r.ok && r.value).toEqual([
      { relPath: 'notes.txt', sha256: null },
      { relPath: 'ok.txt', sha256: sha(PUBLIC) },
    ]);
  });

  it('a parent-dir swap during the hash read yields null, never the secret hash', async () => {
    const { root, dir } = await makeRoot({ 'pub/a.txt': PUBLIC, '.ssh/a.txt': SECRET });
    confinedReadHooks.afterResolve = () => swapDirToLink(path.join(dir, 'pub'), '.ssh');

    const r = await hashFiles(root, ['pub/a.txt']);

    expect(r.ok && r.value).toEqual([{ relPath: 'pub/a.txt', sha256: null }]);
  });
});

describe('B2: checkDiffPaths classifies where an added file would land', () => {
  const adds = (...paths: string[]): ImportedDiff => ({
    files: paths.map((p) => ({ oldPath: null, newPath: rel(p), hunks: [] })),
    warnings: [],
  });

  it('rejects adds under a symlinked dir pointing outside the root or into a secret dir, and dangling ancestors', async () => {
    const outside = await tmp.make('relay-outside-');
    const { root, dir } = await makeRoot({ 'src/a.ts': 'a', '.ssh/known_hosts': 'x' });
    await fs.promises.symlink(outside, path.join(dir, 'ext'));
    await fs.promises.symlink('.ssh', path.join(dir, 'keys'));
    await fs.promises.symlink(path.join(outside, 'missing'), path.join(dir, 'dangling'));

    const r = await checkDiffPaths(root, adds('ext/new.ts', 'keys/new_key', 'dangling/x/y.ts', 'src/new.ts', 'fresh/deep/x.ts'));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.details?.['denied']).toEqual([
      { relPath: 'ext/new.ts', reason: 'outside_root' },
      { relPath: 'keys/new_key', reason: 'secret' },
      { relPath: 'dangling/x/y.ts', reason: 'outside_root' },
    ]);
    expect(JSON.stringify(r.error)).not.toContain(outside);
  });

  it('accepts plain adds (existing and missing parent dirs)', async () => {
    const { root } = await makeRoot({ 'src/a.ts': 'a' });

    expect((await checkDiffPaths(root, adds('src/new.ts', 'fresh/deep/x.ts'))).ok).toBe(true);
  });
});

describe('B3: NFC/NFD spellings classify identically', () => {
  it('normalizeRelPath emits NFC', () => {
    expect(rel(`${NFD}/x.ts`)).toBe(`${NFC}/x.ts`);
  });

  it('an NFD request cannot dodge an NFC user pattern, and an NFC request finds an NFD file', async () => {
    const { root } = await makeRoot({ [`${NFD}/x.txt`]: PUBLIC });

    const nfdReq = await readSelected(root, [`${NFD}/x.txt`], { exclusions: [`${NFC}/**`] });
    const nfcPattern = await readSelected(root, [`${NFC}/x.txt`], { exclusions: [`${NFD}/**`] });
    const plain = await readSelected(root, [`${NFC}/x.txt`]);

    expect(deniedOf(nfdReq)).toEqual([{ relPath: `${NFC}/x.txt`, reason: 'user_pattern' }]);
    expect(deniedOf(nfcPattern)).toEqual([{ relPath: `${NFC}/x.txt`, reason: 'user_pattern' }]);
    expect(plain.ok && plain.value.files.map((f) => [f.relPath, f.content])).toEqual([[`${NFC}/x.txt`, PUBLIC]]);
  });

  it('gitignore rules in one form match on-disk names and requests in the other', async () => {
    const { root } = await makeRoot({ '.gitignore': `${NFD}.txt\n`, [`${NFC}.txt`]: PUBLIC, 'keep.txt': PUBLIC });

    const read = await readSelected(root, [`${NFC}.txt`]);
    const scan = await scanProject(root);

    expect(deniedOf(read)).toEqual([{ relPath: `${NFC}.txt`, reason: 'gitignored' }]);
    expect(scan.ok && scan.value.excluded.map((e) => [e.relPath, e.reason])).toEqual([[`${NFC}.txt`, 'gitignored']]);
  });

  it('scan classifies NFD on-disk names in NFC and reports NFC relPaths that readSelected accepts', async () => {
    const { root } = await makeRoot({ [`${NFD}/x.txt`]: PUBLIC, [`d/${NFD}.txt`]: PUBLIC });

    const excludedScan = await scanProject(root, { exclusions: [`${NFC}/**`] });
    const scan = await scanProject(root);

    expect(excludedScan.ok && excludedScan.value.excluded.map((e) => [e.relPath, e.reason])).toEqual([
      [NFC, 'user_pattern'],
    ]);
    expect(scan.ok && scan.value.included.map((f) => f.relPath)).toEqual([`${NFC}/x.txt`, `d/${NFC}.txt`]);
    if (!scan.ok) return;
    const read = await readSelected(root, scan.value.included.map((f) => f.relPath));
    expect(read.ok && read.value.files.map((f) => f.content)).toEqual([PUBLIC, PUBLIC]);
  });
});

describe('B4: roots inside credential dirs', () => {
  it.each([['.ssh/proj'], ['.aws/proj'], ['.gnupg/p'], ['Library/Keychains/p'], ['.config/gcloud/p'], ['.kube/p'], ['.docker/p']])(
    'openProjectRoot refuses %s with unsafe_root',
    async (sub) => {
      const base = await tmp.make();
      const dir = path.join(base, ...sub.split('/'));
      await fs.promises.mkdir(dir, { recursive: true });

      const r = await openProjectRoot(dir, { userDataDir: path.join(base, 'ud'), homeDir: path.join(base, 'home') });

      expect(r.ok || r.error.details?.['reason']).toBe('unsafe_root');
    },
  );

  it('isSecretRootPath matches segment runs, not substrings', () => {
    expect(isSecretRootPath('/Users/me/.SSH/p')).toBe(true);
    expect(isSecretRootPath('/Users/me/.config/gcloud')).toBe(true);
    expect(isSecretRootPath('/Users/me/.config/gcloudx/p')).toBe(false);
    expect(isSecretRootPath('/Users/me/code/.sshx/p')).toBe(false);
    expect(isSecretRootPath('/Users/me/gcloud/.config')).toBe(false);
  });

  it('defense in depth: a ProjectRoot under .aws classifies every entry as secret on every entry point', async () => {
    const base = await tmp.make();
    const real = path.join(base, '.aws', 'proj');
    await writeTree(real, { 'a.ts': 'x', 'src/b.ts': 'y' });
    const root: ProjectRoot = { realpath: real, caseInsensitive: true };

    const read = await readSelected(root, ['a.ts']);
    const hashes = await hashFiles(root, ['a.ts']);
    const scan = await scanProject(root);
    const diff = await checkDiffPaths(root, { files: [{ oldPath: rel('a.ts'), newPath: rel('a.ts'), hunks: [] }], warnings: [] });

    expect(deniedOf(read)).toEqual([{ relPath: 'a.ts', reason: 'secret' }]);
    expect(hashes.ok && hashes.value).toEqual([{ relPath: 'a.ts', sha256: null }]);
    expect(scan.ok && scan.value.included).toEqual([]);
    expect(scan.ok && scan.value.excluded.map((e) => e.reason)).toEqual(['secret', 'secret']);
    expect(diff.ok || diff.error.details?.['denied']).toEqual([{ relPath: 'a.ts', reason: 'secret' }]);
  });
});

describe('B5: roots that are or contain system dirs, home, ~/Library, userData', () => {
  const home = os.homedir();
  const candidates = [
    '/',
    '/private',
    '/private/etc',
    '/private/var',
    '/System',
    '/Library',
    '/usr',
    '/bin',
    '/sbin',
    '/etc',
    '/opt',
    '/Volumes',
    '/Users',
    home,
    path.dirname(home),
    path.join(home, 'Library'),
    path.join(home, 'Library', 'Keychains'),
  ].filter((p) => fs.existsSync(p));

  it.each(candidates)('refuses %s', async (dir) => {
    const r = await openProjectRoot(dir, { userDataDir: path.join(os.tmpdir(), 'relay-ud-never') });

    expect(r.ok || r.error.details?.['reason']).toBe('unsafe_root');
  });

  it('with a given home: refuses home, its ancestors, ~/Library and inside it; accepts ~/code/x and tmpdir subdirs', async () => {
    const base = await tmp.make();
    const fakeHome = path.join(base, 'home');
    const dirs = ['Library/Keychains/x', 'Library/Application Support', 'code/x'];
    for (const d of dirs) await fs.promises.mkdir(path.join(fakeHome, ...d.split('/')), { recursive: true });
    const opts = { userDataDir: path.join(fakeHome, 'Library', 'Application Support', 'Relay'), homeDir: fakeHome };
    const open = (p: string) => openProjectRoot(p, opts).then((r) => (r.ok ? 'ok' : r.error.details?.['reason']));

    expect(await open(fakeHome)).toBe('unsafe_root');
    expect(await open(base)).toBe('unsafe_root');
    expect(await open(path.join(fakeHome, 'Library'))).toBe('unsafe_root');
    expect(await open(path.join(fakeHome, 'Library', 'Keychains', 'x'))).toBe('unsafe_root');
    expect(await open(path.join(fakeHome, 'Library', 'Application Support'))).toBe('unsafe_root');
    expect(await open(path.join(fakeHome, 'code', 'x'))).toBe('ok');
    expect(await open(path.join(fakeHome, 'code'))).toBe('ok');
  });
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe.skipIf(isRoot)('B7: scanProject never throws on unreadable entries', () => {
  it('lists an unreadable dir and file in `unreadable` (neither included nor excluded)', async () => {
    const { root, dir } = await makeRoot({ 'ok.txt': PUBLIC, 'locked/inner.txt': PUBLIC, 'nope.txt': PUBLIC });
    await fs.promises.chmod(path.join(dir, 'locked'), 0o000);
    await fs.promises.chmod(path.join(dir, 'nope.txt'), 0o000);
    try {
      const r = await scanProject(root);

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.included.map((f) => f.relPath)).toEqual(['ok.txt']);
      expect(r.value.excluded).toEqual([]);
      expect(r.value.unreadable).toEqual(['locked', 'nope.txt']);
      expect(JSON.stringify(r.value)).not.toContain(dir);
    } finally {
      await fs.promises.chmod(path.join(dir, 'locked'), 0o755);
      await fs.promises.chmod(path.join(dir, 'nope.txt'), 0o644);
    }
  });

  it('an unreadable root is a Result error without absolute paths', async () => {
    const { root, dir } = await makeRoot({ 'ok.txt': PUBLIC });
    await fs.promises.chmod(dir, 0o000);
    try {
      const r = await scanProject(root);

      expect(r.ok || r.error.code).toBe('PERMISSION_DENIED');
      expect(JSON.stringify(r)).not.toContain(dir);
    } finally {
      await fs.promises.chmod(dir, 0o755);
    }
  });

  it('a vanished root is NOT_FOUND', async () => {
    const { root, dir } = await makeRoot({ 'ok.txt': PUBLIC });
    await fs.promises.rm(dir, { recursive: true });

    const r = await scanProject(root);

    expect(r.ok || r.error.code).toBe('NOT_FOUND');
  });
});

describe('B8: scan preview agrees with readSelected on invalid UTF-8', () => {
  it('classifies invalid UTF-8 (in the sniff window or past it) as binary, like readSelected', async () => {
    const late = new Uint8Array(9000).fill(0x61);
    late[8999] = 0xff;
    const { root } = await makeRoot({
      'latin1.txt': new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]),
      'late.txt': late,
      'good.txt': `${NFC}\n`,
    });

    const scan = await scanProject(root);
    const read = await readSelected(root, ['latin1.txt', 'late.txt']);

    expect(scan.ok && scan.value.included.map((f) => f.relPath)).toEqual(['good.txt']);
    expect(scan.ok && scan.value.excluded.map((e) => [e.relPath, e.reason])).toEqual([
      ['late.txt', 'binary'],
      ['latin1.txt', 'binary'],
    ]);
    expect(deniedOf(read)).toEqual([
      { relPath: 'latin1.txt', reason: 'binary' },
      { relPath: 'late.txt', reason: 'binary' },
    ]);
  });
});
