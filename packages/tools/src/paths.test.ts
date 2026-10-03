import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { relPathSchema } from '@relay/contracts';
import type { ProjectRoot } from './paths.js';
import { detectCaseInsensitive, normalizeRelPath, openProjectRoot, readConfined, relationOf, relPathBrand, resolveInside } from './paths.js';
import { tempDirs, writeTree } from './testing/temp-dirs.js';

const tmp = tempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

function rel(p: string) {
  const r = normalizeRelPath(p);
  if (!r.ok) throw new Error(`test path rejected: ${p}`);
  return r.value;
}

async function makeRoot(files: Record<string, string> = {}): Promise<{ root: ProjectRoot; dir: string }> {
  const dir = await tmp.make();
  const userData = await tmp.make('relay-ud-');
  await writeTree(dir, files);
  const opened = await openProjectRoot(dir, { userDataDir: userData });
  if (!opened.ok) throw new Error('root refused');
  return { root: opened.value, dir };
}

describe('normalizeRelPath', () => {
  it.each(['../x', 'a/../../x', 'a/../b', '/etc/passwd', 'C:\\x', 'c:/x', '\\\\server\\share', 'a\0b', 'x'.repeat(513), '', '.', './', '.git/config', 'src/.GIT/x'])(
    'rejects %j with VALIDATION_FAILED',
    (input) => {
      const r = normalizeRelPath(input);

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
    },
  );

  it.each([
    ['src/./a.ts', 'src/a.ts'],
    ['./src/a.ts', 'src/a.ts'],
    ['src\\a.ts', 'src/a.ts'],
    ['src//a.ts', 'src/a.ts'],
    ['src/', 'src'],
    ['README.md', 'README.md'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeRelPath(input)).toEqual({ ok: true, value: expected });
  });

  it('allows .git segments only when asked', () => {
    expect(normalizeRelPath('.git/config', { allowGitSegment: true }).ok).toBe(true);
  });

  it('exposes the contracts schema as relPathBrand (no second definition)', () => {
    expect(relPathBrand).toBe(relPathSchema);
  });

  it('never returns a string that the contracts relPathSchema rejects (property)', () => {
    const segment = fc.oneof(fc.constantFrom('..', '.', '', 'a', 'B', '.git', '.env', '\\', 'C:', '\0'), fc.string({ maxLength: 12 }));
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 8 }), fc.constantFrom('/', '\\'), (segs, sep) => {
        const r = normalizeRelPath(segs.join(sep));
        if (r.ok) expect(relPathSchema.safeParse(r.value).success).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe('relationOf', () => {
  it('uses path.relative, not string prefixes', () => {
    expect(relationOf('/a/b', '/a/b', false)).toBe('equal');
    expect(relationOf('/a/b', '/a/b/c', false)).toBe('inside');
    expect(relationOf('/a/b', '/a/bc', false)).toBe('outside');
    expect(relationOf('/a/b', '/a', false)).toBe('outside');
    expect(relationOf('/a/b', '/A/B/c', false)).toBe('outside');
    expect(relationOf('/a/b', '/A/B/c', true)).toBe('inside');
  });
});

describe('openProjectRoot', () => {
  it('accepts a subdirectory of os.tmpdir()', async () => {
    const dir = await tmp.make();
    const userData = await tmp.make('relay-ud-');

    const r = await openProjectRoot(dir, { userDataDir: userData });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.realpath).toBe(dir);
  });

  it('resolves a root that is itself a symlink to its real path', async () => {
    const dir = await tmp.make();
    const links = await tmp.make('relay-links-');
    const link = path.join(links, 'project-link');
    await fs.promises.symlink(dir, link);

    const r = await openProjectRoot(link, { userDataDir: path.join(links, 'ud') });

    expect(r).toEqual({ ok: true, value: { realpath: dir, caseInsensitive: expect.any(Boolean) as boolean } });
  });

  it.each([
    ['/', () => '/'],
    ['the home dir', () => os.homedir()],
    ['/usr', () => '/usr'],
    ['/etc', () => '/etc'],
  ])('refuses %s as unsafe_root', async (_label, pick) => {
    const userData = await tmp.make('relay-ud-');

    const r = await openProjectRoot(pick(), { userDataDir: userData });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('PERMISSION_DENIED');
      expect(r.error.details?.['reason']).toBe('unsafe_root');
    }
  });

  it('refuses the userData dir, an ancestor of it, and a folder inside it', async () => {
    const parent = await tmp.make();
    const userData = path.join(parent, 'userData');
    await fs.promises.mkdir(path.join(userData, 'artifacts'), { recursive: true });

    const results = await Promise.all(
      [userData, parent, path.join(userData, 'artifacts')].map((p) => openProjectRoot(p, { userDataDir: userData })),
    );

    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.details?.['reason']).toBe('unsafe_root');
    }
  });

  it('rejects a relative path, a file, and a missing folder', async () => {
    const dir = await tmp.make();
    await writeTree(dir, { 'f.txt': 'x' });
    const ud = { userDataDir: path.join(dir, 'ud') };

    const [relative, file, missing] = await Promise.all([
      openProjectRoot('relative/dir', ud),
      openProjectRoot(path.join(dir, 'f.txt'), ud),
      openProjectRoot(path.join(dir, 'nope'), ud),
    ]);

    expect(relative.ok || relative.error.code).toBe('VALIDATION_FAILED');
    expect(file.ok || file.error.code).toBe('VALIDATION_FAILED');
    expect(missing.ok || missing.error.code).toBe('PROJECT_ROOT_MISSING');
  });
});

