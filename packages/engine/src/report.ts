// 06 F17: the run report. `generateReport` builds a `report.v1` object on every terminal transition (post-commit
// effect), stores it as a `report` artifact (canonical JSON, never redacted), and appends `report.created`.
// Idempotent: an existing report artifact is returned. `renderReportMarkdown` is the pure Markdown view used by
// `artifacts.exportTo` (`what: 'report'`).
import { REVIEW_OUTCOMES, err, errors, invariant, isTerminalRunStatus, ok, redactString, reportV1Schema } from '@relay/contracts';
import type { ArtifactId, Microusd, ReportV1, Result, ReviewOutcome, RunId, RunStatus, StepKey, TerminalRunStatus } from '@relay/contracts';
import type { LedgerEntryRow, Repos, RunRow, StepRow } from '@relay/storage';
import type { ReportLimitationKey } from '@relay/templates';
import { canonicalJson, utf8 } from './hash.js';
import type { EngineCtx, ModelStepSnapshot, RunSnapshot } from './ports.js';
import type { PostCommitEffect } from './run-machine.js';
import { appendRunEvent, runEffects } from './run-machine.js';
import { effectiveModelSteps, hasSnapshotPreserved, snapshotOf } from './snapshot.js';
import { attemptCostCertainty, costOfEntries, outputOfKind, entriesByStep, latestPerKey, netSettledCertainties, weakestCertainty } from './views.js';

/**
 * A step's cost over its attempts' ledger entries: settled and unknown from {@link costOfEntries}; the certainty is
 * `unknown` while a (legacy) unknown liability is open, else the weakest certainty still carrying a settled amount
 * (`calculated` when nothing settled; a corrected estimate no longer counts) — the same ordering as the attempt views.
 */
export function stepCost(entries: readonly LedgerEntryRow[]): ReportV1['steps'][number]['cost'] {
  const cost = costOfEntries(entries);
  const settled = (cost.settledReported + cost.settledCalculated + cost.settledEstimated) as Microusd;
  const unknownSettled = entries.filter((e) => e.bucket === 'settled' && e.certainty === 'unknown').reduce((n, e) => n + e.deltaMicrousd, 0);
  const certainty = cost.unknown > 0 ? 'unknown' : (weakestCertainty(netSettledCertainties(entries.filter((e) => e.bucket === 'settled'))) ?? 'calculated');
  return { settledMicrousd: (settled + unknownSettled) as Microusd, certainty, unknownMicrousd: cost.unknown };
}

/** The net `estimated` settled amount of one attempt (0 once a correction replaced its estimate). */
function estimatedLeft(entries: readonly LedgerEntryRow[], attemptId: string): number {
  return entries.reduce((n, e) => (e.attemptId === attemptId && e.bucket === 'settled' && e.certainty === 'estimated' ? n + e.deltaMicrousd : n), 0);
}

function verdictOf(snapshot: RunSnapshot, latest: readonly StepRow[]): ReviewOutcome | null {
  const verify = latest.filter((s) => {
    const snap = snapshot.steps[s.stepKey];
    return snap?.kind === 'model' && snap.outputSchema === 'review.v1' && s.state === 'succeeded';
  }).at(-1);
  const o = verify?.outcome;
  return o !== undefined && o !== null && (REVIEW_OUTCOMES as readonly string[]).includes(o) ? (o as ReviewOutcome) : null;
}

function limitationKeys(status: RunStatus, verifyRan: boolean, totals: ReportV1['totals']): ReportLimitationKey[] {
  const keys: ReportLimitationKey[] = ['patch_not_applied', 'tests_not_run'];
  if (verifyRan) keys.push('model_checks_only');
  keys.push('cost_tracked');
  if (totals.hasEstimates || totals.unknown > 0) keys.push('cost_estimated');
  if (status === 'incomplete') keys.push('run_incomplete');
  if (status === 'cancelled') keys.push('run_cancelled');
  if (status === 'failed') keys.push('run_failed');
  return keys;
}

/** The provider/model of a step from the effective model steps (both null for a non-model step). */
function modelOf(models: ReadonlyMap<StepKey, ModelStepSnapshot>, stepKey: StepKey): Pick<ReportV1['steps'][number], 'providerId' | 'modelId'> {
  const s = models.get(stepKey);
  return s === undefined ? { providerId: null, modelId: null } : { providerId: s.profile.providerId, modelId: s.profile.modelId };
}

