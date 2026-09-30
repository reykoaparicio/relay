import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactId, RunId } from '@relay/contracts';
import { createIdGen } from '@relay/contracts';
import type { ArtifactStore } from './artifact-store.js';
import { FaultInjected, ORPHAN_MIN_AGE_MS, createArtifactStore } from './artifact-store.js';
import { artifactIds, fakeClock, tempDirs } from './testing/temp-dirs.js';

const tmp = tempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

const clock = fakeClock();
const runId: RunId = createIdGen(clock, (n) => new Uint8Array(n)).next('run');
const bytes = (s: string) => new TextEncoder().encode(s);

async function setup(extra: Partial<Parameters<typeof createArtifactStore>[0]> = {}) {
  const userDataDir = await tmp.make('relay-ud-');
  const c = fakeClock();
  const logs: string[] = [];
  const store = createArtifactStore({ userDataDir, clock: c, log: (e) => logs.push(e), ...extra });
  return { store, userDataDir, clock: c, logs, newId: artifactIds() };
}

async function putText(store: ArtifactStore, id: ArtifactId, text: string) {
  return store.put({ scopeDir: `artifacts/${runId}`, artifactId: id, bytes: bytes(text), mediaType: 'text/plain' });
}

describe('ArtifactStore.put', () => {
  it('writes a read-only file and is idempotent for the same bytes', async () => {
    const { store, userDataDir, newId } = await setup();
    const id = newId();

    const first = await putText(store, id, 'report');
    const second = await putText(store, id, 'report');

    expect(first).toEqual(second);
    expect(first.ok && first.value.relPath).toBe(`artifacts/${runId}/${id}`);
    expect(first.ok && first.value.sizeBytes).toBe(6);
    const st = await fs.promises.stat(path.join(userDataDir, 'artifacts', runId, id));
    expect(st.mode & 0o777).toBe(0o444);
    const read = await store.read(`artifacts/${runId}/${id}`, 100);
    expect(read.ok && new TextDecoder().decode(read.value)).toBe('report');
    expect(await store.exists(`artifacts/${runId}/${id}`)).toBe(true);
  });

  it('fails with ARTIFACT_WRITE_FAILED when different bytes target the same path', async () => {
    const { store, newId, logs } = await setup();
    const id = newId();
    await putText(store, id, 'one');

    const r = await putText(store, id, 'two');

    expect(r.ok || [r.error.code, r.error.details?.['reason']]).toEqual(['ARTIFACT_WRITE_FAILED', 'hash_mismatch']);
    expect(logs).toContain('artifact.put.hash_mismatch');
  });

  it('refuses scope dirs and ids that do not match the store layout', async () => {
    const { store, newId } = await setup();

    const badScope = await store.put({ scopeDir: 'artifacts/../../etc', artifactId: newId(), bytes: bytes('x'), mediaType: 'x' });
    const badId = await store.put({ scopeDir: `artifacts/${runId}`, artifactId: 'art_../x' as ArtifactId, bytes: bytes('x'), mediaType: 'x' });

    expect(badScope.ok || badScope.error.code).toBe('VALIDATION_FAILED');
    expect(badId.ok || badId.error.code).toBe('VALIDATION_FAILED');
    expect(await store.exists('artifacts/../x')).toBe(false);
    const read = await store.read('../../etc/passwd', 10);
    expect(read.ok || read.error.code).toBe('VALIDATION_FAILED');
  });

  it('crash simulation: a throw between write and rename leaves only a .tmp that sweepOrphans removes', async () => {
    const { store, userDataDir, clock: c, newId } = await setup({
      faults: {
        afterTempWrite: () => {
          throw new FaultInjected();
        },
      },
    });
    const id = newId();

    await expect(putText(store, id, 'partial')).rejects.toBeInstanceOf(FaultInjected);
    const dir = path.join(userDataDir, 'artifacts', runId);
    const left = await fs.promises.readdir(dir);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(new RegExp(`^${id}\\.tmp-[0-9a-f]+$`));

    const early = await store.sweepOrphans(new Set());
    c.set(Date.now() + ORPHAN_MIN_AGE_MS + 1000);
    const late = await store.sweepOrphans(new Set());

    expect(early.removed).toBe(0);
    expect(late.removed).toBe(1);
    expect(await fs.promises.readdir(dir)).toEqual([]);
  });

  it('returns ARTIFACT_WRITE_FAILED when the store directory cannot be created', async () => {
    const { userDataDir, newId, clock: c } = await setup();
    await fs.promises.writeFile(path.join(userDataDir, 'artifacts'), 'not a dir');
    const store = createArtifactStore({ userDataDir, clock: c });

    const r = await putText(store, newId(), 'x');

    expect(r.ok || r.error.code).toBe('ARTIFACT_WRITE_FAILED');
  });
});

