import { parsePatch } from 'diff';
import type { StructuredPatch, StructuredPatchHunk } from 'diff';
import type { RelPath, Result } from '@relay/contracts';
import { INPUT_CAPS, err, errors, ok } from '@relay/contracts';
import type { ClassifyContext } from './exclusions.js';
import { classifyByName, compileUserPatterns } from './exclusions.js';
import { loadGitignoresForPaths, makeGitignoreMatcher } from './gitignore.js';
import type { ProjectRoot } from './paths.js';
import { normalizeRelPath, realRelPath, resolveInside } from './paths.js';
import type { Denial } from './read.js';

/** One file in an imported diff. `null` = `/dev/null` (the file is added or deleted). */
export interface DiffFile {
  readonly oldPath: RelPath | null;
  readonly newPath: RelPath | null;
  readonly hunks: readonly StructuredPatchHunk[];
}

/** Parsed imported diff (ADR-015). */
export interface ImportedDiff {
  readonly files: readonly DiffFile[];
  readonly warnings: readonly string[];
}

const DEV_NULL = '/dev/null';

function invalid(message: string, code: string) {
  return err(errors.validationFailed([{ path: 'diff', message, code }]));
}

function tryParse(text: string): StructuredPatch[] | null {
  try {
    return parsePatch(text);
  } catch {
    return null;
  }
}

/** git-style diffs prefix paths with `a/` and `b/`; strip them only when both sides follow that convention. */
function stripGitPrefixes(oldName: string, newName: string): [string, string] {
  const oldOk = oldName === DEV_NULL || oldName.startsWith('a/');
  const newOk = newName === DEV_NULL || newName.startsWith('b/');
  if (!oldOk || !newOk) return [oldName, newName];
  const strip = (n: string) => (n === DEV_NULL ? n : n.slice(2));
  return [strip(oldName), strip(newName)];
}

function toRelPath(name: string): Result<RelPath | null> {
  if (name === DEV_NULL) return ok(null);
  return normalizeRelPath(name);
}

function toDiffFile(patch: StructuredPatch, warnings: string[]): Result<DiffFile> {
  if (patch.oldFileName === undefined || patch.newFileName === undefined) {
    return invalid('The diff has a change without file names.', 'missing_file_names');
  }
  const [oldName, newName] = stripGitPrefixes(patch.oldFileName, patch.newFileName);
  const oldPath = toRelPath(oldName);
  if (!oldPath.ok) return oldPath;
  const newPath = toRelPath(newName);
  if (!newPath.ok) return newPath;
  if (oldPath.value === null && newPath.value === null) return invalid('A diff entry has no file on either side.', 'no_paths');
  if (patch.hunks.length === 0) warnings.push(`${newPath.value ?? oldPath.value ?? ''}: no hunks (binary or mode-only change)`);
  return ok({ oldPath: oldPath.value, newPath: newPath.value, hunks: patch.hunks });
}

/**
 * Parses an imported `.diff`/`.patch` (05 E5, ADR-015). Capped at `INPUT_CAPS.maxDiffBytes`; every path must pass
 * {@link normalizeRelPath} (`/dev/null` allowed for adds and deletes). Pure: root checks are {@link checkDiffPaths}.
 */
export function parseImportedDiff(text: string, maxBytes: number = INPUT_CAPS.maxDiffBytes): Result<ImportedDiff> {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return invalid('The diff file is too large.', 'too_large');
  const patches = tryParse(text);
  if (patches === null) return invalid('The diff could not be parsed.', 'unparseable');
  const warnings: string[] = [];
  const files: DiffFile[] = [];
  for (const patch of patches) {
    const file = toDiffFile(patch, warnings);
    if (!file.ok) return file;
    files.push(file.value);
  }
  if (files.length === 0) return invalid('The diff contains no file changes.', 'empty');
  return ok({ files, warnings });
}

/** Options for {@link checkDiffPaths}. */
export interface DiffCheckOptions {
  readonly exclusions?: readonly string[];
  readonly respectGitignore?: boolean;
}

async function checkOne(root: ProjectRoot, rel: RelPath, ctx: ClassifyContext): Promise<Denial | null> {
  const byName = classifyByName(rel, false, ctx);
  if (byName !== null) return { relPath: rel, reason: byName };
  const resolved = await resolveInside(root, rel);
  if (!resolved.ok) {
    // A path that does not exist yet (an add) is fine; an escape is not.
    return resolved.error.code === 'PERMISSION_DENIED' ? { relPath: rel, reason: 'outside_root' } : null;
  }
  const byReal = classifyByName(realRelPath(root, resolved.value.real), false, ctx);
  return byReal === null ? null : { relPath: rel, reason: byReal };
}

/**
 * Checks every path an imported diff references against the project (05 E5): excluded files (`secret`, …) and
 * paths that resolve outside the root are rejected with `PERMISSION_DENIED` listing each offending relPath.
 */
export async function checkDiffPaths(root: ProjectRoot, diff: ImportedDiff, opts: DiffCheckOptions = {}): Promise<Result<void>> {
  const paths = [...new Set(diff.files.flatMap((f) => [f.oldPath, f.newPath]).filter((p): p is RelPath => p !== null))];
  let ctx: ClassifyContext = { maxFileBytes: INPUT_CAPS.maxFileBytes, isUserExcluded: compileUserPatterns(opts.exclusions ?? []) };
  if (opts.respectGitignore !== false) {
    ctx = { ...ctx, isGitignored: makeGitignoreMatcher(await loadGitignoresForPaths(root, paths)) };
  }
  const results = await Promise.all(paths.map((p) => checkOne(root, p, ctx)));
  const denials = results.filter((d): d is Denial => d !== null);
  if (denials.length === 0) return ok(undefined);
  const allOutside = denials.every((d) => d.reason === 'outside_root');
  return err(
    errors.permissionDenied(allOutside ? 'outside_root' : 'excluded', {
      userMessage: 'The diff touches files Relay is not allowed to read. Remove those files from the diff.',
      details: { denied: denials.map((d) => ({ ...d })) },
    }),
  );
}
