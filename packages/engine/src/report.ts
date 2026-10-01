// 06 F17 (Wave-1 minimal): the run report. `generateReport` builds a `report.v1` object on every terminal
// transition (post-commit effect), stores it as a `report` artifact (canonical JSON, never redacted), and appends
// `report.created`. Idempotent: an existing report artifact is returned. `renderReportMarkdown` is the pure Markdown
// view used by `artifacts.exportTo` (`what: 'report'`).
import { REVIEW_OUTCOMES, err, errors, isTerminalRunStatus, ok, reportV1Schema } from '@relay/contracts';
import type { ArtifactId, CostCertainty, Microusd, ReportV1, Result, ReviewOutcome, RunId, StepKey, TerminalRunStatus } from '@relay/contracts';
import type { LedgerEntryRow, Repos, RunRow, StepRow } from '@relay/storage';
import type { ReportLimitationKey } from '@relay/templates';
import { canonicalJson, utf8 } from './hash.js';
import type { EngineCtx, OutputArtifactKind } from './ports.js';
import type { PostCommitEffect } from './run-machine.js';
import { appendRunEvent, runEffects } from './run-machine.js';
import { SnapshotError, effectiveStepSnapshot, hasSnapshotPreserved, snapshotOf } from './snapshot.js';
import { allLedgerEntries, costOfEntries, latestPerKey } from './views.js';

const CERTAINTY_RANK: Readonly<Record<CostCertainty, number>> = { reported: 0, calculated: 1, estimated: 2, unknown: 3 };

function stepCost(entries: readonly LedgerEntryRow[], attemptIds: ReadonlySet<string>): ReportV1['steps'][number]['cost'] {
  let settled = 0;
  let unknown = 0;
  let certainty: CostCertainty = 'calculated';
  for (const e of entries) {
    if (e.attemptId === null || !attemptIds.has(e.attemptId)) continue;
    if (e.bucket === 'settled') {
      settled += e.deltaMicrousd;
      const c = e.certainty ?? 'calculated';
      if (CERTAINTY_RANK[c] > CERTAINTY_RANK[certainty]) certainty = c;
    }
    if (e.bucket === 'unknown') unknown += e.deltaMicrousd;
  }
  if (unknown > 0) certainty = 'unknown';
  return { settledMicrousd: settled as Microusd, certainty, unknownMicrousd: unknown as Microusd };
}

function profileOf(r: Repos, run: RunRow, stepKey: StepKey): { providerId: ReportV1['steps'][number]['providerId']; modelId: string | null } {
  try {
    const s = effectiveStepSnapshot(r, run, stepKey);
    return { providerId: s.profile.providerId, modelId: s.profile.modelId };
  } catch (e) {
    if (e instanceof SnapshotError) return { providerId: null, modelId: null };
    throw e;
  }
}

function outputOfKind(run: RunRow, latest: readonly StepRow[], kind: OutputArtifactKind): ArtifactId | null {
  const snapshot = snapshotOf(run);
  const rows = latest.filter((s) => {
    const snap = snapshot.steps[s.stepKey];
    return snap?.kind === 'model' && snap.outputKind === kind && s.outputArtifactId !== null;
  });
  return rows.at(-1)?.outputArtifactId ?? null;
}

function verdictOf(run: RunRow, latest: readonly StepRow[]): ReviewOutcome | null {
  const snapshot = snapshotOf(run);
  const verify = latest.filter((s) => {
    const snap = snapshot.steps[s.stepKey];
    return snap?.kind === 'model' && snap.outputSchema === 'review.v1' && s.state === 'succeeded';
  }).at(-1);
  const o = verify?.outcome;
  return o !== undefined && o !== null && (REVIEW_OUTCOMES as readonly string[]).includes(o) ? (o as ReviewOutcome) : null;
}

function limitationKeys(status: TerminalRunStatus, verifyRan: boolean, entries: readonly LedgerEntryRow[]): ReportLimitationKey[] {
  const keys: ReportLimitationKey[] = ['patch_not_applied', 'tests_not_run'];
  if (verifyRan) keys.push('model_checks_only');
  keys.push('cost_tracked');
  if (entries.some((e) => e.certainty === 'estimated' || e.bucket === 'unknown')) keys.push('cost_estimated');
  if (status === 'incomplete') keys.push('run_incomplete');
  if (status === 'cancelled') keys.push('run_cancelled');
  if (status === 'failed') keys.push('run_failed');
  return keys;
}

