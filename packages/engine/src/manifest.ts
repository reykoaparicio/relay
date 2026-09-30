// 07 G4: context manifest (§10.2 step 8, §5.4 "Context used"). The schema lives in @relay/contracts; this module
// only builds instances and parses them before returning, so an invalid manifest is an internal error here, never a
// stored artifact.
import { createHash } from 'node:crypto';
import { contextManifestSchema } from '@relay/contracts';
import type { ContextManifest, RunInput, Sha256 } from '@relay/contracts';

/** Everything `buildManifest` needs (the contracts fields, before parsing). */
export type ManifestInput = Omit<ContextManifest, 'schemaVersion'>;

/**
 * Builds and validates a manifest.
 * @throws ZodError when the input does not satisfy the contracts `contextManifestSchema` (a bug in the caller).
 */
export function buildManifest(input: ManifestInput): ContextManifest {
  return contextManifestSchema.parse({ schemaVersion: 1, ...input });
}

const SEPARATOR = '\n\0\n';

/** Lowercase hex sha256 of a UTF-8 string (e.g. the instruction text recorded in the manifest). */
export function sha256Text(text: string): Sha256 {
  return createHash('sha256').update(text).digest('hex');
}

/** `sha256(system + "\n\0\n" + user)`: the separator keeps (a, bc) and (ab, c) apart. */
export function computeContextHash(system: string, user: string): Sha256 {
  return createHash('sha256').update(`${system}${SEPARATOR}${user}`).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The intake context hash that becomes `runs.context_hash` (bound into the approval, §11.3): goal, input, the
 * snapshotted file hashes (sorted by path), and the memory revisions snapshotted for the run.
 */
export function computeIntakeContextHash(i: {
  readonly goal: string;
  readonly input: RunInput;
  readonly files: readonly { readonly relPath: string; readonly sha256: Sha256 }[];
  readonly memory: readonly { readonly recordId: string; readonly revision: number }[];
}): Sha256 {
  const files = [...i.files].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const memory = [...i.memory].sort((a, b) => (a.recordId < b.recordId ? -1 : 1));
  return computeContextHash('relay.intake.v1', stableJson({ goal: i.goal, input: i.input, files, memory }));
}
