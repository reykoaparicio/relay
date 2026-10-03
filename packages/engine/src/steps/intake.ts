// 06 F13 intake (R4-6): read the selected files ONCE, snapshot them as `input_file` artifacts, record
// `run_input_files` (each row carries its artifact id), snapshot memory, and set `runs.context_hash`. A diff-input run
// (05 E5, ADR-015) snapshots the CURRENT project files its imported diff references, read through the same confined
// pipeline (the diff's paths are re-checked against the project's exclusions first).
import { ok } from '@relay/contracts';
import type { AppError, ArtifactId, EpochMs, ProjectId, Result, RunId, Sha256, StepRunId } from '@relay/contracts';
import type { Repos, RunInputFile, RunRow } from '@relay/storage';
import type { InputFileRef, SelectedFile } from '@relay/tools';
import { computeIntakeContextHash } from '../manifest.js';
import type { EngineCtx } from '../ports.js';
import { appendRunEvent } from '../run-machine.js';
import { snapshotOf } from '../snapshot.js';
import { applyStepEvent } from '../step-machine.js';
import { readInputDiff } from './input-diff.js';
import { blockRun, commitIfReady, setupBlocked } from './local.js';

/** One selected file read at intake (or re-snapshot) and its `input_file` snapshot artifact. */
export type Snapshotted = { readonly file: SelectedFile; readonly ref: InputFileRef };

/**
 * The run input's explicit acknowledgement of suspected-secret files (E2 #11; `RunInput.acknowledgedSuspectedSecrets`).
 * Used by BOTH preflight and intake (with the shared tools `unacknowledgedSuspectedSecret` predicate) so they agree.
 * Read defensively so an input without the field means "none acknowledged". Only a `files` input can acknowledge: a
 * `diff` input never can, so a suspected secret in a file its diff references always blocks the run (fail closed).
 */
