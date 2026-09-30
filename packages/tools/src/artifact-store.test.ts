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

/** A promise gate that opens once `n` callers have arrived. */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return async () => {
    arrived += 1;
    if (arrived === n) open();
    await gate;
  };
}

/** Runs `fn` on the first call only (hooks fire on every put/purge of the store). */
function once(fn: () => Promise<unknown>): () => Promise<void> {
  let fired = false;
  return async () => {
    if (fired) return;
    fired = true;
    await fn();
  };
}

describe('B9: concurrent puts commit with link (no silent overwrite)', () => {
  it('two concurrent puts with different bytes: exactly one wins, the other fails hash_mismatch', async () => {
    const { store, userDataDir, newId } = await setup({ faults: { beforeLink: barrier(2) } });
    const id = newId();

    const [one, two] = await Promise.all([putText(store, id, 'one'), putText(store, id, 'two')]);

    expect([one.ok, two.ok].filter(Boolean)).toHaveLength(1);
    const loser = one.ok ? two : one;
    expect(loser.ok || [loser.error.code, loser.error.details?.['reason']]).toEqual(['ARTIFACT_WRITE_FAILED', 'hash_mismatch']);
    const winner = one.ok ? 'one' : 'two';
    const read = await store.read(`artifacts/${runId}/${id}`, 100);
    expect(read.ok && new TextDecoder().decode(read.value)).toBe(winner);
    expect(await fs.promises.readdir(path.join(userDataDir, 'artifacts', runId))).toEqual([id]);
  });

  it('two concurrent puts with the same bytes both succeed (idempotent) and leave one 0o444 file', async () => {
    const { store, userDataDir, newId } = await setup({ faults: { beforeLink: barrier(2) } });
    const id = newId();

    const [a, b] = await Promise.all([putText(store, id, 'same'), putText(store, id, 'same')]);

    expect(a.ok && b.ok).toBe(true);
    expect(await fs.promises.readdir(path.join(userDataDir, 'artifacts', runId))).toEqual([id]);
    expect((await fs.promises.stat(path.join(userDataDir, 'artifacts', runId, id))).mode & 0o777).toBe(0o444);
  });
});

describe('B10: purge vs put never resurrects a purged artifact', () => {
  async function expectPurgedAndGone(store: ArtifactStore, userDataDir: string, id: ArtifactId) {
    const relPath = `artifacts/${runId}/${id}`;
    const read = await store.read(relPath, 100);
    expect(read.ok || [read.error.code, read.error.details?.['purged']]).toEqual(['NOT_FOUND', true]);
    expect(await store.exists(relPath)).toBe(false);
    expect(await fs.promises.readdir(path.join(userDataDir, 'artifacts', runId))).toEqual([`${id}.purged`]);
  }

  it('purge completing between put\'s checks and its link: put removes what it linked and fails purged', async () => {
    const ref = {} as { store: ArtifactStore };
    const id = artifactIds()();
    const s = await setup({ faults: { beforeLink: once(() => ref.store.purge(`artifacts/${runId}/${id}`)) } });
    const { store } = s;
    ref.store = store;

    const r = await putText(store, id, 'x');

    expect(r.ok || r.error.details?.['reason']).toBe('purged');
    await expectPurgedAndGone(store, s.userDataDir, id);
  });

  it('purge completing after put\'s link but before its re-check: put fails purged, file gone', async () => {
    const ref = {} as { store: ArtifactStore };
    const id = artifactIds()();
    const s = await setup({ faults: { afterCommit: once(() => ref.store.purge(`artifacts/${runId}/${id}`)) } });
    const { store } = s;
    ref.store = store;

    const r = await putText(store, id, 'x');

    expect(r.ok || r.error.details?.['reason']).toBe('purged');
    await expectPurgedAndGone(store, s.userDataDir, id);
  });

  it('put running between purge\'s tombstone and its unlink fails purged; read already reports purged', async () => {
    const ref = {} as { store: ArtifactStore };
    const id = artifactIds()();
    const relPath = `artifacts/${runId}/${id}`;
    const seen: unknown[] = [];
    const s = await setup({
      faults: {
        afterTombstone: once(async () => {
          const put = await putText(ref.store, id, 'y');
          const read = await ref.store.read(relPath, 100);
          seen.push(put.ok || put.error.details?.['reason'], read.ok || read.error.details?.['purged']);
        }),
      },
    });
    const { store } = s;
    ref.store = store;
    await putText(store, id, 'x');

    const purged = await store.purge(relPath);

    expect(purged.ok).toBe(true);
    expect(seen).toEqual(['purged', true]);
    await expectPurgedAndGone(store, s.userDataDir, id);
  });
});

