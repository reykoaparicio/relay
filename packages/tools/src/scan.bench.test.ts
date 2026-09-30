import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openProjectRoot } from './paths.js';
import { scanProject } from './scan.js';
import { tempDirs } from './testing/temp-dirs.js';

const FIXTURE = fileURLToPath(new URL('../../../tests/fixtures/sample-api', import.meta.url));
const tmp = tempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

describe('scan benchmark', () => {
  it.runIf(fs.existsSync(FIXTURE))('@perf scans a copy of tests/fixtures/sample-api in < 300 ms', async () => {
    // Copy (read-only use of the fixture) so the test never touches tests/fixtures; the fixture .env may be absent.
    const dir = await tmp.make('relay-bench-');
    await fs.promises.cp(FIXTURE, path.join(dir, 'sample-api'), { recursive: true, verbatimSymlinks: true });
    const opened = await openProjectRoot(path.join(dir, 'sample-api'), { userDataDir: path.join(dir, 'ud') });
    if (!opened.ok) throw new Error('fixture root refused');

    const t0 = performance.now();
    const r = await scanProject(opened.value);
    const ms = performance.now() - t0;

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.included.length).toBeGreaterThan(0);
      expect(r.value.included.some((f) => f.relPath === '.env')).toBe(false);
      expect(r.value.excluded.some((e) => e.relPath === 'node_modules' && e.reason === 'dependency_dir')).toBe(true);
    }
    expect(ms).toBeLessThan(300);
  });
});
