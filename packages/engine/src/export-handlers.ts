// 02 INTERNAL_RUNNER_OPS export/import handlers (05 E5/E7, 06 F17, FR-10): `artifacts.exportTo` (report Markdown /
// concatenated patch), `artifacts.importDiffText` (ADR-015), `projects.exportTo` (JSON bundle, secret-scanned), and
// `ledger.exportTo` (CSV, exact 6-dp USD strings). Writes go through the injected ExportPort (tools `writeExportFile`:
// realpath re-resolution, refusal inside/containing a project root, never overwriting). No credential ever leaves.
import { err, errors, isTerminalRunStatus, looksLikeSecret, ok, patchV1Schema, reportV1Schema } from '@relay/contracts';
import type {
  AppError,
  ArtifactId,
  ExportPart,
  InternalReason,
  ProjectId,
  ReportV1,
  Result,
  RunId,
  RunnerOutputOf,
  ValidationIssue,
} from '@relay/contracts';
import type { LedgerEntryWithStep, Repos, WorkflowVersionRow } from '@relay/storage';
import { monthWindowOf } from './clock.js';
import { fromUtf8, utf8 } from './hash.js';
import type { ParsedInputOf } from './handler-types.js';
import type { EngineCtx, ExportPort } from './ports.js';
import type { FinishedOutput, ReportBody } from './report.js';
import { buildReport, generateReport, renderReportMarkdown, usd6 } from './report.js';
import { snapshotOf } from './snapshot.js';
import { latestPerKey, outputOfKind, toLedgerEntryView, toRunSummary } from './views.js';


/** Max bytes read back from one stored report / patch artifact. */
const MAX_EXPORT_ARTIFACT_BYTES = 16 * 1024 * 1024;

/**
 * INTERNAL via `errors.internal` (closed reason only, 02 §B0). The channel / entity is logged under the same correlation
 * id rather than sent to the renderer, so a bug report still says which one broke.
 */
function internal(ctx: EngineCtx, reason: InternalReason, where: { readonly channel?: string; readonly entity?: string }) {
  const correlationId = ctx.ids.next('correlation');
  ctx.logger.warn('export.internal', { correlationId, reason, ...where });
  return errors.internal(correlationId, reason);
}

function unavailable(ctx: EngineCtx, channel: string) {
  return internal(ctx, 'not_implemented', { channel });
}

function exportPort(ctx: EngineCtx, channel: string): Result<ExportPort> {
  return ctx.exports === undefined ? err(unavailable(ctx, channel)) : ok(ctx.exports);
}

/** Every registered project root (archived included): FR-10 refuses exports inside or containing any of them. */
export function projectRoots(r: Repos): string[] {
  return r.projects.list({ includeArchived: true }).map((p) => r.projects.getWithRoot(p.id).rootRealpath);
}

async function readArtifactText(ctx: EngineCtx, id: ArtifactId, entity: string): Promise<Result<string>> {
  const row = ctx.db.repos.artifacts.get(id);
  if (row === undefined) return err(errors.notFound(entity));
  if (row.purgedAt !== null) return err(errors.notFound(entity, { purged: true }, { details: { purgedAt: row.purgedAt } }));
  const bytes = await ctx.artifacts.read(row.relPath, Math.min(Math.max(row.sizeBytes, 1), MAX_EXPORT_ARTIFACT_BYTES));
  return bytes.ok ? ok(fromUtf8(bytes.value)) : bytes;
}

async function readJson(ctx: EngineCtx, id: ArtifactId, entity: string): Promise<Result<unknown>> {
  const text = await readArtifactText(ctx, id, entity);
  if (!text.ok) return text;
  try {
    return ok(JSON.parse(text.value) as unknown);
  } catch {
    return err(internal(ctx, 'artifact_not_json', { entity }));
  }
}

