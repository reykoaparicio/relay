// 06 F8 inputs (R4-6): the semantic checks read the run's `input_file` SNAPSHOT artifacts (never the live disk) and
// the approved file scope. Loaded outside any transaction, before the pure `validateOutput` call.
import { parsePatch } from 'diff';
import { INPUT_CAPS } from '@relay/contracts';
import type { ArtifactId } from '@relay/contracts';
import type { RunRow } from '@relay/storage';
import { preservedApproval } from '../approval-binding.js';
import { fromUtf8 } from '../hash.js';
import { logSafe } from '../log-safe.js';
import type { EngineCtx } from '../ports.js';
import type { ValidationInputs } from './validate-output.js';

/** File names a diff-input run's imported diff touches (their bytes are not part of the run). */
async function diffFileNames(ctx: EngineCtx, diffArtifactId: ArtifactId): Promise<string[]> {
  const row = ctx.db.repos.artifacts.get(diffArtifactId);
  if (row === undefined) return [];
  const bytes = await ctx.artifacts.read(row.relPath, INPUT_CAPS.maxDiffBytes);
  if (!bytes.ok) return [];
  try {
    return parsePatch(fromUtf8(bytes.value)).flatMap((p) =>
      [p.newFileName, p.oldFileName].filter((n): n is string => n !== undefined && n !== '/dev/null').map((n) => n.replace(/^[ab]\//, '')).slice(0, 1));
  } catch {
    return [];
  }
}

/**
 * Loads the F8 inputs of `run`: every input file's snapshot content (a file whose snapshot cannot be read or
 * verified is listed in `unavailable`, logged — its content checks then fail as `snapshot_unavailable`), the approved
 * scope (latest valid approval, or the B4-preserved one), and whether this is a quality revision under that approval
 * (`run.revisionCycle > 0`; a replan resets the cycle).
 */
export async function loadValidationInputs(ctx: EngineCtx, run: RunRow): Promise<ValidationInputs> {
  const r = ctx.db.repos;
  const files = new Map<string, string | null>();
  const unavailable = new Set<string>();
  const cache = new Map<ArtifactId, string | null>();
  for (const f of r.runs.inputFiles(run.id)) {
    let content = cache.get(f.artifactId);
    if (content === undefined) {
      const row = r.artifacts.get(f.artifactId);
      const read = row === undefined ? null : await ctx.artifacts.readSnapshot({ artifactId: f.artifactId, storeRelPath: row.relPath, sha256: f.sha256 });
      if (read?.ok !== true) ctx.logger.warn('validation.snapshot_unreadable', { runId: run.id, artifactId: f.artifactId, err: read === null ? 'missing_row' : logSafe(read.error.code) });
      content = read?.ok === true ? read.value.content : null;
      cache.set(f.artifactId, content);
    }
    files.set(f.relPath, content);
    if (content === null) unavailable.add(f.relPath);
  }
  if (run.input.kind === 'diff') for (const name of await diffFileNames(ctx, run.input.diffArtifactId)) if (!files.has(name)) files.set(name, null);
  const approval = r.approvals.latestApprovedForRun(run.id) ?? preservedApproval(r, run.id);
  return { files, approvedScope: approval === undefined ? null : [...approval.fileScope], isRevision: r.runs.get(run.id).revisionCycle > 0, unavailable };
}
