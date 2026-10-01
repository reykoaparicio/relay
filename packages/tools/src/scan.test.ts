import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRoot } from './paths.js';
import { openProjectRoot } from './paths.js';
import type { ScanResult } from './scan.js';
import { scanProject } from './scan.js';
import { tempDirs, writeTree } from './testing/temp-dirs.js';

const tmp = tempDirs();
afterEach(async () => {
  vi.restoreAllMocks();
  await tmp.cleanup();
});

async function makeRoot(files: Record<string, string | Uint8Array>): Promise<{ root: ProjectRoot; dir: string }> {
  const dir = await tmp.make();
  await writeTree(dir, files);
  const r = await openProjectRoot(dir, { userDataDir: path.join(await tmp.make('relay-ud-'), 'ud') });
  if (!r.ok) throw new Error('root refused');
  return { root: r.value, dir };
}

async function scan(root: ProjectRoot, opts: Parameters<typeof scanProject>[1] = {}): Promise<ScanResult> {
  const r = await scanProject(root, opts);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

const FIXTURE_LIKE = {
  'package.json': '{"name":"sample"}\n', // 18
  'README.md': '# Sample\n', // 9
  '.gitignore': 'coverage/\n*.log\n', // 16
  '.env': 'API_KEY=sk-fixture-DO-NOT-READ\n',
  '.env.example': 'API_KEY=\n', // 9
  'src/index.ts': 'export {};\n', // 11
  'src/routes/users.ts': 'export const u = 1;\n', // 20
  'node_modules/lib/index.js': 'module.exports = 1;\n',
  'dist/index.js': 'x',
  'coverage/lcov.info': 'x',
  'debug.log': 'x',
  'assets/logo.png': new Uint8Array([137, 80, 78, 71, 0, 1]),
  'data/blob.dat': new Uint8Array([0, 1, 2, 3]),
  '.DS_Store': 'x',
};

describe('scanProject', () => {
  it('lists a fixture-like tree with exact counts, reasons, and totals', async () => {
    const { root } = await makeRoot(FIXTURE_LIKE);

    const r = await scan(root);

    expect(r.included.map((f) => [f.relPath, f.size])).toEqual([
      ['.env.example', 9],
      ['.gitignore', 16],
      ['README.md', 9],
      ['package.json', 18],
      ['src/index.ts', 11],
      ['src/routes/users.ts', 20],
    ]);
    expect(r.excluded.map((e) => [e.relPath, e.reason])).toEqual([
      ['.DS_Store', 'os_file'],
      ['.env', 'secret'],
      ['assets/logo.png', 'binary'],
      ['coverage', 'build_output'],
      ['data/blob.dat', 'binary'],
      ['debug.log', 'gitignored'],
      ['dist', 'build_output'],
      ['node_modules', 'dependency_dir'],
    ]);
    expect(r.totals).toEqual({ includedFiles: 6, includedBytes: 83, excludedEntries: 8 });
    expect(r.included.every((f) => f.sha256 === undefined)).toBe(true);
  });

  it('never opens node_modules (excluded directories are pruned)', async () => {
    const { root } = await makeRoot({ 'src/a.ts': 'a', 'node_modules/x/y/z.js': 'z', 'node_modules/w.js': 'w' });
    const spy = vi.spyOn(fs.promises, 'opendir');

    await scan(root);

    const opened = spy.mock.calls.map(([p]) => String(p));
    expect(opened.length).toBe(2);
    expect(opened.some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('does not follow directory symlinks, and flags file symlinks that escape the root', async () => {
    const { root, dir } = await makeRoot({ 'src/a.ts': 'a' });
    const outside = await tmp.make('relay-outside-');
    await writeTree(outside, { 'secret.txt': 's', 'deep/x.ts': 'x' });
    await fs.promises.symlink(outside, path.join(dir, 'linked-dir'));
    await fs.promises.symlink(path.join(dir, 'src'), path.join(dir, 'src-alias'));
    await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'escape.txt'));
    await fs.promises.symlink(path.join(dir, 'src', 'a.ts'), path.join(dir, 'alias.ts'));
    await fs.promises.symlink(path.join(dir, 'missing'), path.join(dir, 'dangling'));

    const r = await scan(root);

    expect(r.included.map((f) => f.relPath)).toEqual(['alias.ts', 'src/a.ts']);
    expect(r.excluded).toEqual([
      { relPath: 'escape.txt', reason: 'symlink_outside', isDirectory: false },
      { relPath: 'linked-dir', reason: 'symlink_outside', isDirectory: false },
    ]);
  });

  it('flags an in-root symlink whose target is a secret', async () => {
    const { root, dir } = await makeRoot({ '.env': 'K=v' });
    await fs.promises.symlink(path.join(dir, '.env'), path.join(dir, 'config.txt'));

    const r = await scan(root);

    expect(r.excluded.map((e) => [e.relPath, e.reason])).toEqual([
      ['.env', 'secret'],
      ['config.txt', 'secret'],
    ]);
  });

  it('lists cap_exceeded rows instead of dropping files', async () => {
    const { root } = await makeRoot({ 'a.ts': 'aaaa', 'b.ts': 'bbbb', 'c.ts': 'cccc', 'd/e.ts': 'eeee', 'big.ts': 'x'.repeat(50) });

    const r = await scan(root, { caps: { maxFileBytes: 20, maxTotalBytes: 100, maxFiles: 2 } });

    expect(r.included.map((f) => f.relPath)).toEqual(['a.ts', 'b.ts']);
    expect(r.excluded.map((e) => [e.relPath, e.reason])).toEqual([
      ['big.ts', 'too_large'],
      ['c.ts', 'cap_exceeded'],
      ['d/e.ts', 'cap_exceeded'],
    ]);
  });

  it('applies project exclusions and can ignore .gitignore', async () => {
    const { root } = await makeRoot({ '.gitignore': '*.log\n', 'a.log': 'x', 'gen/x.ts': 'x', 'src/b.ts': 'b', 'src/.gitignore': 'b.ts\n' });

    const withGit = await scan(root, { exclusions: ['gen'] });
    const withoutGit = await scan(root, { respectGitignore: false });

    expect(withGit.excluded.map((e) => [e.relPath, e.reason])).toEqual([
      ['a.log', 'gitignored'],
      ['gen', 'user_pattern'],
      ['src/b.ts', 'gitignored'],
    ]);
    expect(withoutGit.excluded).toEqual([]);
  });

  it('throws the abort reason when the signal is aborted', async () => {
    const { root } = await makeRoot({ 'a.ts': 'a' });
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));

    await expect(scanProject(root, { signal: ac.signal })).rejects.toThrow('cancelled');
  });

  it('skips names that cannot be a RelPath and non-regular entries', async () => {
    const { root, dir } = await makeRoot({ 'a.ts': 'a', 'back\\slash.ts': 'b' });
    const fifo = path.join(dir, 'pipe');
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [fifo]);

    const r = await scan(root);

    expect(r.included.map((f) => f.relPath)).toEqual(['a.ts']);
    expect(r.excluded).toEqual([]);
  });

  it('scans a 5,000-file synthetic tree with node_modules pruned in under 2 s', async () => {
    const files: Record<string, string> = {};
    for (let d = 0; d < 50; d += 1) for (let f = 0; f < 100; f += 1) files[`src/d${String(d)}/f${String(f)}.ts`] = 'export {};\n';
    for (let i = 0; i < 500; i += 1) files[`node_modules/p${String(i)}/index.js`] = 'x';
    const { root } = await makeRoot(files);

    const t0 = performance.now();
    const r = await scan(root, { caps: { maxFileBytes: 65536, maxTotalBytes: 10 ** 9, maxFiles: 10_000 } });
    const ms = performance.now() - t0;

    expect(r.totals.includedFiles).toBe(5000);
    expect(ms).toBeLessThan(2000);
  }, 60_000);
});

