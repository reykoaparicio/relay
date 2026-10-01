import fs from 'node:fs';
import path from 'node:path';
import type { AppError, Result } from '@relay/contracts';
import { err, errnoOf, errors, ok } from '@relay/contracts';
import type { ArtifactStore } from './artifact-store.js';
import { detectCaseInsensitive, relationOf } from './paths.js';

/** Max bytes of one exported artifact (reports and patches are far smaller; guards against a corrupt store). */
export const EXPORT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
/** Upper bound on ` (n)` suffixes tried before giving up (never overwrite, 05 E7). */
const MAX_NAME_SUFFIX = 1000;
/** Max UTF-8 bytes of an export file name (common filesystem limit). */
const MAX_FILE_NAME_BYTES = 255;

/** A single safe file name: no separator, no NUL, not `.`/`..`, 1–255 bytes. */
export function isSafeFileName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (/[/\\\0]/.test(name)) return false;
  return Buffer.byteLength(name, 'utf8') <= MAX_FILE_NAME_BYTES;
}

function invalidName(): AppError {
  return errors.validationFailed([{ path: 'name', message: 'The file name is not valid.', code: 'invalid_file_name' }]);
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return null;
  }
}

/**
 * FR-10 destination check (05 E7): after realpath and case folding, refuses a destination inside (or equal to) any
 * registered project root (`inside_project`) or one that contains a project root (`contains_project`). Uses the E1
 * `path.relative` containment test, never a string prefix. Returns the re-resolved destination.
 */
export async function assertExportDestination(destinationRealpath: string, projectRoots: readonly string[]): Promise<Result<string>> {
  const dest = await realpathOrNull(destinationRealpath);
  if (dest === null || !(await fs.promises.stat(dest)).isDirectory()) return err(errors.notFound('export_destination'));
  const ci = await detectCaseInsensitive(dest);
  const roots = await Promise.all(projectRoots.map(async (r) => (await realpathOrNull(r)) ?? path.resolve(r)));
  for (const root of roots) {
    const destVsRoot = relationOf(root, dest, ci);
    if (destVsRoot !== 'outside') {
      return err(errors.permissionDenied('inside_project', { userMessage: 'Exports cannot be saved inside a project folder.' }));
    }
    if (relationOf(dest, root, ci) === 'inside') {
      return err(
        errors.permissionDenied('contains_project', { userMessage: 'Exports cannot be saved in a folder that contains a project.' }),
      );
    }
  }
  return ok(dest);
}

function candidateName(name: string, n: number): string {
  if (n === 1) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)} (${String(n)})${ext}`;
}

/** Writes with `O_CREAT|O_EXCL`; on a clash appends ` (2)`, ` (3)`, … Never overwrites. Returns the file name used. */
async function writeExclusive(dir: string, name: string, bytes: Uint8Array): Promise<string> {
  for (let n = 1; n <= MAX_NAME_SUFFIX; n += 1) {
    const fileName = candidateName(name, n);
    try {
      await fs.promises.writeFile(path.join(dir, fileName), bytes, { flag: 'wx' });
      return fileName;
    } catch (e) {
      if (errnoOf(e) !== 'EEXIST') throw e;
    }
  }
  throw new Error('no free export file name');
}

/**
 * Writes one export file (projects.exportTo JSON bundle, ledger.exportTo CSV). `destinationRealpath` comes only from
 * main's native dialog; it is re-resolved and checked here. Returns the file name only (no absolute path).
 */
export async function writeExportFile(
  destinationRealpath: string,
  name: string,
  bytes: Uint8Array,
  projectRoots: readonly string[],
): Promise<Result<{ fileName: string }>> {
  if (!isSafeFileName(name)) return err(invalidName());
  const dest = await assertExportDestination(destinationRealpath, projectRoots);
  if (!dest.ok) return dest;
  try {
    return ok({ fileName: await writeExclusive(dest.value, name, bytes) });
  } catch {
    return err(errors.artifactWriteFailed());
  }
}

/** Input to {@link exportArtifacts}. */
export interface ExportArtifactsInput {
  readonly files: readonly { readonly relPath: string; readonly suggestedName: string }[];
  readonly destinationRealpath: string;
  readonly projectRoots: readonly string[];
  /** The store the artifacts are read from (reads honor purge tombstones). */
  readonly store: Pick<ArtifactStore, 'read'>;
}

/**
 * Exports stored artifacts (artifacts.exportTo: run report / patch, FR-10). Checks the destination, reads every
 * artifact first (a purged or missing one fails the export before anything is written), then writes each with
 * `O_EXCL` and name suffixing. The run is untouched; a retry re-runs only the export (§17.1).
 */
export async function exportArtifacts(input: ExportArtifactsInput): Promise<Result<{ written: string[] }>> {
  if (!input.files.every((f) => isSafeFileName(f.suggestedName))) return err(invalidName());
  const dest = await assertExportDestination(input.destinationRealpath, input.projectRoots);
  if (!dest.ok) return dest;
  const contents: Uint8Array[] = [];
  for (const f of input.files) {
    const r = await input.store.read(f.relPath, EXPORT_MAX_ARTIFACT_BYTES);
    if (!r.ok) return r;
    contents.push(r.value);
  }
  const written: string[] = [];
  try {
    for (const [i, f] of input.files.entries()) {
      written.push(await writeExclusive(dest.value, f.suggestedName, contents[i] ?? new Uint8Array()));
    }
  } catch {
    return err(errors.artifactWriteFailed({ details: { written } }));
  }
  return ok({ written });
}
