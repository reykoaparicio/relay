import { randomBytes } from 'node:crypto';
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

/** Hidden temp name in the destination folder (same filesystem, so the final link/rename is atomic). */
function tempName(name: string): string {
  return `.${name.slice(0, 180)}.relay-partial-${randomBytes(6).toString('hex')}`;
}

async function unlinkQuietly(p: string): Promise<void> {
  try {
    await fs.promises.unlink(p);
  } catch {
    // already gone
  }
}

/** Errnos of a filesystem without hard links (exFAT, some network shares): fall back to an exclusive copy. */
const NO_LINK_ERRNOS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EMLINK']);

/**
 * Publishes the complete temp file under `final` without ever overwriting (E2 #9): a hard link fails with EEXIST when
 * the name is taken; where links are unsupported, an exclusive copy (removed again if it fails half-way).
 * @throws the EEXIST of a taken name, or the write error.
 */
async function publish(temp: string, final: string): Promise<void> {
  try {
    await fs.promises.link(temp, final);
    return;
  } catch (e) {
    if (!NO_LINK_ERRNOS.has(errnoOf(e) ?? '')) throw e;
  }
  try {
    await fs.promises.copyFile(temp, final, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if (errnoOf(e) !== 'EEXIST') await unlinkQuietly(final); // only a partial copy THIS call created
    throw e;
  }
}

/**
 * Writes `bytes` to a hidden temp file in `dir`, then publishes it as `name` (on a clash ` (2)`, ` (3)`, …). Never
 * overwrites, and never leaves a 0-byte or partial file under the export name: the temp file is always removed
 * (E2 #9). Returns the file name used.
 */
async function writeExclusive(dir: string, name: string, bytes: Uint8Array): Promise<string> {
  const temp = path.join(dir, tempName(name));
  try {
    await fs.promises.writeFile(temp, bytes, { flag: 'wx' });
    await exportWriteHooks.beforePublish?.(temp);
    for (let n = 1; n <= MAX_NAME_SUFFIX; n += 1) {
      const fileName = candidateName(name, n);
      try {
        await publish(temp, path.join(dir, fileName));
        return fileName;
      } catch (e) {
        if (errnoOf(e) !== 'EEXIST') throw e;
      }
    }
    throw new Error('no free export file name');
  } finally {
    await unlinkQuietly(temp);
  }
}

/** Test-only seam: lets a test make the temp write fail part-way (never set in production code). */
export const exportWriteHooks: { beforePublish?: (temp: string) => Promise<void> | void } = {};

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

/** One file that could not be exported (E2 #10). */
export interface ExportFailure {
  readonly suggestedName: string;
  readonly code: AppError['code'];
}

/**
 * Exports stored artifacts (artifacts.exportTo: run report / patch, FR-10). Checks the destination once, then reads
 * and writes each file independently (E2 #10): a purged / missing artifact or a write error is reported in `failed`
 * while the other files are still written, so the caller retries only the failed ones. Every write is atomic and never
 * overwrites (temp file + ` (n)` suffixing). Only when NOTHING was written is the result an error (the first failure,
 * with `details.failed`). The run is untouched (§17.1).
 */
export async function exportArtifacts(input: ExportArtifactsInput): Promise<Result<{ written: string[]; failed: ExportFailure[] }>> {
  if (!input.files.every((f) => isSafeFileName(f.suggestedName))) return err(invalidName());
  const dest = await assertExportDestination(input.destinationRealpath, input.projectRoots);
  if (!dest.ok) return dest;
  const written: string[] = [];
  const failures: { suggestedName: string; error: AppError }[] = [];
  for (const f of input.files) {
    const r = await input.store.read(f.relPath, EXPORT_MAX_ARTIFACT_BYTES);
    if (!r.ok) {
      failures.push({ suggestedName: f.suggestedName, error: r.error });
      continue;
    }
    try {
      written.push(await writeExclusive(dest.value, f.suggestedName, r.value));
    } catch {
      failures.push({ suggestedName: f.suggestedName, error: errors.artifactWriteFailed() });
    }
  }
  const failed = failures.map((x) => ({ suggestedName: x.suggestedName, code: x.error.code }));
  const first = failures[0];
  if (written.length === 0 && first !== undefined) return err({ ...first.error, details: { ...first.error.details, failed } });
  return ok({ written, failed });
}