/** A report body: `report.v1` of any run status (a non-terminal run's is an interim report, never stored). */
export type ReportBody = Omit<ReportV1, 'status'> & { readonly status: RunStatus };

/**
 * Builds the report value of a run (pure over the repos): the snapshot is parsed once and the ledger and attempts
 * are read once, then grouped per step key. A terminal run's value is its `report.v1`; a non-terminal run's is the
 * interim report of what finished so far (decision 2), generated in memory for an export only.
 * @throws SnapshotError when the stored snapshot is malformed; invariant when an FK-bound row is missing.
 */
export function buildReport<S extends RunStatus>(ctx: Pick<EngineCtx, 'templates' | 'clock'>, r: Repos, run: RunRow & { status: S }): ReportBody & { readonly status: S } {
  const version = r.workflows.getVersionById(run.workflowVersionId);
  invariant(version !== undefined, 'a run references its workflow version (FK)');
  const snapshot = snapshotOf(run);
  const models = effectiveModelSteps(r, run, snapshot);
  const all = r.steps.listForRun(run.id);
  const latest = latestPerKey(all);
  const stepKeyOf = new Map(all.map((s) => [s.id, s.stepKey]));
  const keyOf = (stepRunId: StepRow['id']): StepKey => {
    const key = stepKeyOf.get(stepRunId);
    invariant(key !== undefined, 'an attempt / approval references a step row of its own run (FK)');
    return key;
  };
  const names = new Map(version.spec.steps.flatMap((s) => (s.name === undefined ? [] : [[s.id, s.name] as const])));
  const attempts = r.attempts.listForRun(run.id);
  const ledger = r.ledger.listForRun(run.id);
  const entries = ledger.map((x) => x.entry);
  const byStep = entriesByStep(ledger);
  const verdict = verdictOf(snapshot, latest);
  const texts = ctx.templates.reportLimitations();
  // Legacy unknown liabilities (none since decision 1: converted to estimates at engine start).
  const liabilities = attempts.filter((a) => a.state === 'unknown' || a.state === 'abandoned').flatMap((a) => {
    const u = entries.reduce((n, e) => (e.attemptId === a.id && e.bucket === 'unknown' ? n + e.deltaMicrousd : n), 0) as Microusd;
    return u > 0 ? [{ attemptId: a.id, stepKey: keyOf(a.stepRunId), liabilityMicrousd: u, state: a.state === 'unknown' ? ('unknown' as const) : ('abandoned' as const) }] : [];
  });
  // Decision 1: uncertain outcomes settled as estimates and not corrected since. D1-2: only attempts with an estimated
  // amount left (a correction, even to $0, removes the attempt from the list).
  const estimatedCharges = attempts.filter((a) => a.outcomeUncertain && attemptCostCertainty(entries, a.id) === 'estimated'
    && estimatedLeft(entries, a.id) > 0).map((a) => ({
    attemptId: a.id, stepKey: keyOf(a.stepRunId), mayNotHaveBeenCharged: a.mayNotHaveBeenCharged,
    amountMicrousd: entries.reduce((n, e) => (e.attemptId === a.id && e.bucket === 'settled' ? n + e.deltaMicrousd : n), 0) as Microusd,
  }));
  const totals = costOfEntries(entries);
  return {
    schemaId: 'report.v1',
    runId: run.id,
    projectId: run.projectId,
    goal: run.goal,
    status: run.status,
    verdict,
    workflow: { id: version.workflowId, version: version.version, contentHash: snapshot.workflowContentHash },
    steps: latest.map((s) => ({ stepKey: s.stepKey, revisionIndex: s.revisionIndex, retryIndex: s.retryIndex, state: s.state, profileName: s.profileName,
      ...modelOf(models, s.stepKey), cost: stepCost(byStep.get(s.stepKey) ?? []) })),
    totals,
    unknownLiabilities: liabilities,
    estimatedCharges,
    artifacts: {
      findings: outputOfKind(snapshot, latest, 'findings'),
      plan: outputOfKind(snapshot, latest, 'plan'),
      patch: outputOfKind(snapshot, latest, 'patch'),
      review: outputOfKind(snapshot, latest, 'review'),
    },
    limitations: limitationKeys(run.status, verdict !== null, totals).map((k) => texts[k]),
    snapshotUsed: hasSnapshotPreserved(r, run.id),
    generatedAt: ctx.clock.now(),
    approvals: r.approvals.listForRun(run.id).map((a) => ({
      approvalId: a.id, stepKey: keyOf(a.stepRunId), planArtifactId: a.planArtifactId,
      planHash: a.planHash, decision: a.decision, decidedAt: a.decidedAt, note: a.decisionNote, invalidatedReason: a.invalidatedReason, createdAt: a.createdAt,
    })),
    revisions: revisionsOf(run, snapshot, all),
    stepMeta: latest.map((s) => ({ stepKey: s.stepKey, name: names.get(s.stepKey) ?? null, instructionVersion: models.get(s.stepKey)?.instructionVersion ?? null })),
  };
}