/** The run's report (generated once if the terminal run lacks one, F17); NOT_FOUND for a run that has not ended. */
async function runReport(ctx: EngineCtx, runId: RunId): Promise<Result<ReportV1>> {
  const r = ctx.db.repos;
  let id = r.artifacts.listForRun(runId, ['report']).at(-1)?.id; // the newest (a late settlement refreshes it)
  if (id === undefined) {
    if (!isTerminalRunStatus(r.runs.get(runId).status)) return err(errors.notFound('report', {}, { details: { reason: 'run_not_terminal' } }));
    const made = await generateReport(ctx, runId);
    if (!made.ok) return made;
    id = made.value;
  }
  const json = await readJson(ctx, id, 'report');
  if (!json.ok) return json;
  const parsed = reportV1Schema.safeParse(json.value);
  return parsed.success ? ok(parsed.data) : err(internal(ctx, 'artifact_invalid', { entity: 'report' }));
}

/**
 * Decision 2: the interim report of a run that has not ended, built in memory from its current state (never stored
 * as the run's report artifact): finished step outputs, costs so far (estimates marked "~"), approvals so far, and the
 * "In progress — exported <time>; N of M steps finished" mark.
 */
async function interimReportMarkdown(ctx: EngineCtx, runId: RunId): Promise<Result<{ text: string; report: ReportBody }>> {
  const r = ctx.db.repos;
  const run = r.runs.get(runId);
  let report: ReportBody;
  try {
    report = buildReport(ctx, r, run);
  } catch {
    return err(internal(ctx, 'artifact_invalid', { entity: 'report' }));
  }
  const snapshot = snapshotOf(run);
  const latest = latestPerKey(r.steps.listForRun(runId));
  const outputs: FinishedOutput[] = [];
  for (const s of latest) {
    const snap = snapshot.steps[s.stepKey];
    if (snap?.kind !== 'model' || s.state !== 'succeeded' || s.outputArtifactId === null) continue;
    const text = await readArtifactText(ctx, s.outputArtifactId, snap.outputKind);
    if (text.ok) outputs.push({ stepKey: s.stepKey, kind: snap.outputKind, artifactId: s.outputArtifactId, json: text.value });
  }
  const finished = latest.filter((s) => s.state === 'succeeded' || s.state === 'skipped').length;
  const text = renderReportMarkdown(report, { exportedAt: ctx.clock.now(), stepsFinished: finished, stepsTotal: latest.length, outputs });
  return ok({ text, report });
}

/** The report part of an export: the stored report of a finished run, or an interim report of a run in progress. */
async function reportMarkdown(ctx: EngineCtx, runId: RunId): Promise<Result<{ text: string; report: ReportBody }>> {
  if (!isTerminalRunStatus(ctx.db.repos.runs.get(runId).status)) return interimReportMarkdown(ctx, runId);
  const rep = await runReport(ctx, runId);
  return rep.ok ? ok({ text: renderReportMarkdown(rep.value), report: rep.value }) : rep;
}

/**
 * The patch a run exports: a finished run's report patch (else its newest patch artifact, as before). P-3: a run in
 * progress exports only its CURRENT patch, as its interim report states it (a superseded or rejected patch — its step
 * re-opened for a revision — is never exported), or none.
 */
function exportedPatchId(ctx: EngineCtx, runId: RunId, report: Pick<ReportV1, 'artifacts'> | null): ArtifactId | undefined {
  const r = ctx.db.repos;
  const run = r.runs.get(runId);
  if (isTerminalRunStatus(run.status)) return report?.artifacts.patch ?? r.artifacts.listForRun(runId, ['patch']).at(-1)?.id;
  if (report !== null) return report.artifacts.patch ?? undefined;
  try {
    return outputOfKind(snapshotOf(run), latestPerKey(r.steps.listForRun(runId)), 'patch') ?? undefined;
  } catch {
    return undefined; // a malformed snapshot: no current patch can be named
  }
}

/** The run's validated patch as one `.patch` text (each file's unified diff, newline-terminated, in order). */
async function runPatchText(ctx: EngineCtx, runId: RunId, report: Pick<ReportV1, 'artifacts'> | null): Promise<Result<string>> {
  const id = exportedPatchId(ctx, runId, report);
  if (id === undefined) return err(errors.notFound('patch'));
  const json = await readJson(ctx, id, 'patch');
  if (!json.ok) return json;
  const parsed = patchV1Schema.safeParse(json.value);
  if (!parsed.success) return err(internal(ctx, 'artifact_invalid', { entity: 'patch' }));
  return ok(parsed.data.files.map((f) => (f.unifiedDiff.endsWith('\n') ? f.unifiedDiff : `${f.unifiedDiff}\n`)).join(''));
}

