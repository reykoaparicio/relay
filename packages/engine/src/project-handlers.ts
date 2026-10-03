// 06 F1 project handlers: `projects.previewRoot`, `projects.createFromRoot` (idempotent, one indexed root lookup),
// `projects.get`, `projects.update` (an allowance edit re-evaluates `paused(budget_project)` runs), `projects.archive`,
// `projects.unarchive` and `projects.relocateRoot` (E2 #18 / #7).
import { INPUT_CAPS, err, errors, ok, providerPolicySchema } from '@relay/contracts';
import type { PreviewResult, Project, ProjectDetail, Result, RunnerOutputOf } from '@relay/contracts';
import type { Repos } from '@relay/storage';
import type { ProjectRoot } from '@relay/tools';
import { monthWindow } from './clock.js';
import type { ParsedInputOf } from './handler-types.js';
import { requestHash } from './hash.js';
import type { IdempotentRequest } from './idempotency.js';
import { recordResult, replayStoredId } from './idempotency.js';
import type { EngineCtx } from './ports.js';
import { reevaluateProjectBudget } from './run-actions.js';

type RootRelocation = RunnerOutputOf<'relay/v1/projects.relocateRoot'>;

async function openProjectRoot(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/projects.previewRoot'>): Promise<Result<{ root: ProjectRoot; exclusions: string[] }>> {
  if ('rootRealpath' in input) {
    const root = await ctx.projectFs.openRoot(input.rootRealpath);
    return root.ok ? ok({ root: root.value, exclusions: [...input.extraExclusions] }) : root;
  }
  const project = ctx.db.repos.projects.find(input.projectId);
  if (project === undefined) return err(errors.notFound('project'));
  const withRoot = ctx.db.repos.projects.getWithRoot(project.id);
  const root = await ctx.projectFs.openRoot(withRoot.rootRealpath);
  return root.ok ? ok({ root: root.value, exclusions: [...project.exclusions, ...input.extraExclusions] }) : root;
}

export async function previewRoot(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/projects.previewRoot'>): Promise<Result<PreviewResult>> {
  const opened = await openProjectRoot(ctx, input);
  if (!opened.ok) return opened;
  const scan = await ctx.projectFs.scan(opened.value.root, { exclusions: opened.value.exclusions });
  if (!scan.ok) return scan;
  const s = scan.value;
  return ok({
    // E2 #11: a suspected secret stays listed (the user may include it explicitly) with its label and line, never the value.
    included: s.included.map((f) => ({ relPath: f.relPath, sizeBytes: f.size, sha256: f.sha256 ?? null,
      ...(f.suspectedSecret === undefined ? {} : { suspectedSecret: true as const, secretLabel: f.suspectedSecret.label, secretLine: f.suspectedSecret.line }) })),
    excluded: s.excluded.map((e) => ({ relPath: e.relPath as PreviewResult['excluded'][number]['relPath'], reason: e.reason })),
    unreadable: [...s.unreadable], // E2 #8
    totals: { files: s.totals.includedFiles, bytes: s.totals.includedBytes, capBytes: INPUT_CAPS.maxTotalBytes, capFiles: INPUT_CAPS.maxFiles },
  });
}

export async function createFromRoot(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/projects.createFromRoot'>) {
  const req: IdempotentRequest = { op: 'projects.createFromRoot', key: input.idempotencyKey, hash: requestHash({ ...input }) };
  const replay = (r: Repos): Result<Project> | null => {
    const stored = replayStoredId(ctx, r, req, 'projectId', 'project');
    return stored === null || !stored.ok ? stored : ok(r.projects.get(stored.value.id));
  };
  const early = replay(ctx.db.repos);
  if (early !== null) return early;
  const root = await ctx.projectFs.openRoot(input.rootRealpath);
  if (!root.ok) return root;
  return ctx.db.txResult('immediate', (r) => {
    const again = replay(r);
    if (again !== null) return again;
    // 14: one indexed lookup (projects_root_active_uq), not a realpath read per project.
    if (r.projects.findActiveByRoot(root.value.realpath) !== undefined) return err(errors.conflict({ reason: 'root_already_used' }));
    const project = r.projects.insert({
      id: ctx.ids.next('project'), name: input.name, rootRealpath: root.value.realpath, rootDisplayPath: input.rootDisplayPath,
      exclusions: input.exclusions, providerPolicy: providerPolicySchema.parse({ allowedProviderIds: input.allowedProviderIds }),
      monthlyAllowanceMicrousd: input.monthlyAllowanceMicrousd, isDemo: input.isDemo, createdAt: ctx.clock.now(),
    });
    recordResult(r, req, { ids: { projectId: project.id } });
    return ok(project);
  });
}

export function projectDetail(ctx: EngineCtx, projectId: ParsedInputOf<'relay/v1/projects.get'>['projectId']): Result<ProjectDetail> {
  const r = ctx.db.repos;
  const project = r.projects.find(projectId);
  if (project === undefined) return err(errors.notFound('project'));
  return ok({ ...project, stats: r.projects.stats(projectId, monthWindow(ctx.clock.now()).start) });
}

