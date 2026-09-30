// 06 F13 intake (R4-6): read the selected files ONCE, snapshot them as `input_file` artifacts, record
// `run_input_files` (each row carries its artifact id), snapshot memory, and set `runs.context_hash`.
import { INPUT_CAPS, errors } from '@relay/contracts';
import type { AppError, RunId, Sha256, StepRunId } from '@relay/contracts';
import type { RunInputFile } from '@relay/storage';
import type { InputFileRef, SelectedFile } from '@relay/tools';
import { computeIntakeContextHash } from '../manifest.js';
import type { EngineCtx } from '../ports.js';
import { appendRunEvent } from '../run-machine.js';
import { snapshotOf } from '../snapshot.js';
import { applyStepEvent } from '../step-machine.js';
import { blockRun, commitIfReady, setupBlocked } from './local.js';

type Snapshotted = { readonly file: SelectedFile; readonly ref: InputFileRef };

async function readFiles(ctx: EngineCtx, runId: RunId, relPaths: readonly string[]): Promise<Snapshotted[] | { error: AppError }> {
  const run = ctx.db.repos.runs.get(runId);
  const project = ctx.db.repos.projects.getWithRoot(run.projectId);
  const root = await ctx.projectFs.openRoot(project.rootRealpath);
  if (!root.ok) return { error: root.error };
  const read = await ctx.projectFs.readSelected(root.value, relPaths, { exclusions: project.exclusions });
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

/** Runs the intake step. Failures (PERMISSION_DENIED, NOT_FOUND, CONTEXT_TOO_LARGE, …) → SETUP_BLOCKED. */
export async function runIntake(ctx: EngineCtx, runId: RunId, stepRunId: StepRunId): Promise<void> {
  const run = ctx.db.repos.runs.get(runId);
  let files: Snapshotted[] = [];
  if (run.input.kind === 'files') {
    const read = await readFiles(ctx, runId, run.input.relPaths);
    if ('error' in read) return blockRun(ctx, runId, setupBlocked(read.error));
    files = read;
  } else {
    const diff = ctx.db.repos.artifacts.get(run.input.diffArtifactId);
    if (diff?.kind !== 'input_diff' || diff.projectId !== run.projectId || diff.sizeBytes > INPUT_CAPS.maxDiffBytes) {
      return blockRun(ctx, runId, setupBlocked(errors.notFound('input_diff')));
    }
  }
  const memory = ctx.memory.snapshotForRun(runId, run.projectId, { includeIds: snapshotOf(run).memoryIncludeIds });
  if (!memory.ok) return blockRun(ctx, runId, setupBlocked(memory.error));
  await commitIfReady(ctx, runId, stepRunId, (r, cur, step, fx) => {
    const now = ctx.clock.now();
    const rows: RunInputFile[] = files.map(({ file, ref }) => {
      const art = r.artifacts.insertIfAbsent({
        id: ref.artifactId, runId, projectId: cur.projectId, kind: 'input_file', relPath: ref.storeRelPath, sha256: ref.sha256,
        sizeBytes: file.size, mediaType: 'text/plain; charset=utf-8', createdAt: now,
      });
      return { relPath: file.relPath, sha256: file.sha256, artifactId: art.id, sizeBytes: file.size, capturedAt: now };
    });
    if (r.runs.inputFiles(runId).length === 0 && rows.length > 0) r.runs.insertInputFiles(runId, rows);
    const contextHash = computeIntakeContextHash({
      goal: cur.goal,
      input: cur.input,
      files: r.runs.inputFiles(runId).map((f) => ({ relPath: f.relPath, sha256: f.sha256 })),
      memory: r.memory.runSnapshot(runId).map((m) => ({ recordId: m.recordId, revision: m.revision })),
    });
    r.runs.setContextHash(runId, contextHash);
    applyStepEvent(r, fx, step, 'LOCAL_STEP_DONE');
    appendRunEvent(r, fx, runId, 'context.assembled', { stepKey: step.stepKey, contextHash, files: rows.length });
  });
}
