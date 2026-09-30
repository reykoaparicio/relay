import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSampleService } from './samples.js';

describe('samples (H10)', () => {
  let dir = '';
  let src = '';
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'relay-samples-')));
    src = join(dir, 'fixture');
    await mkdir(join(src, 'node_modules', 'dep'), { recursive: true });
    await mkdir(join(src, 'dist'), { recursive: true });
    await mkdir(join(src, 'src'), { recursive: true });
    await writeFile(join(src, '.env'), 'SECRET=sk-fixture-DO-NOT-READ\n');
    await writeFile(join(src, 'src', '.env'), 'X=1\n');
    await writeFile(join(src, 'src', 'index.ts'), 'export {};\n');
    await writeFile(join(src, 'node_modules', 'dep', 'index.js'), '');
    await writeFile(join(src, 'dist', 'out.js'), '');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('copies everything except .env files, leaves the fixture untouched, and builds an isDemo-ready input', async () => {
    const svc = createSampleService({ sourceDir: src, samplesDir: join(dir, 'samples'), homeDir: '/nowhere' });

    const r = await svc.copySample('key-0000000001');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dst = r.value.realpath;
    expect(dst).toBe(join(dir, 'samples', 'sample-api-1'));
    expect((await readdir(dst)).sort()).toEqual(['dist', 'node_modules', 'src']);
    expect(await readdir(join(dst, 'src'))).toEqual(['index.ts']);
    expect((await stat(join(dst, 'node_modules', 'dep', 'index.js'))).isFile()).toBe(true);
    expect((await stat(join(src, '.env'))).isFile()).toBe(true);
    expect(r.value.createInput).toMatchObject({ rootRealpath: dst, name: 'Sample API', exclusions: [] });
  });

  it('reuses the copy for a retried idempotency key and numbers new copies', async () => {
    const svc = createSampleService({ sourceDir: src, samplesDir: join(dir, 'samples'), homeDir: '/nowhere' });

    const a = await svc.copySample('key-0000000001');
    const again = await svc.copySample('key-0000000001');
    const b = await svc.copySample('key-0000000002');

    expect(again).toEqual(a);
    expect(b.ok && b.value.realpath).toBe(join(dir, 'samples', 'sample-api-2'));
  });
});