describe('resolveInside', () => {
  it('symlink escape: a link to a file outside the root is PERMISSION_DENIED outside_root', async () => {
    const { root, dir } = await makeRoot({ 'src/a.ts': 'a' });
    const outside = await tmp.make('relay-outside-');
    await writeTree(outside, { 'secret.txt': 'TOP SECRET' });
    await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'link'));

    const resolved = await resolveInside(root, rel('link'));
    const read = await readConfined(root, rel('link'), 1024);

    for (const r of [resolved, read]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('PERMISSION_DENIED');
        expect(r.error.details?.['reason']).toBe('outside_root');
        expect(JSON.stringify(r.error)).not.toContain(outside);
        expect(JSON.stringify(r.error)).not.toContain(dir);
      }
    }
  });

  it('symlink escape through a symlinked directory is refused too', async () => {
    const { root, dir } = await makeRoot();
    const outside = await tmp.make('relay-outside-');
    await writeTree(outside, { 'x.ts': 'x' });
    await fs.promises.symlink(outside, path.join(dir, 'linkdir'));

    const r = await resolveInside(root, rel('linkdir/x.ts'));

    expect(r.ok || r.error.details?.['reason']).toBe('outside_root');
  });

  it('allows a symlink whose target is inside the root', async () => {
    const { root, dir } = await makeRoot({ 'src/a.ts': 'a' });
    await fs.promises.symlink(path.join(dir, 'src', 'a.ts'), path.join(dir, 'alias.ts'));

    const r = await resolveInside(root, rel('alias.ts'));

    expect(r).toEqual({ ok: true, value: { abs: path.join(dir, 'alias.ts'), real: path.join(dir, 'src', 'a.ts') } });
  });

  it('returns NOT_FOUND for a missing file and refuses the root itself', async () => {
    const { root } = await makeRoot();

    const missing = await resolveInside(root, rel('nope.ts'));

    expect(missing.ok || missing.error.code).toBe('NOT_FOUND');
  });

  it('refuses a symlink loop as outside_root', async () => {
    const { root, dir } = await makeRoot();
    await fs.promises.symlink(path.join(dir, 'loop'), path.join(dir, 'loop'));

    const r = await resolveInside(root, rel('loop'));

    expect(r.ok || r.error.details?.['reason']).toBe('outside_root');
  });

  it('resolves SRC/A.ts inside a case-insensitive root', async () => {
    const { root, dir } = await makeRoot({ 'src/a.ts': 'a' });
    const insensitive = await detectCaseInsensitive(dir);
    if (!insensitive) return; // case-sensitive volume: nothing to check

    const r = await resolveInside(root, rel('SRC/A.ts'));

    expect(root.caseInsensitive).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('treats a case-folded root path as the same root when case-insensitive', async () => {
    const { root, dir } = await makeRoot({ 'src/a.ts': 'a' });
    const folded: ProjectRoot = { realpath: dir.toUpperCase(), caseInsensitive: true };
    if (!root.caseInsensitive) return;

    const r = await resolveInside(folded, rel('src/a.ts'));

    expect(r.ok).toBe(true);
  });

  it('never resolves outside the root for random segment arrays including .. (property)', async () => {
    const { root, dir } = await makeRoot({ 'a/b/c.txt': 'c', 'a/d.txt': 'd', 'top.txt': 't' });
    const outside = await tmp.make('relay-outside-');
    await writeTree(outside, { 'o.txt': 'o', 'sub/p.txt': 'p' });
    await fs.promises.symlink(outside, path.join(dir, 'a', 'out'));
    await fs.promises.symlink(path.join(outside, 'o.txt'), path.join(dir, 'o-link'));
    const segment = fc.constantFrom('..', '.', 'a', 'b', 'c.txt', 'd.txt', 'top.txt', 'out', 'o.txt', 'sub', 'p.txt', 'o-link');

    await fc.assert(
      fc.asyncProperty(fc.array(segment, { minLength: 1, maxLength: 6 }), async (segs) => {
        const n = normalizeRelPath(segs.join('/'));
        if (!n.ok) return;
        const r = await resolveInside(root, n.value);
        if (r.ok) expect(relationOf(root.realpath, r.value.real, root.caseInsensitive)).toBe('inside');
      }),
      { numRuns: 300 },
    );
  });
});

describe('readConfined', () => {
  it('reads a regular file and refuses oversize files and directories', async () => {
    const { root } = await makeRoot({ 'a.txt': 'hello', 'big.txt': 'x'.repeat(100), 'dir/x.txt': 'x' });

    const small = await readConfined(root, rel('a.txt'), 10);
    const big = await readConfined(root, rel('big.txt'), 10);
    const dir = await readConfined(root, rel('dir'), 10);
    const missing = await readConfined(root, rel('nope'), 10);

    expect(small.ok && Buffer.from(small.value.bytes).toString()).toBe('hello');
    expect(big.ok || big.error.details?.['exclusion']).toBe('too_large');
    expect(dir.ok || dir.error.details?.['exclusion']).toBe('not_regular_file');
    expect(missing.ok || missing.error.code).toBe('NOT_FOUND');
  });

  it('reads an empty file', async () => {
    const { root } = await makeRoot({ 'empty.txt': '' });

    const r = await readConfined(root, rel('empty.txt'), 10);

    expect(r.ok && r.value.size).toBe(0);
  });
});

describe('detectCaseInsensitive', () => {
  it('returns false for a missing path', async () => {
    const dir = await tmp.make();

    expect(await detectCaseInsensitive(path.join(dir, 'missing-dir'))).toBe(false);
  });

  it('probes the whole path when the last segment has no letters', async () => {
    const dir = await tmp.make();
    await fs.promises.mkdir(path.join(dir, '123'));

    const r = await detectCaseInsensitive(path.join(dir, '123'));

    expect(typeof r).toBe('boolean');
  });
});
