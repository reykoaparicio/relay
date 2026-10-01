import { isUtf8 } from 'node:buffer';
import fc from 'fast-check';
import type { Ignore } from 'ignore';
import { describe, expect, it } from 'vitest';
import { createIncrementalGitignore, makeGitignoreMatcher, parseGitignore } from './gitignore.js';

/** Oracle: the previous matcher (every rule file, sorted by depth, filtered by prefix), verbatim. */
function oldMatcher(rules: ReadonlyMap<string, Ignore>): (relPath: string, isDirectory: boolean) => boolean {
  const ordered = [...rules.entries()]
    .map(([dir, ig]) => [dir.normalize('NFC'), ig] as const)
    .sort(([a], [b]) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return (rawRelPath, isDirectory) => {
    const relPath = rawRelPath.normalize('NFC');
    let ignored = false;
    for (const [dir, ig] of ordered) {
      const sub = dir === '' ? relPath : relPath.slice(dir.length + 1);
      const applies = dir === '' || relPath.startsWith(`${dir}/`);
      if (!applies || sub === '') continue;
      const r = ig.test(isDirectory ? `${sub}/` : sub);
      if (r.ignored) ignored = true;
      if (r.unignored) ignored = false;
    }
    return ignored;
  };
}

const SEGMENTS = ['a', 'b', 'ab', 'x.log', 'keep.log', 'build-1', 'café'] as const;
const PATTERNS = ['*.log', '!keep.log', 'build-*', 'b/', '/a', 'a/b', '!b', 'x.*', '**/ab', 'ab/'] as const;
const DIRS = ['', 'a', 'b', 'a/b', 'ab', 'a/ab'] as const;

const ruleSets = fc.array(fc.tuple(fc.constantFrom(...DIRS), fc.array(fc.constantFrom(...PATTERNS), { maxLength: 4 })), { maxLength: 5 });
const relPaths = fc.array(fc.constantFrom(...SEGMENTS), { minLength: 1, maxLength: 4 }).map((s) => s.join('/'));

describe('gitignore matcher', () => {
  it('the ancestor-lookup matcher agrees with the previous all-rules matcher', () => {
    fc.assert(
      fc.property(ruleSets, relPaths, fc.boolean(), (sets, relPath, isDirectory) => {
        const rules = new Map<string, Ignore>(sets.map(([dir, pats]) => [dir, parseGitignore(pats.join('\n'))]));

        expect(makeGitignoreMatcher(rules)(relPath, isDirectory)).toBe(oldMatcher(rules)(relPath, isDirectory));
      }),
      { numRuns: 2000 },
    );
  });

  it('rules added later apply to later lookups (incremental), and an NFD directory key matches NFC paths', () => {
    const m = createIncrementalGitignore();

    expect(m.isGitignored('café/x.log', false)).toBe(false);
    m.add('café', parseGitignore('*.log'));

    expect(m.isGitignored('café/x.log', false)).toBe(true);
    expect(m.isGitignored('x.log', false)).toBe(false);
    expect(m.isGitignored('', false)).toBe(false);
  });
});

describe('buffer.isUtf8 (scan) agrees with a fatal TextDecoder (readSelected)', () => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decodes = (b: Uint8Array): boolean => {
    try {
      decoder.decode(b);
      return true;
    } catch {
      return false;
    }
  };

  it('on random byte strings, including truncated and overlong sequences, surrogates, and BOMs', () => {
    const tricky = fc.constantFrom(
      [0xef, 0xbb, 0xbf],
      [0xc3, 0xa9],
      [0xc3],
      [0xe2, 0x82],
      [0xed, 0xa0, 0x80],
      [0xc0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xf0, 0x9f, 0x98, 0x80],
      [0x00],
      [0x7f],
    );
    const bytes = fc
      .array(fc.oneof(fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 6 }), tricky), { maxLength: 12 })
      .map((parts) => Uint8Array.from(parts.flat()));

    fc.assert(
      fc.property(bytes, (b) => {
        expect(isUtf8(b)).toBe(decodes(b));
      }),
      { numRuns: 3000 },
    );
  });
});