/** F17 revision summary: quality cycles vs the limit, plan re-dos (request_revision / replan), and the incomplete cause. */
function revisionsOf(run: RunRow, snapshot: RunSnapshot, all: readonly StepRow[]): NonNullable<ReportV1['revisions']> {
  const planRevisions = all.filter((s) => {
    const snap = snapshot.steps[s.stepKey];
    return snap?.kind === 'model' && snap.outputKind === 'plan' && s.revisionIndex > 0 && s.retryIndex === 0;
  }).length;
  const cause = run.status === 'incomplete' ? run.statusDetail?.details?.['incompleteCause'] : undefined;
  return {
    cycles: run.revisionCycle,
    maxCycles: run.limits.maxRevisionCycles,
    planRevisions,
    incompleteCause: cause === 'revision_limit' || cause === 'verifier_incomplete' ? cause : null,
  };
}

/** Builds, validates and stores a report of the terminal `runId` (outside any tx). Returns the stored artifact's id + location. */
async function writeReport(ctx: EngineCtx, r: Repos, run: RunRow & { status: TerminalRunStatus }) {
  const report = reportV1Schema.safeParse(buildReport(ctx, r, run));
  const correlationId = ctx.ids.next('correlation');
  if (!report.success) {
    ctx.logger.error('report.invalid', { runId: run.id, correlationId });
    return err(errors.internal(correlationId));
  }
  const id = ctx.ids.next('artifact');
  const put = await ctx.artifacts.put({ scopeDir: `artifacts/${run.id}`, artifactId: id, bytes: utf8(canonicalJson(report.data)), mediaType: 'application/json' });
  if (!put.ok) return put;
  return ok({ id, put: put.value });
}

/** F17: generates (once) the report artifact of a terminal run. */
export async function generateReport(ctx: EngineCtx, runId: RunId): Promise<Result<ArtifactId>> {
  const r = ctx.db.repos;
  const existing = r.artifacts.listForRun(runId, ['report']).at(-1);
  if (existing !== undefined) return ok(existing.id);
  const run = r.runs.get(runId);
  if (!isTerminalRunStatus(run.status)) return err(errors.conflict({ reason: 'run_not_terminal' }));
  const written = await writeReport(ctx, r, { ...run, status: run.status });
  if (!written.ok) return written;
  const { id, put } = written.value;
  const fx: PostCommitEffect[] = [];
  const row = ctx.db.tx('immediate', (tx) => {
    const raced = tx.artifacts.listForRun(runId, ['report']).at(-1); // another caller (terminal effect / start sweep) won: keep one report
    if (raced !== undefined) return raced;
    const art = tx.artifacts.insertIfAbsent({ id, runId, projectId: run.projectId, kind: 'report', relPath: put.relPath,
      sha256: put.sha256, sizeBytes: put.sizeBytes, mediaType: 'application/json', schemaId: 'report.v1', createdAt: ctx.clock.now() });
    appendRunEvent(tx, fx, runId, 'report.created', { artifactId: art.id });
    return art;
  });
  await runEffects(ctx, fx);
  return ok(row.id);
}

/**
 * Round-3 M5: a settlement on a FINISHED run (a late `runs.decideUnknown`, or background reconciliation of one of its
 * unknown attempts) changes the costs its report states. The report is immutable, so a NEW report artifact is stored
 * (the run detail and export read the newest one) and `report.created` is appended, so the UI refreshes. A run that
 * is not terminal (or has no report yet: the terminal effect / start sweep writes the first one) is left alone.
 * Never throws; a failure is logged and the previous report stays.
 */
