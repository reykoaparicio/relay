import ignore from 'ignore';
import type { Ignore } from 'ignore';
import { INPUT_CAPS } from '@relay/contracts';
import type { ProjectRoot } from './paths.js';
import { classifyByName } from './exclusions.js';
import { readConfined, relPathBrand } from './paths.js';

/** `.gitignore` rules keyed by the project-relative directory that holds them (`''` = project root). */
export type GitignoreRules = ReadonlyMap<string, Ignore>;

/** Parses one `.gitignore` file's text (rules are NFC, like every RelPath; B3). */
export function parseGitignore(text: string): Ignore {
  return ignore().add(text.normalize('NFC'));
}

/** A `.gitignore` matcher that rule files can be added to while a walk discovers them (no rebuild per file). */
export interface IncrementalGitignore {
  /** Registers the rules of `<dir>/.gitignore` (`dir` = project-relative, `''` = root; NFC-normalized here). */
  add(dir: string, rules: Ignore): void;
  /** Whether `relPath` is ignored. Only the rules of `relPath`'s proper ancestor directories apply. */
  readonly isGitignored: (relPath: string, isDirectory: boolean) => boolean;
}

/**
 * Creates an {@link IncrementalGitignore}. For each path, the rules of its ancestor directories are applied from the
 * shallowest to the deepest, so a deeper `!pattern` re-includes what a shallower file ignored (git semantics). Only
 * ancestors can apply, so a lookup is O(depth) map probes, independent of how many rule files exist.
 */
export function createIncrementalGitignore(): IncrementalGitignore {
  const byDir = new Map<string, Ignore>();
  const isGitignored = (rawRelPath: string, isDirectory: boolean): boolean => {
    const relPath = rawRelPath.normalize('NFC');
    if (relPath === '') return false;
    let ignored = false;
    // `end` walks the separators: dir = '' then every proper ancestor (a/b/c → '', 'a', 'a/b'); sub = the rest.
    let end = -1;
    do {
      const ig = byDir.get(end === -1 ? '' : relPath.slice(0, end));
      if (ig !== undefined) {
        const sub = relPath.slice(end + 1);
        const r = ig.test(isDirectory ? `${sub}/` : sub);
        if (r.ignored) ignored = true;
        if (r.unignored) ignored = false;
      }
      end = relPath.indexOf('/', end + 1);
    } while (end !== -1);
    return ignored;
  };
  return {
    add: (dir, rules) => {
      byDir.set(dir.normalize('NFC'), rules);
    },
    isGitignored,
  };
}

/** Builds the `isGitignored` matcher for a fixed set of rule files (see {@link createIncrementalGitignore}). */
export function makeGitignoreMatcher(rules: GitignoreRules): (relPath: string, isDirectory: boolean) => boolean {
  const matcher = createIncrementalGitignore();
  for (const [dir, ig] of rules) matcher.add(dir, ig);
  return matcher.isGitignored;
}

/**
 * Reads `<dirRel>/.gitignore` through the confined reader; missing or unreadable → null. `dirRel` may be an on-disk
 * (possibly NFD) spelling, so it is only schema-checked, not re-normalized. A `.gitignore` that resolves to a secret
 * is never read.
 */
export async function loadGitignore(root: ProjectRoot, dirRel: string): Promise<Ignore | null> {
  const rel = relPathBrand.safeParse(dirRel === '' ? '.gitignore' : `${dirRel}/.gitignore`);
  if (!rel.success) return null;
  const noSecrets = { maxFileBytes: INPUT_CAPS.maxFileBytes };
  const read = await readConfined(root, rel.data, INPUT_CAPS.maxFileBytes, (real) =>
    classifyByName(real, false, noSecrets) === 'secret' ? 'secret' : null,
  );
  if (!read.ok) return null;
  return parseGitignore(new TextDecoder().decode(read.value.bytes));
}

/** Loads the `.gitignore` files of the root and of every ancestor directory of `relPaths` (for direct reads). */
export async function loadGitignoresForPaths(root: ProjectRoot, relPaths: readonly string[]): Promise<GitignoreRules> {
  const dirs = new Set<string>(['']);
  for (const p of relPaths) {
    const segments = p.split('/').slice(0, -1);
    segments.forEach((_, i) => dirs.add(segments.slice(0, i + 1).join('/')));
  }
  const entries = await Promise.all([...dirs].map(async (d) => [d, await loadGitignore(root, d)] as const));
  const rules = new Map<string, Ignore>();
  for (const [d, ig] of entries) if (ig !== null) rules.set(d, ig);
  return rules;
}
