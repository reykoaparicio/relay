import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactId, RelPath, RunId } from '@relay/contracts';
import { createIdGen } from '@relay/contracts';
import { INPUT_FILE_MEDIA_TYPE, createArtifactStore } from './artifact-store.js';
import { openProjectRoot } from './paths.js';
import { readSelected } from './read.js';
import { artifactIds, fakeClock, tempDirs, writeTree } from './testing/temp-dirs.js';

const tmp = tempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

const runId: RunId = createIdGen(fakeClock(), (n) => new Uint8Array(n)).next('run');
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

async function setup() {
  const userDataDir = await tmp.make('relay-ud-');
  const project = await tmp.make('relay-prj-');
  const store = createArtifactStore({ userDataDir, clock: fakeClock() });
  const ids = artifactIds();
  const issued: ArtifactId[] = [];
  const newId = () => {
    const id = ids();
    issued.push(id);
    return id;
  };
  return { store, userDataDir, project, newId, issued };
}

describe('snapshotInputFiles / readSnapshot', () => {
  it('stores identical content once and returns the same ref for both relPaths', async () => {
    const { store, newId, issued } = await setup();
    const same = new TextEncoder().encode('same content\n');
    const other = new TextEncoder().encode('other\n');
    const files = [
      { relPath: 'a.ts' as RelPath, bytes: same, sha256: sha(same) },
      { relPath: 'copy/a.ts' as RelPath, bytes: same, sha256: sha(same) },
      { relPath: 'b.ts' as RelPath, bytes: other, sha256: sha(other) },
    ];

    const r = await store.snapshotInputFiles(runId, files, newId);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(issued).toHaveLength(2); // one put per unique sha
    const [a, copy, b] = r.value;
    expect(a?.artifactId).toBe(copy?.artifactId);
    expect(a?.storeRelPath).toBe(copy?.storeRelPath);
    expect(b?.artifactId).not.toBe(a?.artifactId);
    expect(a).toMatchObject({ relPath: 'a.ts', sizeBytes: same.byteLength, mediaType: INPUT_FILE_MEDIA_TYPE, sha256: sha(same) });
    expect(copy?.relPath).toBe('copy/a.ts');
  });

  it('readSnapshot returns the snapshot after the live file is modified or deleted', async () => {
    const { store, project, newId } = await setup();
    await writeTree(project, { 'src/a.ts': 'original\n', 'src/b.ts': 'b original\n' });
    const root = await openProjectRoot(project, { userDataDir: path.join(project, '..', 'relay-ud-none') });
    if (!root.ok) throw new Error('root');
    const read = await readSelected(root.value, ['src/a.ts', 'src/b.ts']);
    if (!read.ok) throw new Error('read');
    const snaps = await store.snapshotInputFiles(runId, read.value.files, newId);
    if (!snaps.ok) throw new Error('snapshot');

    await fs.promises.writeFile(path.join(project, 'src', 'a.ts'), 'MODIFIED\n');
    await fs.promises.rm(path.join(project, 'src', 'b.ts'));
    const [a, b] = await Promise.all(snaps.value.map((s) => store.readSnapshot(s)));

    expect(a).toEqual({ ok: true, value: { content: 'original\n', sha256: sha('original\n') } });
    expect(b).toEqual({ ok: true, value: { content: 'b original\n', sha256: sha('b original\n') } });
  });

  it('a tampered snapshot file (sha mismatch) → INTERNAL', async () => {
    const { store, userDataDir, newId } = await setup();
    const bytes = new TextEncoder().encode('trusted\n');
    const snaps = await store.snapshotInputFiles(runId, [{ relPath: 'a.ts' as RelPath, bytes, sha256: sha(bytes) }], newId);
    if (!snaps.ok) throw new Error('snapshot');
    const ref = snaps.value[0];
    if (ref === undefined) throw new Error('ref');
    const file = path.join(userDataDir, ...ref.storeRelPath.split('/'));
    await fs.promises.chmod(file, 0o644);
    await fs.promises.writeFile(file, 'tampered\n');

    const r = await store.readSnapshot(ref);

    expect(r.ok || [r.error.code, r.error.details?.['reason']]).toEqual(['INTERNAL', 'snapshot_hash_mismatch']);
  });

  it('a snapshot that is not valid UTF-8 → INTERNAL', async () => {
    const { store, newId } = await setup();
    const bytes = new Uint8Array([0xff, 0xfe, 0x00]);
    const snaps = await store.snapshotInputFiles(runId, [{ relPath: 'x.bin' as RelPath, bytes, sha256: sha(bytes) }], newId);
    if (!snaps.ok || snaps.value[0] === undefined) throw new Error('snapshot');

    const r = await store.readSnapshot(snaps.value[0]);

    expect(r.ok || r.error.details?.['reason']).toBe('snapshot_not_utf8');
  });

  it('a purged snapshot → NOT_FOUND purged', async () => {
    const { store, newId } = await setup();
    const bytes = new TextEncoder().encode('x');
    const snaps = await store.snapshotInputFiles(runId, [{ relPath: 'a.ts' as RelPath, bytes, sha256: sha(bytes) }], newId);
    if (!snaps.ok || snaps.value[0] === undefined) throw new Error('snapshot');
    await store.purge(snaps.value[0].storeRelPath);

    const r = await store.readSnapshot(snaps.value[0]);

    expect(r.ok || [r.error.code, r.error.details?.['purged']]).toEqual(['NOT_FOUND', true]);
  });

  it('refuses input whose declared sha256 does not match its bytes', async () => {
    const { store, newId } = await setup();
    const bytes = new TextEncoder().encode('x');

    const r = await store.snapshotInputFiles(runId, [{ relPath: 'a.ts' as RelPath, bytes, sha256: sha('y') }], newId);

    expect(r.ok || r.error.code).toBe('INTERNAL');
  });

  it('propagates a put failure', async () => {
    const { store, newId } = await setup();
    const bytes = new TextEncoder().encode('x');

    const r = await store.snapshotInputFiles('run_bad' as RunId, [{ relPath: 'a.ts' as RelPath, bytes, sha256: sha(bytes) }], newId);

    expect(r.ok || r.error.code).toBe('VALIDATION_FAILED');
  });
});