/** `projects.update` (optimistic on `updated_at`); an allowance edit re-evaluates `paused(budget_project)` runs. */
export async function updateProject(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/projects.update'>): Promise<Result<Project>> {
  const { patch } = input;
  const updated = ctx.db.txResult('immediate', (r) => {
    const cur = r.projects.find(input.projectId);
    if (cur === undefined) return err(errors.notFound('project'));
    const policyChanged = patch.allowedProviderIds !== undefined || patch.providerOptions !== undefined;
    const providerPolicy = policyChanged
      ? providerPolicySchema.parse({ allowedProviderIds: patch.allowedProviderIds ?? cur.providerPolicy.allowedProviderIds,
        providerOptions: patch.providerOptions ?? cur.providerPolicy.providerOptions })
      : undefined;
    return r.projects.update(input.projectId, {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.exclusions === undefined ? {} : { exclusions: patch.exclusions }),
      ...(providerPolicy === undefined ? {} : { providerPolicy }),
      ...(patch.monthlyAllowanceMicrousd === undefined ? {} : { monthlyAllowanceMicrousd: patch.monthlyAllowanceMicrousd }),
    }, input.expectedUpdatedAt);
  });
  if (!updated.ok) return updated;
  if (patch.monthlyAllowanceMicrousd !== undefined) await reevaluateProjectBudget(ctx, input.projectId);
  return ok(ctx.db.repos.projects.get(input.projectId));
}

/** `projects.archive`: CONFLICT while the project has an active (non-terminal) run. */
export function archiveProject(ctx: EngineCtx, projectId: ParsedInputOf<'relay/v1/projects.archive'>['projectId']): Result<Project> {
  return ctx.db.txResult('immediate', (r) => {
    const project = r.projects.find(projectId);
    if (project === undefined) return err(errors.notFound('project'));
    const active = r.runs.listActive().filter((run) => run.projectId === projectId).map((run) => run.id);
    if (active.length > 0) return err(errors.conflict({ reason: 'active_run', runIds: active }));
    if (!r.projects.archive(projectId)) return err(errors.conflict({ reason: 'already_archived' }));
    return ok(r.projects.get(projectId));
  });
}

/** `projects.unarchive` (E2 #18): archived → active again; CONFLICT when another active project uses the folder. */
export function unarchiveProject(ctx: EngineCtx, projectId: ParsedInputOf<'relay/v1/projects.unarchive'>['projectId']): Result<Project> {
  return ctx.db.txResult('immediate', (r) => r.projects.unarchive(projectId));
}

/** Files compared when verifying a re-pointed root; mismatches listed in the result. */
const RELOCATE_VERIFY_FILES = 200;
const RELOCATE_MISMATCH_LIST = 20;

/**
 * Round-3 M3: a re-pointed folder counts as the same project only when a clear majority of the known files match —
 * at least half of the checked files AND at least min(3, checked) of them. One shared boilerplate file is not enough.
 */
function isVerifiedRoot(v: { readonly checkedFiles: number; readonly matchedFiles: number }): boolean {
  return v.checkedFiles > 0 && v.matchedFiles * 2 >= v.checkedFiles && v.matchedFiles >= Math.min(3, v.checkedFiles);
}

/**
 * `projects.relocateRoot` (E2 #7): re-points a moved / renamed project. The new folder goes through the same root
 * checks as a new project (`openRoot`), must not be another active project's folder, and is verified by comparing the
 * live hashes of up to 200 previously used files (their newest `run_input_files` hash). Unless a clear majority matches
 * ({@link isVerifiedRoot}) — or with no known file at all — it is CONFLICT `root_unverified` (with
 * `details.verification`) unless `confirm` is set. The verification is returned either way.
 */
export async function relocateRoot(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/projects.relocateRoot'>): Promise<Result<RootRelocation>> {
  const r = ctx.db.repos;
  const project = r.projects.find(input.projectId);
  if (project === undefined) return err(errors.notFound('project'));
  if (project.archivedAt !== null) return err(errors.conflict({ entity: 'project', reason: 'archived' }));
  const root = await ctx.projectFs.openRoot(input.rootRealpath);
  if (!root.ok) return root;
  const other = r.projects.findActiveByRoot(root.value.realpath);
  if (other !== undefined && other.id !== project.id) return err(errors.conflict({ entity: 'project', reason: 'root_already_used' }));
  const known = r.runs.latestProjectInputFiles(project.id, RELOCATE_VERIFY_FILES);
  const live = known.length === 0 ? null : await ctx.projectFs.hashFiles(root.value, known.map((f) => f.relPath));
  if (live !== null && !live.ok) return live;
  const liveBy = new Map((live?.value ?? []).map((h) => [h.relPath as string, h.sha256]));
  const mismatched = known.filter((f) => liveBy.get(f.relPath) !== f.sha256).map((f) => f.relPath);
  const verification = { checkedFiles: known.length, matchedFiles: known.length - mismatched.length, mismatched: mismatched.slice(0, RELOCATE_MISMATCH_LIST) };
  if (!isVerifiedRoot(verification) && input.confirm !== true) {
    return err(errors.conflict({ entity: 'project', reason: 'root_unverified', verification }, {
      userMessage: known.length === 0
        ? 'Relay has no earlier files to compare with this folder. Confirm that it is the same project.'
        : verification.matchedFiles === 0
          ? 'None of the files Relay used before match this folder. Confirm that it is the same project.'
          : `Only ${String(verification.matchedFiles)} of the ${String(known.length)} files Relay used before match this folder. Confirm that it is the same project.`,
    }));
  }
  const moved = ctx.db.txResult('immediate', (tx) => tx.projects.setRoot(project.id, { rootRealpath: root.value.realpath, rootDisplayPath: input.rootDisplayPath }));
  if (!moved.ok) return moved;
  ctx.logger.info('project.root_relocated', { projectId: project.id, checkedFiles: verification.checkedFiles, matchedFiles: verification.matchedFiles });
  return ok({ project: moved.value, verification });
}
