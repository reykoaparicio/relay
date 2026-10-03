import { link, lstat, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replaceFileAtomic, suffixedName, writeNewFile } from './safe-write.js';
import type { SafeWriteFs } from './safe-write.js';
import { createShutdownMarker, parseShutdownMarker } from './shutdown-marker.js';
import { makeTempDir, removeTempDir } from './testing/temp-dirs.js';

let dir = '';
beforeEach(async () => {
  dir = await makeTempDir('safew');
});
afterEach(async () => {
  await removeTempDir(dir);
});

describe('writeNewFile (diagnostics export)', () => {
  it('writes a new file with 0600 and leaves no temp file', async () => {
    const dest = join(dir, 'relay-diagnostics.json');

    const written = await writeNewFile(dest, '{"a":1}\n');

    expect(written).toBe(dest);
    expect(await readFile(dest, 'utf8')).toBe('{"a":1}\n');
    expect((await lstat(dest)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['relay-diagnostics.json']);
  });

  it('never overwrites: an existing name gets " (2)", then " (3)"', async () => {
    const dest = join(dir, 'd.json');
    await writeFile(dest, 'original');

    const second = await writeNewFile(dest, 'two');
    const third = await writeNewFile(dest, 'three');

    expect(second).toBe(join(dir, 'd (2).json'));
    expect(third).toBe(join(dir, 'd (3).json'));
    expect(await readFile(dest, 'utf8')).toBe('original');
    expect((await readdir(dir)).sort()).toEqual(['d (2).json', 'd (3).json', 'd.json']);
  });

  it('never follows a symlink planted at the destination (even a dangling one)', async () => {
    const target = join(dir, 'victim.txt');
    await writeFile(target, 'keep me');
    const dest = join(dir, 'd.json');
    await symlink(target, dest);
    const dangling = join(dir, 'e.json');
    await symlink(join(dir, 'nowhere'), dangling);

    const a = await writeNewFile(dest, 'export');
    const b = await writeNewFile(dangling, 'export');

    expect(a).toBe(join(dir, 'd (2).json'));
    expect(b).toBe(join(dir, 'e (2).json'));
    expect(await readFile(target, 'utf8')).toBe('keep me');
    expect((await readdir(dir)).includes('nowhere')).toBe(false);
  });

  it('falls back to an O_EXCL write where hard links are unsupported, and removes the temp file on failure', async () => {
    const ops: string[] = [];
    const files = new Set<string>(['/x/d.json']);
    const fs: SafeWriteFs = {
      writeFile: (p) => {
        ops.push(`write:${p.replace(/\.[0-9a-f]{12}\.tmp$/, '.TMP')}`);
        if (files.has(p)) return Promise.reject(Object.assign(new Error('exists'), { code: 'EEXIST' }));
        files.add(p);
        return Promise.resolve();
      },
      link: () => Promise.reject(Object.assign(new Error('no links'), { code: 'ENOTSUP' })),
      unlink: (p) => {
        ops.push(`unlink:${p.replace(/\.[0-9a-f]{12}\.tmp$/, '.TMP')}`);
        files.delete(p);
        return Promise.resolve();
      },
      rename: () => Promise.resolve(),
    };

    const written = await writeNewFile('/x/d.json', 'data', fs);

    expect(written).toBe('/x/d (2).json');
    expect(ops).toEqual(['write:/x/.d.json.TMP', 'write:/x/d.json', 'write:/x/d (2).json', 'unlink:/x/.d.json.TMP']);
  });

  it('propagates a write failure (ENOSPC) without leaving a temp file', async () => {
    const fs: SafeWriteFs = {
      writeFile: () => Promise.reject(Object.assign(new Error('full'), { code: 'ENOSPC' })),
      link: () => Promise.resolve(),
      unlink: () => Promise.resolve(),
      rename: () => Promise.resolve(),
    };

    await expect(writeNewFile('/x/d.json', 'data', fs)).rejects.toThrow('full');
  });

  /** Real fs whose writes put a few bytes on disk and then fail with ENOSPC (the disk filled up mid-write). */
  const partialWriteFs = (opts: { links: boolean }): SafeWriteFs => ({
    writeFile: async (p, d, o) => {
      await writeFile(p, d.slice(0, 3), o);
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    },
    link: opts.links ? (a, b) => link(a, b) : () => Promise.reject(Object.assign(new Error('no links'), { code: 'ENOTSUP' })),
    unlink: (p) => unlink(p),
    rename: (a, b) => rename(a, b),
  });

  it('round-3 B5: a temp write that fails part-way leaves no partial temp file (writeNewFile and replaceFileAtomic)', async () => {
    await expect(writeNewFile(join(dir, 'relay-diagnostics.json'), 'hello world', partialWriteFs({ links: true }))).rejects.toThrow('ENOSPC');
    await expect(replaceFileAtomic(join(dir, 'last-shutdown.json'), 'hello world', partialWriteFs({ links: true }))).rejects.toThrow('ENOSPC');

    expect(await readdir(dir)).toEqual([]);
  });

  it('round-3 B5: the no-hard-link fallback never leaves a partial file under the final name', async () => {
    let tmpWritten = false;
    const base = partialWriteFs({ links: false });
    const fs: SafeWriteFs = {
      ...base,
      // The temp write succeeds; the O_EXCL write of the final name fails part-way.
      writeFile: async (p, d, o) => {
        if (!tmpWritten) {
          tmpWritten = true;
          await writeFile(p, d, o);
          return;
        }
        await base.writeFile(p, d, o);
      },
    };
    await writeFile(join(dir, 'd.json'), 'original');

    await expect(writeNewFile(join(dir, 'd.json'), 'hello world', fs)).rejects.toThrow('ENOSPC');

    expect(await readdir(dir)).toEqual(['d.json']); // no partial 'd (2).json', no temp file
    expect(await readFile(join(dir, 'd.json'), 'utf8')).toBe('original');
  });

  it('round-3 B5: a temp-name collision (EEXIST) is someone else\'s file and is never removed', async () => {
    const unlinked: string[] = [];
    const fs: SafeWriteFs = {
      writeFile: () => Promise.reject(Object.assign(new Error('exists'), { code: 'EEXIST' })),
      link: () => Promise.resolve(),
      unlink: (p) => {
        unlinked.push(p);
        return Promise.resolve();
      },
      rename: () => Promise.resolve(),
    };

    await expect(writeNewFile('/x/d.json', 'data', fs)).rejects.toThrow('exists');
    expect(unlinked).toEqual([]);
  });

  it('suffixedName keeps the extension', () => {
    expect(suffixedName('a.b.json', 1)).toBe('a.b.json');
    expect(suffixedName('a.b.json', 4)).toBe('a.b (4).json');
    expect(suffixedName('noext', 2)).toBe('noext (2)');
  });

  it('replaceFileAtomic replaces a file and leaves no temp file', async () => {
    const dest = join(dir, 'state.json');
    await writeFile(dest, 'old');

    await replaceFileAtomic(dest, 'new');

    expect(await readFile(dest, 'utf8')).toBe('new');
    expect(await readdir(dir)).toEqual(['state.json']);
  });
});

describe('shutdown marker (clean quit vs crash)', () => {
  it('round-3 B3: writes land in call order even when the launch write is slower than the clean-quit write', async () => {
    const written: string[] = [];
    const marker = createShutdownMarker({
      userDataDir: dir, now: () => 5,
      readText: () => Promise.resolve(null),
      writeText: async (_p, text) => {
        // The launch write ({ clean: false }) is slow (a busy disk at startup), the clean-quit write fast.
        await new Promise((r) => setTimeout(r, text.includes('"clean":false') ? 30 : 0));
        written.push(text);
      },
    });

    const launch = marker.recordLaunch();
    const quit = marker.recordCleanQuit(false);
    await Promise.all([launch, quit]);

    expect(written.map((t) => (JSON.parse(t) as { clean: boolean }).clean)).toEqual([false, true]);
  });

  it('first launch: previous is null; a clean quit is seen by the next launch', async () => {
    let now = 1_000;
    const first = createShutdownMarker({ userDataDir: dir, now: () => now });
    await first.recordLaunch();
    expect(first.previous()).toBeNull();
    now = 2_000;
    await first.recordCleanQuit(true);

    const second = createShutdownMarker({ userDataDir: dir, now: () => now });
    await second.recordLaunch();

    expect(second.previous()).toEqual({ clean: true, at: 2_000, runActive: true });
  });

  it('a session that never quit cleanly (crash) is reported as clean: false with its start time', async () => {
    const crashed = createShutdownMarker({ userDataDir: dir, now: () => 5_000 });
    await crashed.recordLaunch(); // …then the process dies

    const next = createShutdownMarker({ userDataDir: dir, now: () => 9_000 });
    await next.recordLaunch();

    expect(next.previous()).toEqual({ clean: false, at: 5_000, runActive: false });
  });

  it('an unreadable / garbage marker reads as null; a failing write never throws', async () => {
    expect(parseShutdownMarker('{"clean":"yes"}')).toBeNull();
    expect(parseShutdownMarker('not json')).toBeNull();
    const m = createShutdownMarker({ userDataDir: dir, now: () => 1, readText: () => Promise.resolve('{'), writeText: () => Promise.reject(new Error('EROFS')) });

    await expect(m.recordLaunch()).resolves.toBeUndefined();
    await expect(m.recordCleanQuit(false)).resolves.toBeUndefined();
    expect(m.previous()).toBeNull();
  });
});
