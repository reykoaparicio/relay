// 06 F1 project handlers: `projects.previewRoot`, `projects.createFromRoot` (idempotent, one indexed root lookup),
// `projects.get`, `projects.update` (an allowance edit re-evaluates `paused(budget_project)` runs), `projects.archive`.
import { INPUT_CAPS, err, errors, ok, providerPolicySchema } from '@relay/contracts';
import type { PreviewResult, Project, ProjectDetail, Result } from '@relay/contracts';
import type { Repos } from '@relay/storage';
import type { ProjectRoot } from '@relay/tools';
import { monthWindow } from './clock.js';
import type { ParsedInputOf } from './handler-types.js';
import { requestHash } from './hash.js';
import type { IdempotentRequest } from './idempotency.js';
import { recordResult, replayStoredId } from './idempotency.js';
import type { EngineCtx } from './ports.js';
import { reevaluateProjectBudget } from './run-actions.js';

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
    included: s.included.map((f) => ({ relPath: f.relPath, sizeBytes: f.size, sha256: f.sha256 ?? null })),
    excluded: s.excluded.map((e) => ({ relPath: e.relPath as PreviewResult['excluded'][number]['relPath'], reason: e.reason })),
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