export async function refreshReport(ctx: EngineCtx, runId: RunId): Promise<Result<ArtifactId | null>> {
  try {
    const r = ctx.db.repos;
    const run = r.runs.get(runId);
    if (!isTerminalRunStatus(run.status)) return ok(null);
    if (r.artifacts.listForRun(runId, ['report']).length === 0) return await generateReport(ctx, runId);
    const written = await writeReport(ctx, r, { ...run, status: run.status });
    if (!written.ok) {
      ctx.logger.warn('report.refresh_failed', { runId, code: written.error.code });
      return written;
    }
    const { id, put } = written.value;
    const fx: PostCommitEffect[] = [];
    ctx.db.tx('immediate', (tx) => {
      const art = tx.artifacts.insertIfAbsent({ id, runId, projectId: run.projectId, kind: 'report', relPath: put.relPath,
        sha256: put.sha256, sizeBytes: put.sizeBytes, mediaType: 'application/json', schemaId: 'report.v1', createdAt: ctx.clock.now() });
      appendRunEvent(tx, fx, runId, 'report.created', { artifactId: art.id, refreshed: true });
    });
    await runEffects(ctx, fx);
    return ok(id);
  } catch (e) {
    const correlationId = ctx.ids.next('correlation');
    ctx.logger.error('report.refresh_threw', { runId, correlationId, err: e instanceof Error ? e.name : 'unknown' });
    return err(errors.internal(correlationId));
  }
}

/** The cost-bearing parts of a report (what a late settlement changes), as canonical JSON for comparison. */
function costFingerprint(x: Pick<ReportV1, 'totals' | 'estimatedCharges' | 'unknownLiabilities' | 'steps'>): string {
  return canonicalJson({ totals: x.totals, estimatedCharges: x.estimatedCharges ?? [], unknownLiabilities: x.unknownLiabilities ?? [],
    steps: x.steps.map((s) => [s.stepKey, s.cost]) });
}

/**
 * D1-4: whether the newest stored report of a terminal run predates its ledger — its totals, estimated charges, legacy
 * liabilities or step costs differ from what the ledger says now (a crash between a cost change — the legacy
 * conversion, a reconciliation — and the report refresh). False when there is nothing to compare (no report, an
 * unreadable or invalid one: never refreshed in a loop).
 */
export async function isReportStale(ctx: EngineCtx, runId: RunId): Promise<boolean> {
  const r = ctx.db.repos;
  const run = r.runs.get(runId);
  if (!isTerminalRunStatus(run.status)) return false;
  const row = r.artifacts.listForRun(runId, ['report']).at(-1);
  if (row === undefined) return false;
  const bytes = await ctx.artifacts.read(row.relPath, Math.max(row.sizeBytes, 1));
  if (!bytes.ok) return false;
  let stored: unknown;
  try {
    stored = JSON.parse(new TextDecoder().decode(bytes.value));
  } catch {
    return false;
  }
  const parsed = reportV1Schema.safeParse(stored);
  if (!parsed.success) return false;
  return costFingerprint(parsed.data) !== costFingerprint(buildReport(ctx, r, { ...run, status: run.status }));
}

/**
 * F1 step 3 / F17 crash-safety: at `engine.start()` every terminal run without a `report` artifact gets one (a crash
 * between the terminal commit and the post-commit report effect). Idempotent: a run that has a report is not listed,
 * and {@link generateReport} keeps exactly one. Returns the runs that got a report now.
 */
export async function regenerateMissingReports(ctx: EngineCtx): Promise<RunId[]> {
  const done: RunId[] = [];
  for (const run of ctx.db.repos.runs.listTerminalWithoutReport()) {
    const res = await generateReport(ctx, run.id);
    if (res.ok) done.push(run.id);
    else ctx.logger.warn('report.regenerate_failed', { runId: run.id, code: res.error.code });
  }
  if (done.length > 0) ctx.logger.info('report.regenerated', { runs: done.length });
  return done;
}

// ---------------------------------------------------------------- Markdown (artifacts.exportTo)

/** Exact µUSD → `"0.012345"` dollars (6 dp, integer arithmetic only; never a float). */
export function usd6(m: number): string {
  const abs = BigInt(Math.abs(m));
  const s = `${(abs / 1_000_000n).toString()}.${(abs % 1_000_000n).toString().padStart(6, '0')}`;
  return m < 0 ? `-${s}` : s;
}

const money = (m: number): string => `$${usd6(m)}`;