/** Builds the report.v1 value of a terminal run (pure over the repos). */
export function buildReport(ctx: Pick<EngineCtx, 'templates' | 'clock'>, r: Repos, run: RunRow & { status: TerminalRunStatus }): ReportV1 {
  const version = r.workflows.getVersionById(run.workflowVersionId);
  const all = r.steps.listForRun(run.id);
  const latest = latestPerKey(all);
  const attempts = r.attempts.listForRun(run.id);
  const entries = allLedgerEntries(r, run.id);
  const verdict = verdictOf(run, latest);
  const texts = ctx.templates.reportLimitations();
  const liabilities = attempts.filter((a) => a.state === 'unknown' || a.state === 'abandoned').flatMap((a) => {
    const u = r.ledger.attemptBalances(a.id).unknown;
    const step = all.find((s) => s.id === a.stepRunId);
    return u > 0 && step !== undefined
      ? [{ attemptId: a.id, stepKey: step.stepKey, liabilityMicrousd: u, state: a.state === 'unknown' ? ('unknown' as const) : ('abandoned' as const) }]
      : [];
  });
  return {
    schemaId: 'report.v1',
    runId: run.id,
    projectId: run.projectId,
    goal: run.goal,
    status: run.status,
    verdict,
    workflow: { id: version?.workflowId ?? (run.workflowVersionId as unknown as ReportV1['workflow']['id']), version: version?.version ?? 1, contentHash: snapshotOf(run).workflowContentHash },
    steps: latest.map((s) => {
      const ids = new Set(attempts.filter((a) => all.some((x) => x.id === a.stepRunId && x.stepKey === s.stepKey)).map((a) => a.id as string));
      return { stepKey: s.stepKey, revisionIndex: s.revisionIndex, retryIndex: s.retryIndex, state: s.state, profileName: s.profileName,
        ...profileOf(r, run, s.stepKey), cost: stepCost(entries, ids) };
    }),
    totals: costOfEntries(entries),
    unknownLiabilities: liabilities,
    artifacts: {
      findings: outputOfKind(run, latest, 'findings'),
      plan: outputOfKind(run, latest, 'plan'),
      patch: outputOfKind(run, latest, 'patch'),
      review: outputOfKind(run, latest, 'review'),
    },
    limitations: limitationKeys(run.status, verdict !== null, entries).map((k) => texts[k]),
    snapshotUsed: hasSnapshotPreserved(r, run.id),
    generatedAt: ctx.clock.now(),
    approvals: r.approvals.listForRun(run.id).map((a) => ({
      approvalId: a.id, stepKey: all.find((s) => s.id === a.stepRunId)?.stepKey ?? ('approve' as StepKey), planArtifactId: a.planArtifactId,
      planHash: a.planHash, decision: a.decision, decidedAt: a.decidedAt, note: a.decisionNote, invalidatedReason: a.invalidatedReason, createdAt: a.createdAt,
    })),
    revisions: revisionsOf(run, all),
  };
}

/** F17 revision summary: quality cycles vs the limit, plan re-dos (request_revision / replan), and the incomplete cause. */
function revisionsOf(run: RunRow, all: readonly StepRow[]): NonNullable<ReportV1['revisions']> {
  const snapshot = snapshotOf(run);
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

/** F17: generates (once) the report artifact of a terminal run. */
export async function generateReport(ctx: EngineCtx, runId: RunId): Promise<Result<ArtifactId>> {
  const r = ctx.db.repos;
  const existing = r.artifacts.listForRun(runId, ['report'])[0];
  if (existing !== undefined) return ok(existing.id);
  const run = r.runs.get(runId);
  if (!isTerminalRunStatus(run.status)) return err(errors.conflict({ reason: 'run_not_terminal' }));
  const report = reportV1Schema.safeParse(buildReport(ctx, r, { ...run, status: run.status }));
  const correlationId = ctx.ids.next('correlation');
  if (!report.success) {
    ctx.logger.error('report.invalid', { runId, correlationId });
    return err(errors.internal(correlationId));
  }
  const id = ctx.ids.next('artifact');
  const put = await ctx.artifacts.put({ scopeDir: `artifacts/${runId}`, artifactId: id, bytes: utf8(canonicalJson(report.data)), mediaType: 'application/json' });
  if (!put.ok) return put;
  const fx: PostCommitEffect[] = [];
  const row = ctx.db.tx('immediate', (tx) => {
    const raced = tx.artifacts.listForRun(runId, ['report'])[0]; // another caller (terminal effect / start sweep) won: keep one report
    if (raced !== undefined) return raced;
    const art = tx.artifacts.insertIfAbsent({ id, runId, projectId: run.projectId, kind: 'report', relPath: put.value.relPath,
      sha256: put.value.sha256, sizeBytes: put.value.sizeBytes, mediaType: 'application/json', schemaId: 'report.v1', createdAt: ctx.clock.now() });
    appendRunEvent(tx, fx, runId, 'report.created', { artifactId: art.id });
    return art;
  });
  await runEffects(ctx, fx);
  return ok(row.id);
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

/** F17: the pure Markdown rendering of a `report.v1` value (limitations, unknown charges, certainty breakdown). */
export function renderReportMarkdown(report: ReportV1): string {
  const t = report.totals;
  const lines: string[] = [
    `# Relay run report — ${report.runId}`,
    '',
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
    '| Step | Revision | Retry | State | Profile | Model | Settled (USD) | Certainty | Unknown (USD) |',
    '|---|---|---|---|---|---|---|---|---|',
    ...report.steps.map((s) => `| ${[s.stepKey, s.revisionIndex, s.retryIndex, s.state, s.profileName,
      s.providerId === null ? null : `${s.providerId}/${s.modelId ?? '?'}`, usd6(s.cost.settledMicrousd), s.cost.certainty,
      usd6(s.cost.unknownMicrousd)].map(cell).join(' | ')} |`),
    '',
    '## Cost (tracked by Relay)',
    '',
    `- Run allowance: ${money(t.allowance)}`,
    `- Settled, provider-reported: ${money(t.settledReported)}`,
    `- Settled, calculated from usage: ${money(t.settledCalculated)}`,
    `- Settled, estimated: ${money(t.settledEstimated)}`,
    `- Still reserved: ${money(t.reserved)}`,
    `- Unknown charges: ${money(t.unknown)}`,
    `- Remaining: ${money(t.remaining)}${t.overrun ? ' (over the allowance)' : ''}`,
    '',
    '## Approvals',
    '',
    ...approvalLines(report.approvals),
    '',
    '## Revisions',
    '',
    ...revisionLines(report.revisions),
    '',
    '## Unknown charges',
    '',
    ...(report.unknownLiabilities.length === 0
      ? ['None.']
      : report.unknownLiabilities.map((u) => `- ${u.stepKey} attempt ${u.attemptId} (${u.state}): up to ${money(u.liabilityMicrousd)} may have been charged`)),
    '',
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
  return lines.join('\n');
}
