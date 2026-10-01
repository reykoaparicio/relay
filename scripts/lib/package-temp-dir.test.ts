import { mkdir, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, removeDir, TEMP_PREFIX } from './package-temp-dir.js';

describe('package-temp-dir', () => {
  it('creates a prefixed direct child of the system temp dir and removes it', async () => {
    const dir = await makeTempDir('t-');
    await mkdir(path.join(dir, 'nested', 'deep'), { recursive: true });

    expect(path.basename(dir).startsWith(`${TEMP_PREFIX}t-`)).toBe(true);
    await removeDir(dir);

    expect(await stat(dir).catch(() => null)).toBeNull();
  });

  it('refuses protected and untracked paths', async () => {
    const dir = await makeTempDir('t-');

    for (const p of ['/', tmpdir(), path.dirname(tmpdir()), homedir(), path.join(dir, 'nested'), `${dir}-other`, 'relative/x']) {
      await expect(removeDir(p)).rejects.toThrow(/removeDir/);
    }
    await removeDir(dir);
    await expect(removeDir(dir)).rejects.toThrow(/not created by this process/);
  });

  it('rejects suffixes that could escape the temp dir', async () => {
    await expect(makeTempDir('../x')).rejects.toThrow(/bad suffix/);
  });
});