describe('B11: tombstones are crash-safe', () => {
  it('an empty (crash-truncated) tombstone counts as purged for read/put/purge and is repaired', async () => {
    const { store, userDataDir, clock: c, newId, logs } = await setup();
    const id = newId();
    const relPath = `artifacts/${runId}/${id}`;
    await putText(store, id, 'x');
    const tomb = path.join(userDataDir, 'artifacts', runId, `${id}.purged`);
    await fs.promises.writeFile(tomb, '');

    const read = await store.read(relPath, 100);
    const put = await putText(store, id, 'x');
    c.set(c.now() + 5000);
    const purge = await store.purge(relPath);

    expect(read.ok || [read.error.code, read.error.details?.['purged'], read.error.details?.['purgedAt']]).toEqual([
      'NOT_FOUND',
      true,
      c.now() - 5000,
    ]);
    expect(put.ok || put.error.details?.['reason']).toBe('purged');
    expect(purge.ok && purge.value.purgedAt).toBe(c.now() - 5000);
    expect(JSON.parse(await fs.promises.readFile(tomb, 'utf8'))).toEqual({ purgedAt: c.now() - 5000 });
    expect((await fs.promises.stat(tomb)).mode & 0o777).toBe(0o444);
    expect(logs).toContain('artifact.tombstone.repaired');
    expect(await fs.promises.readdir(path.join(userDataDir, 'artifacts', runId))).toEqual([`${id}.purged`]);
  });

  it('a crash while writing the tombstone never leaves an empty tombstone, and a retry purges', async () => {
    let crash = false;
    const { store, userDataDir, newId } = await setup({
      faults: {
        afterTempWrite: () => {
          if (crash) throw new FaultInjected();
        },
      },
    });
    const id = newId();
    const relPath = `artifacts/${runId}/${id}`;
    await putText(store, id, 'x');
    crash = true;

    await expect(store.purge(relPath)).rejects.toBeInstanceOf(FaultInjected);
    const dir = path.join(userDataDir, 'artifacts', runId);
    expect((await fs.promises.readdir(dir)).filter((f) => f.endsWith('.purged'))).toEqual([]);
    crash = false;
    const retry = await store.purge(relPath);

    expect(retry.ok).toBe(true);
    const read = await store.read(relPath, 100);
    expect(read.ok || read.error.details?.['purged']).toBe(true);
  });
});

describe('B12: committed and idempotent puts are always 0o444', () => {
  it('the file is already 0o444 at link time and an idempotent put restores a drifted mode', async () => {
    const modes: number[] = [];
    let finalPath = '';
    const { store, newId, userDataDir } = await setup({
      faults: {
        afterCommit: async () => {
          modes.push((await fs.promises.stat(finalPath)).mode & 0o777);
        },
      },
    });
    const id = newId();
    finalPath = path.join(userDataDir, 'artifacts', runId, id);
    await putText(store, id, 'x');
    await fs.promises.chmod(finalPath, 0o644);

    const again = await putText(store, id, 'x');

    expect(modes).toEqual([0o444]);
    expect(again.ok).toBe(true);
    expect((await fs.promises.stat(finalPath)).mode & 0o777).toBe(0o444);
  });
});
