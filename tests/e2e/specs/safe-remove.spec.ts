// Node-only check of the guarded cleanup (no Electron): safeRemove must refuse anything it did not create.
import { test, expect } from '@playwright/test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { makeTempDir, safeRemove } from '../safe-remove.js';

test.describe('safeRemove guard', { tag: ['@m1', '@safety'] }, () => {
  test('refuses tmpdir, its parent, home, root, and untracked relay-e2e dirs', async () => {
    const root = realpathSync(tmpdir());
    for (const p of [
      tmpdir(),
      root,
      path.dirname(root),
      homedir(),
      '/',
      '',
      '.',
      '..',
      path.join(root, '..'),
    ]) {
      await expect(safeRemove(p), JSON.stringify(p)).rejects.toThrow(/safeRemove/);
    }
    // A plausible-looking but untracked sibling is refused too.
    await expect(safeRemove(path.join(root, 'relay-e2e-not-mine'))).rejects.toThrow(
      /not created by this test process/,
    );

    const d = await makeTempDir('guard-');
    // Nested paths and the tracked dir's parent are refused; the dir itself and its -samples sibling are allowed.
    const nested = path.join(d, 'inner');
    await mkdir(nested);
    await expect(safeRemove(nested)).rejects.toThrow(/not a direct child/);
    await expect(safeRemove(path.join(d, '..'))).rejects.toThrow(/safeRemove/);
    await mkdir(`${d}-samples`);
    await writeFile(path.join(`${d}-samples`, 'x.txt'), 'x');
    await safeRemove(`${d}-samples`);
    await expect(stat(`${d}-samples`)).rejects.toThrow();
    await safeRemove(d);
    await expect(stat(d)).rejects.toThrow();
    // Once removed it is no longer tracked.
    await expect(safeRemove(d)).rejects.toThrow(/not created by this test process/);
    // tmpdir itself still exists.
    expect((await stat(root)).isDirectory()).toBe(true);
  });
});