describe('ArtifactStore.read', () => {
  it('returns plain NOT_FOUND for a missing file without a tombstone, and refuses oversize reads', async () => {
    const { store, newId } = await setup();
    const id = newId();
    await putText(store, id, 'abcdef');

    const missing = await store.read(`artifacts/${runId}/${newId()}`, 10);
    const oversize = await store.read(`artifacts/${runId}/${id}`, 3);

    expect(missing.ok || [missing.error.code, missing.error.details?.['purged']]).toEqual(['NOT_FOUND', false]);
    expect(oversize.ok || oversize.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('ArtifactStore.purge', () => {
  it('removes a 0o444 file, writes a tombstone, and is idempotent', async () => {
    const { store, userDataDir, clock: c, newId } = await setup();
    const id = newId();
    const relPath = `artifacts/${runId}/${id}`;
    await putText(store, id, 'to purge');
    const t0 = c.now();

    const first = await store.purge(relPath);
    c.set(c.now() + 5000);
    const second = await store.purge(relPath);

    expect(first.ok && first.value.purgedAt).toBe(t0);
    expect(second).toEqual(first);
    expect(await store.exists(relPath)).toBe(false);
    const tomb = path.join(userDataDir, 'artifacts', runId, `${id}.purged`);
    expect(JSON.parse(await fs.promises.readFile(tomb, 'utf8'))).toEqual({ purgedAt: t0 });
    expect((await fs.promises.stat(tomb)).mode & 0o777).toBe(0o444);
  });

  it('read after purge → NOT_FOUND with details.purged === true and purgedAt', async () => {
    const { store, newId } = await setup();
    const id = newId();
    const relPath = `artifacts/${runId}/${id}`;
    await putText(store, id, 'x');
    const purged = await store.purge(relPath);

    const r = await store.read(relPath, 100);

    expect(r.ok).toBe(false);
    if (r.ok || !purged.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
    expect(r.error.details?.['purged']).toBe(true);
    expect(r.error.details?.['purgedAt']).toBe(purged.value.purgedAt);
  });

  it('does not re-create a purged artifact', async () => {
    const { store, newId } = await setup();
    const id = newId();
    await putText(store, id, 'x');
    await store.purge(`artifacts/${runId}/${id}`);

    const r = await putText(store, id, 'x');

    expect(r.ok || r.error.details?.['reason']).toBe('purged');
  });

  it('treats a missing file as not an error and rejects invalid paths', async () => {
    const { store, newId } = await setup();

    const missing = await store.purge(`artifacts/${runId}/${newId()}`);
    const invalid = await store.purge('artifacts/nope/x');

    expect(missing.ok).toBe(true);
    expect(invalid.ok || invalid.error.code).toBe('VALIDATION_FAILED');
  });

  it('fails with ARTIFACT_WRITE_FAILED when the tombstone cannot be written', async () => {
    const { store, userDataDir, newId, logs } = await setup();
    const id = newId();
    const tomb = path.join(userDataDir, 'artifacts', runId, `${id}.purged`);
    await fs.promises.mkdir(tomb, { recursive: true }); // a directory where the tombstone should go (EEXIST, unreadable)

    const r = await store.purge(`artifacts/${runId}/${id}`);

    expect(r.ok || r.error.code).toBe('ARTIFACT_WRITE_FAILED');
    expect(logs).toContain('artifact.purge.failed');
  });
});

describe('ArtifactStore.sweepOrphans', () => {
  it('keeps known files and tombstones, removes old row-less files', async () => {
    const { store, userDataDir, clock: c, newId } = await setup();
    const known = newId();
    const orphan = newId();
    const purged = newId();
    await putText(store, known, 'k');
    await putText(store, orphan, 'o');
    await putText(store, purged, 'p');
    await store.purge(`artifacts/${runId}/${purged}`);
    c.set(Date.now() + 2 * ORPHAN_MIN_AGE_MS);

    const r = await store.sweepOrphans(new Set([`artifacts/${runId}/${known}`]));

    expect(r.removed).toBe(1);
    expect((await fs.promises.readdir(path.join(userDataDir, 'artifacts', runId))).sort()).toEqual(
      [known, `${purged}.purged`].sort(),
    );
  });

  it('is a no-op when the artifacts dir does not exist', async () => {
    const { store } = await setup();

    expect(await store.sweepOrphans(new Set())).toEqual({ removed: 0 });
  });
});