export function acknowledgedSuspectedSecrets(input: RunRow['input']): string[] {
  if (input.kind !== 'files') return [];
  const v: unknown = (input as { readonly acknowledgedSuspectedSecrets?: unknown }).acknowledgedSuspectedSecrets;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Reads `relPaths` from the project root ONCE and snapshots their bytes as `input_file` artifacts (reusing this run's
 * existing snapshot per sha). Used by intake and by `resnapshot_and_replan` (06 F10). A file whose content looks like a
 * credential is refused (PERMISSION_DENIED `suspected_secret`, E2 #11) unless the run input acknowledges it. A missing
 * project folder is PROJECT_ROOT_MISSING (E2 #7); an unreadable file PERMISSION_DENIED `unreadable` naming it (E2 #8).
 */
export async function snapshotSelectedFiles(ctx: EngineCtx, runId: RunId, relPaths: readonly string[]): Promise<Snapshotted[] | { error: AppError }> {
  const run = ctx.db.repos.runs.get(runId);
  const project = ctx.db.repos.projects.getWithRoot(run.projectId);
  const root = await ctx.projectFs.openRoot(project.rootRealpath);
  if (!root.ok) return { error: root.error };
  const read = await ctx.projectFs.readSelected(root.value, relPaths, {
    exclusions: project.exclusions,
    secretCheck: { acknowledged: acknowledgedSuspectedSecrets(run.input) },
  });
  if (!read.ok) return { error: read.error };
  const files = read.value.files;
  // An intake retry reuses the snapshots already committed for this run (one input_file artifact per unique sha).
  const existing = new Map<Sha256, InputFileRef>();
  for (const f of files) {
    const row = ctx.db.repos.artifacts.findInputFile(runId, f.sha256);
    if (row !== undefined) existing.set(f.sha256, { artifactId: row.id, storeRelPath: row.relPath, sha256: row.sha256 });
  }
  const missing = files.filter((f) => !existing.has(f.sha256));
  const stored = await ctx.artifacts.snapshotInputFiles(runId, missing, () => ctx.ids.next('artifact'));
  if (!stored.ok) return { error: stored.error };
  for (const s of stored.value) existing.set(s.sha256, { artifactId: s.artifactId, storeRelPath: s.storeRelPath, sha256: s.sha256 });
  return files.map((file) => {
    const ref = existing.get(file.sha256);
    if (ref === undefined) throw new Error('intake: snapshot ref missing'); // unreachable: every sha was stored above
    return { file, ref };
  });
}

/**
 * The current project files an imported diff references (05 E5): the stored `input_diff` artifact of `projectId` is
 * parsed again, every path it names is re-checked (exclusions, outside-root → PERMISSION_DENIED), and the paths that
 * exist and are readable now are returned (added files have no current content; deleted ones are gone).
 */
export async function diffReferencedPaths(ctx: EngineCtx, projectId: ProjectId, diffArtifactId: ArtifactId): Promise<Result<string[]>> {
  const stored = await readInputDiff(ctx, projectId, diffArtifactId);
  if (!stored.ok) return stored;
  const diff = ctx.projectFs.parseDiff(stored.value.text);
  if (!diff.ok) return diff;
  const project = ctx.db.repos.projects.getWithRoot(projectId);
  const root = await ctx.projectFs.openRoot(project.rootRealpath);
  if (!root.ok) return root;
  const checked = await ctx.projectFs.checkDiffPaths(root.value, diff.value, { exclusions: project.exclusions });
  if (!checked.ok) return checked;
  const named = [...new Set(diff.value.files.flatMap((f) => [f.oldPath, f.newPath]).filter((p): p is NonNullable<typeof p> => p !== null))];
  if (named.length === 0) return ok([]);
  const live = await ctx.projectFs.hashFiles(root.value, named);
  if (!live.ok) return live;
  return ok(live.value.filter((h) => h.sha256 !== null).map((h) => h.relPath));
}

/** Inserts the `input_file` artifact rows of `files` (caller's tx) and returns the matching `run_input_files` rows. */
export function inputFileRows(r: Repos, run: Pick<RunRow, 'id' | 'projectId'>, files: readonly Snapshotted[], now: EpochMs): RunInputFile[] {
  return files.map(({ file, ref }) => {
    const art = r.artifacts.insertIfAbsent({
      id: ref.artifactId, runId: run.id, projectId: run.projectId, kind: 'input_file', relPath: ref.storeRelPath, sha256: ref.sha256,
      sizeBytes: file.size, mediaType: 'text/plain; charset=utf-8', createdAt: now,
    });
    return { relPath: file.relPath, sha256: file.sha256, artifactId: art.id, sizeBytes: file.size, capturedAt: now };
  });
}

/** The run's intake context hash over its CURRENT `run_input_files` and memory snapshot (caller's tx). */
export function intakeContextHash(r: Repos, run: Pick<RunRow, 'id' | 'goal' | 'input'>): Sha256 {
  return computeIntakeContextHash({
    goal: run.goal,
    input: run.input,
    files: r.runs.inputFiles(run.id).map((f) => ({ relPath: f.relPath, sha256: f.sha256 })),
    memory: r.memory.runSnapshot(run.id).map((m) => ({ recordId: m.recordId, revision: m.revision })),
  });
}

/** Runs the intake step. Failures (PERMISSION_DENIED, NOT_FOUND, CONTEXT_TOO_LARGE, …) → SETUP_BLOCKED. */
export async function runIntake(ctx: EngineCtx, runId: RunId, stepRunId: StepRunId): Promise<void> {
  const run = ctx.db.repos.runs.get(runId);
  let files: Snapshotted[] = [];
  if (run.input.kind === 'files') {
    const read = await snapshotSelectedFiles(ctx, runId, run.input.relPaths);
    if ('error' in read) return blockRun(ctx, runId, setupBlocked(read.error));
    files = read;
  } else {
    const paths = await diffReferencedPaths(ctx, run.projectId, run.input.diffArtifactId);
    if (!paths.ok) return blockRun(ctx, runId, setupBlocked(paths.error));
    if (paths.value.length > 0) {
      const read = await snapshotSelectedFiles(ctx, runId, paths.value);
      if ('error' in read) return blockRun(ctx, runId, setupBlocked(read.error));
      files = read;
    }
  }
  const memory = ctx.memory.snapshotForRun(runId, run.projectId, { includeIds: snapshotOf(run).memoryIncludeIds });
  if (!memory.ok) return blockRun(ctx, runId, setupBlocked(memory.error));
  await commitIfReady(ctx, runId, stepRunId, (r, cur, step, fx) => {
    const now = ctx.clock.now();
    const rows = inputFileRows(r, cur, files, now);
    if (r.runs.inputFiles(runId).length === 0 && rows.length > 0) r.runs.insertInputFiles(runId, rows);
    const contextHash = intakeContextHash(r, cur);
    r.runs.setContextHash(runId, contextHash);
    applyStepEvent(r, fx, step, 'LOCAL_STEP_DONE');
    appendRunEvent(r, fx, runId, 'context.assembled', { stepKey: step.stepKey, stepRunId: step.id, contextHash, files: rows.length });
  });
}
