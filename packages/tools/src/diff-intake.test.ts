import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDiffPaths, parseImportedDiff } from './diff-intake.js';
import type { ImportedDiff } from './diff-intake.js';
import type { ProjectRoot } from './paths.js';
import { openProjectRoot } from './paths.js';
import { tempDirs, writeTree } from './testing/temp-dirs.js';

const tmp = tempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

const MULTI = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1 @@',
  '+added',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  '',
].join('\n');

function parsed(text: string): ImportedDiff {
  const r = parseImportedDiff(text);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

async function makeRoot(files: Record<string, string>): Promise<{ root: ProjectRoot; dir: string }> {
  const dir = await tmp.make();
  await writeTree(dir, files);
  const r = await openProjectRoot(dir, { userDataDir: path.join(dir, '..', 'relay-ud-none') });
  if (!r.ok) throw new Error('root');
  return { root: r.value, dir };
}

describe('parseImportedDiff', () => {
  it('parses a valid multi-file git diff, stripping a/ b/ prefixes and mapping /dev/null to null', () => {
    const d = parsed(MULTI);

    expect(d.files.map((f) => [f.oldPath, f.newPath, f.hunks.length])).toEqual([
      ['src/a.ts', 'src/a.ts', 1],
      [null, 'src/new.ts', 1],
      ['src/gone.ts', null, 1],
    ]);
    expect(d.warnings).toEqual([]);
  });

  it('keeps plain (non-git) paths and warns about entries without hunks', () => {
    const d = parsed(['--- src/a.ts\t2020', '+++ src/a.ts\t2021', '@@ -1 +1 @@', '-x', '+y', 'diff --git a/logo.png b/logo.png', 'Binary files differ', ''].join('\n'));

    expect(d.files.map((f) => f.newPath)).toEqual(['src/a.ts', 'logo.png']);
    expect(d.warnings).toEqual(['logo.png: no hunks (binary or mode-only change)']);
  });

  it.each([
    ['a path with ..', '--- a/../etc/passwd\n+++ b/../etc/passwd\n@@ -1 +1 @@\n-x\n+y\n'],
    ['an absolute path', '--- /etc/passwd\n+++ /etc/passwd\n@@ -1 +1 @@\n-x\n+y\n'],
    ['a .git path', '--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n-x\n+y\n'],
    ['text with no file changes', 'just some text\n'],
    ['a malformed hunk', '--- a/x\n+++ b/x\n@@ -1,5 +1 @@\n-x\n'],
    ['both sides /dev/null', '--- /dev/null\n+++ /dev/null\n@@ -0,0 +1 @@\n+x\n'],
    ['a hunk without headers', '@@ -1 +1 @@\n-x\n+y\n'],
  ])('rejects %s with VALIDATION_FAILED', (_label, text) => {
    const r = parseImportedDiff(text);

    expect(r.ok || r.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an oversize diff', () => {
    const r = parseImportedDiff(`${MULTI}${'+'.repeat(100)}`, 64);

    expect(r.ok || r.error.details?.['issues']).toEqual([{ path: 'diff', message: 'The diff file is too large.', code: 'too_large' }]);
  });
});

describe('checkDiffPaths', () => {
  it('accepts a diff over existing and new files', async () => {
    const { root } = await makeRoot({ 'src/a.ts': 'keep\nold\n', 'src/gone.ts': 'bye\n' });

    expect(await checkDiffPaths(root, parsed(MULTI))).toEqual({ ok: true, value: undefined });
  });

  it('rejects a diff touching .env with PERMISSION_DENIED', async () => {
    const { root } = await makeRoot({ '.env': 'K=v\n' });

    const r = await checkDiffPaths(root, parsed('--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-K=v\n+K=w\n'));

    expect(r.ok || [r.error.code, r.error.details?.['denied']]).toEqual(['PERMISSION_DENIED', [{ relPath: '.env', reason: 'secret' }]]);
  });

  it('rejects paths that escape through a symlink, secrets behind symlinks, gitignored and user-excluded files', async () => {
    const { root, dir } = await makeRoot({ '.env': 'K=v\n', '.gitignore': 'ignored.ts\n', 'ignored.ts': 'i\n', 'gen/x.ts': 'x\n' });
    const outside = await tmp.make('relay-outside-');
    await writeTree(outside, { 'o.ts': 'o\n' });
    await fs.promises.symlink(path.join(outside, 'o.ts'), path.join(dir, 'o.ts'));
    await fs.promises.symlink(path.join(dir, '.env'), path.join(dir, 'config.ts'));
    const patch = (p: string) => `--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-x\n+y\n`;
    const diff = parsed(['o.ts', 'config.ts', 'ignored.ts', 'gen/x.ts'].map(patch).join(''));

    const r = await checkDiffPaths(root, diff, { exclusions: ['gen/**'] });
    const outsideOnly = await checkDiffPaths(root, parsed(patch('o.ts')));

    expect(r.ok || r.error.details?.['denied']).toEqual([
      { relPath: 'o.ts', reason: 'outside_root' },
      { relPath: 'config.ts', reason: 'secret' },
      { relPath: 'ignored.ts', reason: 'gitignored' },
      { relPath: 'gen/x.ts', reason: 'user_pattern' },
    ]);
    expect(outsideOnly.ok || outsideOnly.error.details?.['reason']).toBe('outside_root');
  });

  it('can skip .gitignore', async () => {
    const { root } = await makeRoot({ '.gitignore': 'ignored.ts\n', 'ignored.ts': 'i\n' });

    const r = await checkDiffPaths(root, parsed('--- a/ignored.ts\n+++ b/ignored.ts\n@@ -1 +1 @@\n-i\n+j\n'), { respectGitignore: false });

    expect(r.ok).toBe(true);
  });
});
