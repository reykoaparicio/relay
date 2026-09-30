// 06 F17 (Wave-1 minimal): the run report. `generateReport` builds a `report.v1` object on every terminal
// transition (post-commit effect), stores it as a `report` artifact (canonical JSON, never redacted), and appends
// `report.created`. Idempotent: an existing report artifact is returned. The Markdown renderer lands in Wave 4.
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
    const art = tx.artifacts.insertIfAbsent({ id, runId, projectId: run.projectId, kind: 'report', relPath: put.value.relPath,
      sha256: put.value.sha256, sizeBytes: put.value.sizeBytes, mediaType: 'application/json', schemaId: 'report.v1', createdAt: ctx.clock.now() });
    appendRunEvent(tx, fx, runId, 'report.created', { artifactId: art.id });
    return art;
  });
  await runEffects(ctx, fx);
  return ok(row.id);
}