/**
 * `artifacts.exportTo`: report → Markdown (`.md`), patch → concatenated unified diffs (`.patch`), or both. Decision 2:
 * a run in progress exports too — an interim report of what finished so far (generated in memory, never stored as
 * its report) and the patch when one exists. E2 #10: each
 * part is rendered and written independently; a part that fails (missing / purged artifact, write error) is reported in
 * `failed` with its code while the other part is still written, so the caller retries only the failed part. Only when
 * NOTHING was written is the result an error (the first failure's error, with `details.failed`). A destination refused
 * for every file (inside / containing a project) is that PERMISSION_DENIED, as before.
 */
export async function exportRunArtifacts(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/artifacts.exportTo'>): Promise<Result<RunnerOutputOf<'relay/v1/artifacts.exportTo'>>> {
  const port = exportPort(ctx, 'relay/v1/artifacts.exportTo');
  if (!port.ok) return port;
  const r = ctx.db.repos;
  if (r.runs.find(input.runId) === undefined) return err(errors.notFound('run'));
  const parts: ExportPart[] = input.what === 'both' ? ['report', 'patch'] : [input.what];
  const roots = projectRoots(r);
  const written: { what: ExportPart; realpath: string }[] = [];
  const failed: { what: ExportPart; error: AppError }[] = [];
  let report: Pick<ReportV1, 'artifacts'> | null = null;
  // The run itself is never touched (§17.1 retry only export).
  for (const what of parts) {
    let file: Result<{ name: string; text: string }>;
    if (what === 'report') {
      const rep = await reportMarkdown(ctx, input.runId);
      if (rep.ok) report = rep.value.report;
      file = rep.ok ? ok({ name: `relay-report-${input.runId}.md`, text: rep.value.text }) : rep;
    } else {
      const patch = await runPatchText(ctx, input.runId, report);
      file = patch.ok ? ok({ name: `relay-patch-${input.runId}.patch`, text: patch.value }) : patch;
    }
    if (!file.ok) {
      failed.push({ what, error: file.error });
      continue;
    }
    const w = await port.value.writeFile(input.destinationRealpath, file.value.name, utf8(file.value.text), roots);
    if (w.ok) written.push({ what, realpath: w.value.writtenRealpath });
    else failed.push({ what, error: w.error });
  }
  const failedOut = failed.map((f) => ({ what: f.what, code: f.error.code, userMessage: f.error.userMessage }));
  const first = failed[0];
  if (written.length === 0 && first !== undefined) {
    return err({ ...first.error, details: { ...first.error.details, failed: failedOut } });
  }
  return ok({ writtenRealpaths: written.map((w) => w.realpath), written, ...(failed.length === 0 ? {} : { failed: failedOut }) });
}

/**
 * `artifacts.importDiffText` (05 E5, ADR-015): parse (size cap, every path normalized), check every referenced path
 * against the project (excluded / outside-root → PERMISSION_DENIED), then store the text as a project-scoped
 * `input_diff` artifact. Returns the files it touches and the parse warnings.
 */
export async function importDiffText(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/artifacts.importDiffText'>): Promise<Result<RunnerOutputOf<'relay/v1/artifacts.importDiffText'>>> {
  const r = ctx.db.repos;
  const project = r.projects.find(input.projectId);
  if (project === undefined) return err(errors.notFound('project'));
  const diff = ctx.projectFs.parseDiff(input.text);
  if (!diff.ok) return diff;
  const root = await ctx.projectFs.openRoot(r.projects.getWithRoot(project.id).rootRealpath);
  if (!root.ok) return root;
  const checked = await ctx.projectFs.checkDiffPaths(root.value, diff.value, { exclusions: project.exclusions });
  if (!checked.ok) return checked;
  const id = ctx.ids.next('artifact');
  const put = await ctx.artifacts.put({ scopeDir: `artifacts/${project.id}`, artifactId: id, bytes: utf8(input.text), mediaType: 'text/x-diff; charset=utf-8' });
  if (!put.ok) return put;
  const row = ctx.db.tx('immediate', (tx) => tx.artifacts.insertIfAbsent({ id, runId: null, projectId: project.id, kind: 'input_diff',
    relPath: put.value.relPath, sha256: put.value.sha256, sizeBytes: put.value.sizeBytes,
    mediaType: 'text/x-diff; charset=utf-8', createdAt: ctx.clock.now() }));
  const files = [...new Set(diff.value.files.map((f) => f.newPath ?? f.oldPath).filter((p): p is NonNullable<typeof p> => p !== null))];
  return ok({ artifactId: row.id, files, parseWarnings: [...diff.value.warnings] });
}

