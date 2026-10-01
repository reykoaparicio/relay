import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectRoot } from './paths.js';
import { openProjectRoot } from './paths.js';
import { hashFiles, readSelected } from './read.js';
import { tempDirs, writeTree } from './testing/temp-dirs.js';

const tmp = tempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

async function makeRoot(files: Record<string, string | Uint8Array>): Promise<{ root: ProjectRoot; dir: string }> {
  const dir = await tmp.make();
  await writeTree(dir, files);
  const r = await openProjectRoot(dir, { userDataDir: path.join(dir, '..', 'relay-ud-never') });
  if (!r.ok) throw new Error('root refused');
  return { root: r.value, dir };
}

describe('readSelected', () => {
  it('returns content, bytes, size, and a sha256 equal to crypto over the returned bytes', async () => {
    const { root } = await makeRoot({ 'src/a.ts': 'export const a = "é";\n', 'README.md': '# hi\n' });

    const r = await readSelected(root, ['src/a.ts', './README.md', 'src/a.ts']);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.files.map((f) => f.relPath)).toEqual(['src/a.ts', 'README.md']);
    for (const f of r.value.files) {
      expect(f.sha256).toBe(createHash('sha256').update(f.bytes).digest('hex'));
      expect(new TextDecoder().decode(f.bytes)).toBe(f.content);
      expect(f.size).toBe(f.bytes.byteLength);
    }
  });

  it('one denied file fails the whole read and lists every offending path', async () => {
    const { root } = await makeRoot({ 'src/a.ts': 'a', '.env': 'K=v', 'node_modules/x.js': 'x' });

    const r = await readSelected(root, ['src/a.ts', '.env', 'node_modules/x.js', '.git/config']);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('PERMISSION_DENIED');
    expect(r.error.details?.['reason']).toBe('excluded');
    expect(r.error.details?.['denied']).toEqual([
      { relPath: '.env', reason: 'secret' },
      { relPath: 'node_modules/x.js', reason: 'dependency_dir' },
      { relPath: '.git/config', reason: 'vcs_internal' },
    ]);
  });

  it('treats invalid UTF-8 as binary', async () => {
    const { root } = await makeRoot({ 'latin1.txt': new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]) });

    const r = await readSelected(root, ['latin1.txt']);

    expect(r.ok || r.error.details?.['denied']).toEqual([{ relPath: 'latin1.txt', reason: 'binary' }]);
  });

  it('refuses a secret reached through an innocent-looking in-root symlink', async () => {
    const { root, dir } = await makeRoot({ '.env': 'K=v' });
    await fs.promises.symlink(path.join(dir, '.env'), path.join(dir, 'notes.txt'));

    const r = await readSelected(root, ['notes.txt']);

    expect(r.ok || r.error.details?.['denied']).toEqual([{ relPath: 'notes.txt', reason: 'secret' }]);
  });

  it('reports outside_root for a symlink escape', async () => {
    const { root, dir } = await makeRoot({});
    const outside = await tmp.make('relay-outside-');
    await writeTree(outside, { 'o.txt': 'o' });
    await fs.promises.symlink(path.join(outside, 'o.txt'), path.join(dir, 'o.txt'));

    const r = await readSelected(root, ['o.txt']);

    expect(r.ok || [r.error.details?.['reason'], r.error.details?.['denied']]).toEqual([
      'outside_root',
      [{ relPath: 'o.txt', reason: 'outside_root' }],
    ]);
  });

  it('refuses too-large files, directories, caps, gitignored, and user-pattern files', async () => {
    const { root } = await makeRoot({
      'big.ts': 'x'.repeat(30),
      'a.ts': 'aaaa',
      'b.ts': 'bbbb',
      'dir/c.ts': 'c',
      '.gitignore': 'ignored.ts\n',
      'ignored.ts': 'i',
      'gen/x.ts': 'x',
    });

    const r = await readSelected(root, ['a.ts', 'big.ts', 'dir', 'b.ts', 'ignored.ts', 'gen/x.ts'], {
      caps: { maxFileBytes: 20, maxTotalBytes: 100, maxFiles: 1 },
      exclusions: ['gen/**'],
    });

    expect(r.ok || r.error.details?.['denied']).toEqual([
      { relPath: 'big.ts', reason: 'too_large' },
      { relPath: 'dir', reason: 'not_regular_file' },
      { relPath: 'b.ts', reason: 'cap_exceeded' },
      { relPath: 'ignored.ts', reason: 'gitignored' },
      { relPath: 'gen/x.ts', reason: 'user_pattern' },
    ]);
  });

  it('checks every ancestor prefix of a requested path (it never sets ancestorsVetted)', async () => {
    // `vendor-x` and `logs/` match only the DIRECTORY, so only the prefix walk can deny the files below them.
    const { root } = await makeRoot({ '.gitignore': 'logs/\n', 'logs/app.txt': 'l', 'vendor-x/lib.ts': 'v', 'ok.ts': 'o' });

    const r = await readSelected(root, ['logs/app.txt', 'vendor-x/lib.ts', 'ok.ts'], { exclusions: ['vendor-x'] });

    expect(r.ok || r.error.details?.['denied']).toEqual([
      { relPath: 'logs/app.txt', reason: 'gitignored' },
      { relPath: 'vendor-x/lib.ts', reason: 'user_pattern' },
    ]);
  });

  it('reads gitignored files when respectGitignore is off', async () => {
    const { root } = await makeRoot({ '.gitignore': 'ignored.ts\n', 'ignored.ts': 'i' });

    const r = await readSelected(root, ['ignored.ts'], { respectGitignore: false });

    expect(r.ok).toBe(true);
  });

  it('returns VALIDATION_FAILED for a bad path and NOT_FOUND for a missing file', async () => {
    const { root } = await makeRoot({ 'a.ts': 'a' });

    const bad = await readSelected(root, ['a.ts', '../etc/passwd']);
    const missing = await readSelected(root, ['a.ts', 'missing.ts']);

    expect(bad.ok || bad.error.code).toBe('VALIDATION_FAILED');
    expect(missing.ok || missing.error.code).toBe('NOT_FOUND');
  });
});

describe('hashFiles', () => {
  it('hashes live files and returns null for missing, secret, and escaping paths', async () => {
    const { root, dir } = await makeRoot({ 'a.ts': 'a', '.env': 'K=v' });
    const outside = await tmp.make('relay-outside-');
    await writeTree(outside, { 'o.txt': 'o' });
    await fs.promises.symlink(path.join(outside, 'o.txt'), path.join(dir, 'o.txt'));

    const r = await hashFiles(root, ['a.ts', 'gone.ts', '.env', 'o.txt']);

    expect(r).toEqual({
      ok: true,
      value: [
        { relPath: 'a.ts', sha256: createHash('sha256').update('a').digest('hex') },
        { relPath: 'gone.ts', sha256: null },
        { relPath: '.env', sha256: null },
        { relPath: 'o.txt', sha256: null },
      ],
    });
  });

  it('rejects an invalid path', async () => {
    const { root } = await makeRoot({});

    const r = await hashFiles(root, ['/abs']);

    expect(r.ok || r.error.code).toBe('VALIDATION_FAILED');
  });
});
