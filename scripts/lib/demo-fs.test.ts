// 13 §M3 guard: scratch-dir removal resolves the path before the ownership check, so `..` can never escape it.
import { mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupScratchDirs, makeScratchDir, removeScratchDir } from './demo-fs.js';

afterEach(async () => {
  await cleanupScratchDirs();
});

describe('removeScratchDir', () => {
  it('refuses a path that escapes a scratch dir through ..', async () => {
    const dir = await makeScratchDir('relay-demofs-');
    const sibling = await makeScratchDir('relay-demofs-');

    await expect(removeScratchDir(`${dir}/..`)).rejects.toThrow(/refusing/);
    await expect(removeScratchDir(`${dir}/../..`)).rejects.toThrow(/refusing/);
    await expect(removeScratchDir(`${dir}/../${sibling.split('/').at(-1) ?? ''}`)).resolves.toBeUndefined();
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect((await stat(tmpdir())).isDirectory()).toBe(true);
  });

  it('removes a path inside a scratch dir and refuses untracked dirs', async () => {
    const dir = await makeScratchDir('relay-demofs-');
    await mkdir(join(dir, 'a', 'b'), { recursive: true });

    await removeScratchDir(join(dir, 'a'));
    await expect(stat(join(dir, 'a'))).rejects.toThrow();
    await expect(removeScratchDir(tmpdir())).rejects.toThrow(/refusing/);
  });
});