/** One Markdown table cell: pipes escaped, line breaks flattened. */
function cell(v: string | number | null): string {
  return v === null ? '—' : String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Free text as a Markdown blockquote (every line quoted, so it cannot open headings or fences of its own). */
function quote(text: string): string {
  return text.split(/\r?\n/).map((l) => `> ${l}`).join('\n');
}

/** Exported alongside every report: Relay never writes to the project (FR-10). */
export const REPORT_UNTOUCHED_NOTE = 'Original project files were not modified.';

const DECISION_TEXT: Readonly<Record<string, string>> = { approved: 'approved', rejected: 'rejected', revision_requested: 'revision requested' };

/** Approval decisions as a table (absent in a pre-wave-4 report → "Not recorded."). */
function approvalLines(approvals: ReportV1['approvals']): string[] {
  if (approvals === undefined) return ['Not recorded in this report.'];
  if (approvals.length === 0) return ['No approval was requested.'];
  return [
    '| Step | Approval | Plan hash | Decision | Decided | Invalidated | Note |',
    '|---|---|---|---|---|---|---|',
    ...approvals.map((a) => `| ${[a.stepKey, a.approvalId, a.planHash.slice(0, 12), a.decision === null ? 'not decided' : DECISION_TEXT[a.decision] ?? a.decision,
      a.decidedAt === null ? null : new Date(a.decidedAt).toISOString(), a.invalidatedReason, a.note].map(cell).join(' | ')} |`),
  ];
}

/** Revision cycles (absent in a pre-wave-4 report → "Not recorded."). */
function revisionLines(rv: ReportV1['revisions']): string[] {
  if (rv === undefined) return ['Not recorded in this report.'];
  const cause = rv.incompleteCause === 'revision_limit' ? 'the revision limit was reached'
    : rv.incompleteCause === 'verifier_incomplete' ? 'the verifier reported the work incomplete' : null;
  return [
    `- Quality revision cycles: ${String(rv.cycles)} of ${String(rv.maxCycles)}`,
    `- Plan revisions (requested changes or re-plans): ${String(rv.planRevisions)}`,
    ...(cause === null ? [] : [`- Ended incomplete because ${cause}`]),
  ];
}

/** Decision 1: an estimated amount reads "~$X (estimated)"; any other amount "$X". */
function costText(m: number, estimated: boolean): string {
  return estimated ? `~${money(m)} (estimated)` : money(m);
}

/** A total that includes estimates is marked "~" (decision 1). */
const approx = (m: number, estimated: boolean): string => (estimated ? `~${money(m)}` : money(m));

/** One step's cost cell: the settled amount (~ when estimated) and a legacy unknown liability if one is open. */
function stepCostCell(c: ReportV1['steps'][number]['cost']): string {
  const settled = costText(c.settledMicrousd, c.certainty === 'estimated');
  return c.unknownMicrousd > 0 ? `${settled} + up to ${money(c.unknownMicrousd)} unknown` : settled;
}

/** Decision 1: uncertain outcomes settled as estimates, with the "may not have been charged" note. */
function estimatedChargeLines(report: Pick<ReportV1, 'estimatedCharges'>): string[] {
  const list = report.estimatedCharges ?? [];
  if (list.length === 0) return ['None.'];
  return list.map((c) => `- ${c.stepKey} attempt ${c.attemptId}: ${costText(c.amountMicrousd, true)} — the outcome was uncertain${c.mayNotHaveBeenCharged ? '; may not have been charged' : ''}`);
}

/** Legacy unknown liabilities (reports from before decision 1); the section is omitted when there are none. */
function legacyUnknownLines(report: Pick<ReportV1, 'unknownLiabilities'>): string[] {
  const list = report.unknownLiabilities ?? [];
  if (list.length === 0) return [];
  return ['## Unknown charges', '', ...list.map((u) => `- ${u.stepKey} attempt ${u.attemptId} (${u.state}): up to ${money(u.liabilityMicrousd)} may have been charged`), ''];
}

/** A finished step output included in an interim export (decision 2). */
export interface FinishedOutput {
  readonly stepKey: StepKey;
  readonly kind: string;
  readonly artifactId: ArtifactId;
  /** Canonical JSON text of the validated output. */
  readonly json: string;
}

/** Decision 2: what marks an interim (in-progress) export. */
export interface InterimMark {
  readonly exportedAt: number;
  readonly stepsFinished: number;
  readonly stepsTotal: number;
  readonly outputs: readonly FinishedOutput[];
}

/** A fence longer than any backtick run in `text`, so the text can never close it. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** P-4: a finished output in an export is redacted like every other text leaving Relay (a model may echo a secret). */
function outputLines(outputs: readonly FinishedOutput[]): string[] {
  if (outputs.length === 0) return ['No step has finished with an output yet.', ''];
  return outputs.flatMap((o) => {
    const pretty = redactString((() => {
      try {
        return JSON.stringify(JSON.parse(o.json), null, 2);
      } catch {
        return o.json;
      }
    })());
    const fence = fenceFor(pretty);
    return [`### ${o.stepKey} — ${o.kind} (${o.artifactId})`, '', `${fence}json`, pretty, fence, ''];
  });
}

/**
 * F17: the pure Markdown rendering of a report (limitations, estimated charges, certainty breakdown). Decision 1: an
 * estimated amount reads "~$X (estimated)" with the "may not have been charged" note, and totals that include
 * estimates are marked "~". Decision 2: `interim` renders an in-progress export ("In progress — exported <time>; N of M
 * steps finished") with the finished step outputs.
 */
export function renderReportMarkdown(report: ReportBody, interim?: InterimMark): string {
  const t = report.totals;
  const est = t.hasEstimates;
  const settledTotal = t.settledReported + t.settledCalculated + t.settledEstimated;
  const lines: string[] = [
    interim === undefined ? `# Relay run report — ${report.runId}` : `# Relay run report (in progress) — ${report.runId}`,
    '',
    ...(interim === undefined
      ? []
      : [`> In progress — exported ${new Date(interim.exportedAt).toISOString()}; ${String(interim.stepsFinished)} of ${String(interim.stepsTotal)} steps finished`, '']),
    `- Status: ${report.status}`,
    `- Verdict: ${report.verdict ?? 'not reviewed'}`,
    `- Workflow: ${report.workflow.id} v${String(report.workflow.version)} (${report.workflow.contentHash})`,
    `- Project: ${report.projectId}`,
    `- Generated: ${new Date(report.generatedAt).toISOString()}`,
    ...(report.snapshotUsed ? ['- Input: the preserved snapshot was used after the project changed'] : []),
    '',
    '## Goal',
    '',
    quote(report.goal),
    '',
    '## Steps',
    '',
    '| Step | Revision | Retry | State | Profile | Model | Instructions | Cost (USD) | Certainty |',
    '|---|---|---|---|---|---|---|---|---|',
    ...report.steps.map((s) => {
      const meta = report.stepMeta?.find((m) => m.stepKey === s.stepKey);
      const label = meta?.name == null ? s.stepKey : `${meta.name} (${s.stepKey})`;
      return `| ${[label, s.revisionIndex, s.retryIndex, s.state, s.profileName,
      s.providerId === null ? null : `${s.providerId}/${s.modelId ?? '?'}`, meta?.instructionVersion ?? null, stepCostCell(s.cost), s.cost.certainty].map(cell).join(' | ')} |`;
    }),
    '',
    '## Cost (tracked by Relay)',
    '',
    `- Run allowance: ${money(t.allowance)}`,
    `- Total so far: ${approx(settledTotal, est)}${est ? ' (includes estimates)' : ''}`,
    `- Settled, provider-reported: ${money(t.settledReported)}`,
    `- Settled, calculated from usage: ${money(t.settledCalculated)}`,
    `- Settled, estimated: ${approx(t.settledEstimated, est)}`,
    `- Still reserved: ${money(t.reserved)}`,
    ...(t.unknown > 0 ? [`- Unknown charges: ${money(t.unknown)}`] : []),
    `- Remaining: ${approx(t.remaining, est)}${t.overrun ? ' (over the allowance)' : ''}`,
    '',
    '## Estimated charges',
    '',
    ...estimatedChargeLines(report),
    '',
    ...legacyUnknownLines(report),
    '## Approvals',
    '',
    ...approvalLines(report.approvals),
    '',
    '## Revisions',
    '',
    ...revisionLines(report.revisions),
    '',
    ...(interim === undefined ? [] : ['## Finished step outputs', '', ...outputLines(interim.outputs)]),
    '## Artifacts',
    '',
    ...(['findings', 'plan', 'patch', 'review'] as const).map((k) => `- ${k}: ${report.artifacts[k] ?? 'none'}`),
    '',
    '## Limitations',
    '',
    ...report.limitations.map((l) => `- ${l.replace(/\r?\n/g, ' ')}`),
    `- ${REPORT_UNTOUCHED_NOTE}`,
    '',
  ];
  // P-4: the exported Markdown (final or interim) never carries a secret — the goal, approval notes and step outputs
  // are free text. The stored report.v1 JSON itself stays unredacted (it is the record, not an export).
  return redactString(lines.join('\n'));
}
