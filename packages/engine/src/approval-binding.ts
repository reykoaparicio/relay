// 06 F6 #8 inputs (`loadApprovalBinding`) and the approval invalidations that go with a stale binding (B4, F10).
// Computed by the caller BEFORE the pure policy check: the approval row, the current plan artifact hash, the run
// context hash, the live input-file hashes vs `run_input_files` (skipped for `use_preserved_snapshot`), and the
// step's effective provider.
import { errors } from '@relay/contracts';
import type { AppError, ApprovalId, ApprovalStaleReason, EpochMs, ProviderId, RelPath, RunId, StepKey } from '@relay/contracts';
import type { ApprovalRow, Repos, RunRow, SnapshotBinding } from '@relay/storage';
import type { ApprovalBinding } from './policy.js';
import type { EngineCtx, RunSnapshot } from './ports.js';
import type { PostCommitEffect } from './run-machine.js';
import { appendRunEvent } from './run-machine.js';
import { PROJECT_CHANGED_MARK, ancestorsOf, isSnapshotPreserved, snapshotBindingOf } from './snapshot.js';

/**
 * B4: the approval invalidated as `project_changed` when the user afterwards chose `use_preserved_snapshot` (its
 * `run.snapshot_preserved` event follows the invalidation record), else undefined — a new approval is then required.
 */
export function preservedApproval(r: Repos, runId: RunId, binding: SnapshotBinding = snapshotBindingOf(r, runId)): ApprovalRow | undefined {
  const mark = binding.invalidation;
  if (mark === null || mark.seq < binding.resnapshotSeq) return undefined; // a re-snapshot needs a new approval
  if (binding.preservedSeq <= mark.seq) return undefined; // no `run.snapshot_preserved` after the invalidation
  const a = mark.approvalId === null ? undefined : r.approvals.get(mark.approvalId as ApprovalId);
  return a?.decision === 'approved' && a.invalidatedReason === 'project_changed' ? a : undefined;
}

/** Invalidates `approvalId` with `reason` (caller's tx); a project change is also recorded on the run (B4). */
export function invalidateApproval(r: Repos, fx: PostCommitEffect[], runId: RunId, approvalId: ApprovalId, reason: ApprovalStaleReason, now: EpochMs): void {
  if (!r.approvals.invalidate(approvalId, reason, now)) return;
  if (reason === 'project_changed') {
    appendRunEvent(r, fx, runId, 'error.recorded', { kind: PROJECT_CHANGED_MARK, code: 'PROJECT_CHANGED', approvalId, invalidatedReason: reason });
  }
}

/** §11.2 input drift: the changed paths with their intake (`before`) and live (`after`, null = unreadable) hashes. */
export interface InputDrift {
  readonly changed: RelPath[];
  readonly before: Record<string, string>;
  readonly after: Record<string, string | null>;
}

/** PROJECT_CHANGED for a drift (`details = { changedPaths, before, after }`, read by the run inspector). */
export function projectChangedError(d: InputDrift, extra: Readonly<Record<string, unknown>> = {}): AppError {
  return errors.projectChanged(d.changed, { details: { before: d.before, after: d.after, ...extra } });
}

/** Input files whose live hash differs from the intake snapshot (§11.2). Unreadable root/files count as changed. */
export async function inputDrift(ctx: Pick<EngineCtx, 'db' | 'projectFs'>, run: Pick<RunRow, 'id' | 'projectId'>): Promise<InputDrift> {
  const files = ctx.db.repos.runs.inputFiles(run.id);
  const drift = (live: ReadonlyMap<string, string | null>): InputDrift => {
    const changed = files.filter((f) => live.get(f.relPath) !== f.sha256);
    return {
      changed: changed.map((f) => f.relPath),
      before: Object.fromEntries(changed.map((f) => [f.relPath, f.sha256])),
      after: Object.fromEntries(changed.map((f) => [f.relPath, live.get(f.relPath) ?? null])),
    };
  };
  if (files.length === 0) return drift(new Map());
  const project = ctx.db.repos.projects.getWithRoot(run.projectId);
  const root = await ctx.projectFs.openRoot(project.rootRealpath);
  if (!root.ok) return drift(new Map());
  const live = await ctx.projectFs.hashFiles(root.value, files.map((f) => f.relPath));
  return drift(live.ok ? new Map<string, string | null>(live.value.map((h) => [h.relPath, h.sha256])) : new Map());
}

/** F6 #8 inputs (async: re-hashes the input files unless the run chose `use_preserved_snapshot`). */
export async function loadApprovalBinding(
  ctx: Pick<EngineCtx, 'db' | 'projectFs'>,
  run: RunRow,
  snapshot: RunSnapshot,
  stepKey: StepKey,
  providerId: ProviderId,
  events: SnapshotBinding = snapshotBindingOf(ctx.db.repos, run.id),
): Promise<ApprovalBinding> {
  const r = ctx.db.repos;
  const planKey = [...ancestorsOf(snapshot, stepKey)].find((k) => {
    const s = snapshot.steps[k];
    return s?.kind === 'model' && s.outputSchema === 'plan.v1';
  });
  const planStep = planKey === undefined ? undefined : r.steps.latestFor(run.id, planKey);
  const planArtifact = planStep?.outputArtifactId == null ? undefined : r.artifacts.get(planStep.outputArtifactId);
  const valid = r.approvals.latestApprovedForRun(run.id);
  const preserved = valid === undefined ? preservedApproval(r, run.id, events) : undefined;
  const drift = isSnapshotPreserved(events) ? null : await inputDrift(ctx, run);
  return {
    approval: valid ?? preserved,
    preservedAfterProjectChange: preserved !== undefined,
    currentPlanHash: planArtifact?.sha256 ?? null,
    runContextHash: run.contextHash,
    providerId,
    changedInputs: drift === null ? null : drift.changed,
    ...(drift === null ? {} : { inputHashes: { before: drift.before, after: drift.after } }),
  };
}
