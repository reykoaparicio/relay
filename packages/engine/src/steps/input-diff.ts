// 05 E5 / ADR-015: the ONE reader of a stored imported diff. Intake, context assembly, and output validation all read
// it through here, so they apply the same checks the intake does: the artifact is an `input_diff` of the run's
// project and within the diff size cap (NOT_FOUND `input_diff` otherwise), and its bytes are read with that cap.
import { INPUT_CAPS, err, errors, ok } from '@relay/contracts';
import type { ArtifactId, ProjectId, Result } from '@relay/contracts';
import type { ArtifactRow, Db } from '@relay/storage';
import type { ArtifactStore } from '@relay/tools';
import { fromUtf8 } from '../hash.js';

/** A stored imported diff: its artifact row and UTF-8 text. */
interface InputDiff {
  readonly row: ArtifactRow;
  readonly text: string;
}

/**
 * Reads the imported diff `diffArtifactId` of `projectId`.
 * @returns NOT_FOUND `input_diff` when the artifact is missing, not an `input_diff`, of another project, or over the
 *   size cap; the artifact store's error when the bytes cannot be read.
 */
export async function readInputDiff(deps: { readonly db: Db; readonly artifacts: Pick<ArtifactStore, 'read'> }, projectId: ProjectId, diffArtifactId: ArtifactId): Promise<Result<InputDiff>> {
  const row = deps.db.repos.artifacts.get(diffArtifactId);
  if (row?.kind !== 'input_diff' || row.projectId !== projectId || row.sizeBytes > INPUT_CAPS.maxDiffBytes) return err(errors.notFound('input_diff'));
  const bytes = await deps.artifacts.read(row.relPath, INPUT_CAPS.maxDiffBytes);
  return bytes.ok ? ok({ row, text: fromUtf8(bytes.value) }) : bytes;
}