// ---------------------------------------------------------------- projects.exportTo

/** Every string (keys included) of a JSON value that looks like a credential, with its JSON path. */
export function findSecrets(value: unknown, path = ''): ValidationIssue[] {
  if (typeof value === 'string') {
    return looksLikeSecret(value) ? [{ path: path === '' ? '(root)' : path, message: 'This value looks like a credential.', code: 'secret_detected' }] : [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecrets(v, `${path}[${String(i)}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => {
      const p = path === '' ? k : `${path}.${k}`;
      return [...(looksLikeSecret(k) ? [{ path: p, message: 'This key looks like a credential.', code: 'secret_detected' }] : []), ...findSecrets(v, p)];
    });
  }
  return [];
}

/** The workflow versions the exported runs used, plus each workflow's latest validated version (each read once). */
function workflowVersions(r: Repos, runVersionIds: readonly WorkflowVersionRow['id'][]) {
  const versions = new Map<string, WorkflowVersionRow>();
  for (const id of new Set(runVersionIds)) {
    const v = r.workflows.getVersionById(id);
    if (v !== undefined) versions.set(v.id, v);
  }
  const workflows = r.workflows.listWorkflows();
  for (const w of workflows) {
    const v = r.workflows.latestValidated(w.id);
    if (v !== undefined) versions.set(v.id, v);
  }
  const names = new Map<string, string>(workflows.map((w) => [w.id, w.name]));
  return [...versions.values()].map((v) => ({
    id: v.id, workflowId: v.workflowId, name: names.get(v.workflowId) ?? null, version: v.version, status: v.status,
    contentHash: v.contentHash, spec: v.spec, prompts: v.prompts, createdAt: v.createdAt,
  }));
}

const ledgerViews = (rows: readonly LedgerEntryWithStep[]) => rows.map(({ entry, stepKey }) => toLedgerEntryView(entry, stepKey));

/** Builds the project bundle (02 `projects.export`): no realpath, no credential refs, no raw provider responses. */
async function projectBundle(ctx: EngineCtx, projectId: ProjectId, runIds: readonly RunId[]): Promise<Result<unknown>> {
  const r = ctx.db.repos;
  const project = r.projects.get(projectId);
  const memory = r.memory.list({ projectId, statuses: ['suggested', 'approved', 'archived', 'rejected'] }).map((m) => {
    const full = r.memory.getWithRevisions(m.record.id);
    return { record: m.record, revisions: full?.revisions ?? [m.current], events: full?.events ?? [] };
  });
  // Every run summary in 4 statements (2), not one inspector projection per run.
  const summaries = r.runs.summariesOf(runIds);
  const runs = [];
  for (const s of summaries) {
    const { run } = s;
    const hasReport = isTerminalRunStatus(run.status) || r.artifacts.listForRun(run.id, ['report']).length > 0;
    const report = hasReport ? await runReport(ctx, run.id) : null;
    if (report !== null && !report.ok) return report;
    const patch = await runPatchText(ctx, run.id, report?.value ?? null);
    if (!patch.ok && patch.error.code !== 'NOT_FOUND') return patch;
    runs.push({
      summary: toRunSummary(s),
      input: run.input,
      limits: run.limits,
      report: report?.value ?? null,
      patch: patch.ok ? patch.value : null,
      ledger: ledgerViews(r.ledger.listForRun(run.id)),
    });
  }
  return ok({
    format: 'relay.project-export',
    formatVersion: 1,
    exportedAt: new Date(ctx.clock.now()).toISOString(),
    project: {
      id: project.id, name: project.name, exclusions: project.exclusions, providerPolicy: project.providerPolicy,
      monthlyAllowanceMicrousd: project.monthlyAllowanceMicrousd, isDemo: project.isDemo, createdAt: project.createdAt,
      updatedAt: project.updatedAt, archivedAt: project.archivedAt,
    },
    memory,
    workflows: workflowVersions(r, summaries.map((x) => x.run.workflowVersionId)),
    runs,
  });
}

/** `projects.exportTo`: the JSON bundle, refused (VALIDATION_FAILED) when any string in it looks like a credential. */
export async function exportProject(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/projects.exportTo'>): Promise<Result<RunnerOutputOf<'relay/v1/projects.exportTo'>>> {
  const port = exportPort(ctx, 'relay/v1/projects.exportTo');
  if (!port.ok) return port;
  const r = ctx.db.repos;
  const project = r.projects.find(input.projectId);
  if (project === undefined) return err(errors.notFound('project'));
  const runIds = input.runIds === undefined ? r.runs.idsForProject(project.id) : [...new Set(input.runIds)];
  if (runIds.some((id) => r.runs.find(id)?.projectId !== project.id)) return err(errors.notFound('run'));
  const bundle = await projectBundle(ctx, project.id, runIds);
  if (!bundle.ok) return bundle;
  const secrets = findSecrets(bundle.value);
  if (secrets.length > 0) {
    ctx.logger.warn('export.secret_refused', { projectId: project.id, paths: secrets.map((s) => s.path).slice(0, 20) });
    return err(errors.validationFailed(secrets.slice(0, 50), { userMessage: 'The export was not written: it contains text that looks like a credential.' }));
  }
  const w = await port.value.writeFile(input.destinationRealpath, `relay-project-${project.id}.json`, utf8(`${JSON.stringify(bundle.value, null, 2)}\n`), projectRoots(r));
  return w.ok ? ok({ writtenRealpath: w.value.writtenRealpath }) : w;
}

// ---------------------------------------------------------------- ledger.exportTo

/** The CSV header (02 `ledger.export`, §5.6). */
export const LEDGER_CSV_HEADER = ['created_at', 'run', 'step', 'attempt', 'type', 'bucket', 'delta_usd', 'certainty', 'price_catalog_version'] as const;

/** RFC 4180 field: quoted when it holds a comma, quote, or line break. */
function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** One CSV row per entry (RFC 4180, CRLF line ends); `delta_usd` is the exact 6-dp string, never a float. */
export function ledgerCsv(rows: readonly LedgerEntryWithStep[]): string {
  const lines = [LEDGER_CSV_HEADER.join(',')];
  for (const { entry: e, stepKey } of rows) {
    lines.push([new Date(e.createdAt).toISOString(), e.runId ?? '', stepKey ?? '', e.attemptId ?? '', e.type, e.bucket,
      usd6(e.deltaMicrousd), e.certainty ?? '', e.priceCatalogVersion ?? ''].map(csvField).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** `ledger.exportTo`: one run's entries, or every run entry of a project created in the month (oldest first). */
export async function exportLedger(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/ledger.exportTo'>): Promise<Result<RunnerOutputOf<'relay/v1/ledger.exportTo'>>> {
  const port = exportPort(ctx, 'relay/v1/ledger.exportTo');
  if (!port.ok) return port;
  const r = ctx.db.repos;
  let rows: readonly LedgerEntryWithStep[];
  let name: string;
  if ('runId' in input) {
    if (r.runs.find(input.runId) === undefined) return err(errors.notFound('run'));
    rows = r.ledger.listForRun(input.runId);
    name = `relay-ledger-${input.runId}.csv`;
  } else {
    if (r.projects.find(input.projectId) === undefined) return err(errors.notFound('project'));
    const { start, end } = monthWindowOf(input.month);
    // One statement (4): every run entry of the project in the month, oldest first (`created_at, id`).
    rows = r.ledger.listForProjectWindow(input.projectId, start, end);
    name = `relay-ledger-${input.projectId}-${input.month}.csv`;
  }
  const w = await port.value.writeFile(input.destinationRealpath, name, utf8(ledgerCsv(rows)), projectRoots(r));
  return w.ok ? ok({ writtenRealpath: w.value.writtenRealpath }) : w;
}
