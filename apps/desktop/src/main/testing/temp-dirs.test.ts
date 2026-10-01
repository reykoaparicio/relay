import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEMP_PREFIX, makeTempDir, removeTempDir } from './temp-dirs.js';

describe('guarded temp dirs', () => {
  it('removes a dir it created (with contents) and refuses a second removal', async () => {
    const dir = await makeTempDir('self');
    await mkdir(join(dir, 'a', 'b'), { recursive: true });

    await removeTempDir(dir);

    await expect(stat(dir)).rejects.toThrow();
    await expect(removeTempDir(dir)).rejects.toThrow(/refusing/);
  });

  it('refuses the temp root, its parent, home, /, a child of an owned dir, and an unowned look-alike', async () => {
    const root = await realpath(tmpdir());
    const owned = await makeTempDir('guard');
    const lookAlike = join(root, `${TEMP_PREFIX}not-mine`);

    for (const p of [root, dirname(root), homedir(), '/', join(owned, 'child'), lookAlike]) {
      await expect(removeTempDir(p)).rejects.toThrow(/refusing/);
    }
    expect((await stat(owned)).isDirectory()).toBe(true);
    await removeTempDir(owned);
  });
});
