import ignore from 'ignore';
import type { Ignore } from 'ignore';
import { INPUT_CAPS } from '@relay/contracts';
import type { ProjectRoot } from './paths.js';
import { normalizeRelPath, readConfined } from './paths.js';

/** `.gitignore` rules keyed by the project-relative directory that holds them (`''` = project root). */
export type GitignoreRules = ReadonlyMap<string, Ignore>;

/** Parses one `.gitignore` file's text. */
export function parseGitignore(text: string): Ignore {
  return ignore().add(text);
}

/**
 * Builds the `isGitignored` matcher for exclusions. Rules are applied from the shallowest directory to the deepest, so
 * a deeper `!pattern` re-includes what a shallower file ignored (git semantics).
 */
export function makeGitignoreMatcher(rules: GitignoreRules): (relPath: string, isDirectory: boolean) => boolean {
  const ordered = [...rules.entries()].sort(([a], [b]) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return (relPath, isDirectory) => {
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

/** Reads `<dirRel>/.gitignore` through the confined reader; missing or unreadable → null. */
export async function loadGitignore(root: ProjectRoot, dirRel: string): Promise<Ignore | null> {
  const rel = normalizeRelPath(dirRel === '' ? '.gitignore' : `${dirRel}/.gitignore`);
  if (!rel.ok) return null;
  const read = await readConfined(root, rel.value, INPUT_CAPS.maxFileBytes);
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
