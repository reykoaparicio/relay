// fs failures keep their cause (impr item 12): an unreadable path is not reported as a bare "not found". Only the errno
// code reaches `details.errno`; absolute paths never do. Fixtures use chmod 000 inside guarded temp dirs.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RelPath, RunId } from '@relay/contracts';
import { createIdGen } from '@relay/contracts';
import { createArtifactStore } from './artifact-store.js';
import { normalizeRelPath, openProjectRoot, readConfined } from './paths.js';
import { readSelected } from './read.js';
import { scanProject } from './scan.js';
import { artifactIds, fakeClock, tempDirs, writeTree } from './testing/temp-dirs.js';

const tmp = tempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function rel(p: string): RelPath {
  const r = normalizeRelPath(p);
  if (!r.ok) throw new Error(`bad relPath ${p}`);
  return r.value;
}

async function openRoot(dir: string) {
  return openProjectRoot(dir, { userDataDir: path.join(dir, '..', 'relay-ud-never') });
}

/** Runs `fn` with `target` at mode 000, restoring 0o755 afterwards so cleanup can remove it. */
async function withLocked<T>(target: string, fn: () => Promise<T>): Promise<T> {
  await fs.promises.chmod(target, 0o000);
  try {
    return await fn();
  } finally {
    await fs.promises.chmod(target, 0o755);
  }
}

describe('openProjectRoot fs errors', () => {
  it('E2 #7: a missing root is PROJECT_ROOT_MISSING with details.errno ENOENT (not a generic NOT_FOUND)', async () => {
    const dir = await tmp.make();

    const r = await openRoot(path.join(dir, 'missing'));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('PROJECT_ROOT_MISSING');
    expect(r.error.details).toMatchObject({ errno: 'ENOENT' });
  });

  it.skipIf(isRoot)('a root behind an unreadable parent is PERMISSION_DENIED unsafe_root, like scanProject', async () => {
    const dir = await tmp.make();
    await writeTree(dir, { 'parent/project/a.txt': 'x' });

    const r = await withLocked(path.join(dir, 'parent'), () => openRoot(path.join(dir, 'parent', 'project')));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('PERMISSION_DENIED');
    expect(r.error.details).toEqual({ reason: 'unsafe_root', errno: 'EACCES' });
    expect(JSON.stringify(r.error)).not.toContain(dir);
  });
});

describe.skipIf(isRoot)('project file fs errors', () => {
  it('E2 #8: readConfined on an unreadable file is PERMISSION_DENIED unreadable naming the relPath, errno EACCES, no absolute path', async () => {
    const dir = await tmp.make();
    await writeTree(dir, { 'locked.txt': 'secret-ish', 'ok.txt': 'fine' });
    const root = await openRoot(dir);
    if (!root.ok) throw new Error('root refused');

    const r = await withLocked(path.join(dir, 'locked.txt'), () => readConfined(root.value, rel('locked.txt'), 1024));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('PERMISSION_DENIED');
    expect(r.error.details).toMatchObject({ reason: 'unreadable', relPath: 'locked.txt', errno: 'EACCES' });
    expect(r.error.userMessage).toContain('locked.txt');
    expect(JSON.stringify(r.error)).not.toContain(dir);
  });

  it('E2 #8: one unreadable selected file → PERMISSION_DENIED unreadable naming it (so the UI can offer "Exclude this file")', async () => {
    const dir = await tmp.make();
    await writeTree(dir, { 'locked.txt': 'x', 'ok.txt': 'y' });
    const root = await openRoot(dir);
    if (!root.ok) throw new Error('root refused');

    const r = await withLocked(path.join(dir, 'locked.txt'), () => readSelected(root.value, ['ok.txt', 'locked.txt']));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('PERMISSION_DENIED');
    expect(r.error.details).toEqual({ reason: 'unreadable', relPath: 'locked.txt', denied: [{ relPath: 'locked.txt', reason: 'unreadable' }] });
    expect(r.error.userMessage).toContain('locked.txt');
  });

  it('an unreadable scan root carries details.errno', async () => {
    const dir = await tmp.make();
    await writeTree(dir, { 'a.txt': 'x' });
    const root = await openRoot(dir);
    if (!root.ok) throw new Error('root refused');

    const r = await withLocked(dir, () => scanProject(root.value));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.details).toEqual({ reason: 'unsafe_root', errno: 'EACCES' });
  });
});

describe('ArtifactStore.read never throws', () => {
  async function setup() {
    const userDataDir = await tmp.make('relay-ud-');
    const clock = fakeClock();
    const runId: RunId = createIdGen(clock, (n) => new Uint8Array(n)).next('run');
    const store = createArtifactStore({ userDataDir, clock });
    const id = artifactIds(clock)();
    const relPath = `artifacts/${runId}/${id}`;
    return { store, userDataDir, relPath, abs: path.join(userDataDir, ...relPath.split('/')) };
  }

  it.skipIf(isRoot)('an unreadable artifact is NOT_FOUND with details.errno EACCES', async () => {
    const { store, userDataDir, relPath, abs } = await setup();
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, 'report');

    const r = await withLocked(abs, () => store.read(relPath, 1024));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
    expect(r.error.details).toMatchObject({ entity: 'artifact', errno: 'EACCES' });
    expect(JSON.stringify(r.error)).not.toContain(userDataDir);
  });

  it('a failure after open (the artifact path is a directory) is a Result, not a throw', async () => {
    const { store, relPath, abs } = await setup();
    await fs.promises.mkdir(abs, { recursive: true });

    const r = await store.read(relPath, 1024 * 1024);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
    expect(r.error.details).toMatchObject({ entity: 'artifact', errno: 'EISDIR' });
  });
});