describe('scanProject: lazy UTF-8, gitignore loading, fan-out (impr items 11, 20)', () => {
  it('validates UTF-8 past the 8 KiB sniff window for admitted files only', async () => {
    const valid = 'a'.repeat(9000);
    const invalidTail = Buffer.concat([Buffer.from('b'.repeat(9000)), Buffer.from([0xc3, 0x28])]);
    const bigInvalid = Buffer.concat([Buffer.from('c'.repeat(12_000)), Buffer.from([0xc3, 0x28])]);
    const { root } = await makeRoot({ 'a-valid.ts': valid, 'b-invalid-tail.ts': invalidTail, 'c-over-cap.ts': bigInvalid });
    const open = vi.spyOn(fs.promises, 'open');

    const r = await scan(root, { caps: { maxFileBytes: 64 * 1024, maxTotalBytes: 18_500, maxFiles: 200 } });

    expect(r.included.map((f) => f.relPath)).toEqual(['a-valid.ts']);
    expect(r.excluded).toEqual([
      { relPath: 'b-invalid-tail.ts', reason: 'binary', isDirectory: false },
      // Not admitted by the total cap (the binary file freed none): never fully read, reported as cap_exceeded.
      { relPath: 'c-over-cap.ts', reason: 'cap_exceeded', isDirectory: false },
    ]);
    const opens = (name: string) => open.mock.calls.filter(([p]) => String(p).endsWith(name)).length;
    expect([opens('a-valid.ts'), opens('b-invalid-tail.ts'), opens('c-over-cap.ts')]).toEqual([2, 2, 1]); // probe (+ UTF-8 read)
  });

  it('applies nested .gitignore files (re-include with !) and skips directories without one', async () => {
    const { root } = await makeRoot({
      '.gitignore': '*.log\n',
      'a.log': 'x',
      'sub/.gitignore': '!keep.log\n',
      'sub/keep.log': 'k',
      'sub/drop.log': 'd',
      'other/x.log': 'x',
      'other/y.ts': 'y',
    });

    const r = await scan(root);

    expect(r.included.map((f) => f.relPath)).toEqual(['.gitignore', 'other/y.ts', 'sub/.gitignore', 'sub/keep.log']);
    expect(r.excluded.filter((e) => e.reason === 'gitignored').map((e) => e.relPath)).toEqual(['a.log', 'other/x.log', 'sub/drop.log']);
  });

  it('opens at most 64 entries of one directory at a time and still lists all of them', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i += 1) files[`f${String(i).padStart(3, '0')}.ts`] = 'x';
    const { root } = await makeRoot(files);
    const open = fs.promises.open.bind(fs.promises);
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await open(...args);
      } finally {
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
      }
    });

    const r = await scan(root, { caps: { maxFileBytes: 1024, maxTotalBytes: 1024 * 1024, maxFiles: 1000 } });

    expect(r.included).toHaveLength(300);
    expect(peak).toBeLessThanOrEqual(64);
  });
});
