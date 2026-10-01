// 06 F1 run read/command handlers: `runs.getStep` (no full RunDetail; the run's ledger read once and grouped per
// attempt; events filtered in SQL), `runs.cancel`, `runs.pause`, `ledger.runSummary`, and the ledger-view step keys.
import { err, errors, ok } from '@relay/contracts';
import type { ArtifactId, Result, RunId, StepDetail, StepKey } from '@relay/contracts';
import type { LedgerEntryRow, Repos } from '@relay/storage';
import type { ParsedInputOf } from './handler-types.js';
import { fromUtf8 } from './hash.js';
import type { EngineCtx } from './ports.js';
import type { PostCommitEffect } from './run-machine.js';
import { applyRunEvent, runEffects } from './run-machine.js';
import { skipOpenSteps } from './step-machine.js';
import { costOfEntries, entriesByAttempt, entriesByStep, stepViewOf, toAttemptView, toManifest, toStepOutput } from './views.js';

async function readJsonArtifact(ctx: EngineCtx, id: ArtifactId | null): Promise<{ schemaId: string | null; value: unknown } | null> {
  if (id === null) return null;
  const row = ctx.db.repos.artifacts.get(id);
  if (row === undefined || row.purgedAt !== null) return null;
  const bytes = await ctx.artifacts.read(row.relPath, row.sizeBytes);
  if (!bytes.ok) return null;
  try {
    return { schemaId: row.schemaId, value: JSON.parse(fromUtf8(bytes.value)) as unknown };
  } catch {
    return null;
  }
}

export async function stepDetail(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/runs.getStep'>): Promise<Result<StepDetail>> {
  const r = ctx.db.repos;
  const step = r.steps.find(input.stepId);
  if (step?.runId !== input.runId) return err(errors.notFound('step'));
  const run = r.runs.get(input.runId);
  const attempts = r.attempts.listForStep(step.id);
  const output = await readJsonArtifact(ctx, step.outputArtifactId);
  const latest = attempts.at(-1);
  const manifestRow = latest === undefined ? undefined : r.artifacts.listForRun(run.id, ['context_manifest']).filter((a) => a.attemptId === latest.id).at(-1);
  const manifest = manifestRow === undefined ? null : await readJsonArtifact(ctx, manifestRow.id);
  // The run's ledger is read once and grouped per attempt (10); events are filtered in SQL (3).
  const byAttempt = attempts.length === 0 ? new Map<string, LedgerEntryRow[]>() : entriesByAttempt(r.ledger.listForRun(run.id).map((x) => x.entry));
  return ok({
    step: stepViewOf(r, run, step),
    output: output === null ? null : toStepOutput(output.schemaId, output.value),
    manifest: manifest === null ? null : toManifest(manifest.value),
    attempts: attempts.map((a) => toAttemptView(a, step.stepKey, byAttempt.get(a.id) ?? [])),
    events: [...r.events.listForStep(run.id, step.id, attempts.map((a) => a.id))],
  });
}

export async function cancelRun(ctx: EngineCtx, runId: RunId) {
  const fx: PostCommitEffect[] = [];
  const res = ctx.db.txResult('immediate', (r) => {
    const run = r.runs.get(runId);
    const now = ctx.clock.now();
    switch (run.status) {
      case 'queued':
      case 'awaiting_approval':
        skipOpenSteps(r, fx, runId);
        applyRunEvent(r, run, { type: 'CANCEL_REQUESTED' }, now, fx);
        return ok('cancelled' as const);
      case 'paused':
      case 'interrupted':
        skipOpenSteps(r, fx, runId);
        applyRunEvent(r, run, { type: 'STOP_REQUESTED' }, now, fx);
        return ok('cancelled' as const);
      case 'running':
        applyRunEvent(r, run, { type: 'CANCEL_REQUESTED' }, now, fx);
        return ok('cancelling' as const);
      case 'cancelling':
        return ok('cancelling' as const);
      case 'cancelled':
      case 'completed':
      case 'incomplete':
      case 'failed':
        return err(errors.conflict({ reason: 'run_terminal', status: run.status }));
    }
  });
  if (!res.ok) return res;
  if (res.value === 'cancelling') ctx.cancellation.abortRun(runId, { kind: 'cancel' });
  await runEffects(ctx, fx);
  ctx.wake.signal();
  const r = ctx.db.repos;
  const unresolvedCharges = r.attempts.listForRun(runId)
    .filter((a) => a.state === 'unknown' || a.state === 'abandoned')
    .map((a) => ({ attemptId: a.id, liabilityMicrousd: r.ledger.attemptBalances(a.id).unknown }))
    .filter((c) => c.liabilityMicrousd > 0);
  return ok({ status: res.value, unresolvedCharges });
}

export function pauseRun(ctx: EngineCtx, runId: RunId) {
  const res = ctx.db.txResult('immediate', (r) => {
    const run = r.runs.get(runId);
    if (run.status !== 'running') return err(errors.conflict({ reason: 'run_not_running', status: run.status }));
    r.runs.setPauseRequested(runId, true);
    return ok({ status: run.status, inFlight: ctx.cancellation.hasInFlight(runId) ? ('waiting' as const) : ('none' as const) });
  });
  // B9: wake the loop (after commit) so a backoff / idle sleep ends now and the next iteration applies USER_PAUSE.
  if (res.ok) ctx.wake.signal();
  return res;
}

export function runSummaryCost(ctx: EngineCtx, runId: RunId) {
  const r = ctx.db.repos;
  r.runs.get(runId); // NOT_FOUND
  const rows = r.ledger.listForRun(runId); // one statement, step keys joined (10, 11)
  const byStep = entriesByStep(rows);
  return ok({ ...costOfEntries(rows.map((x) => x.entry)), byStep: [...byStep].map(([stepKey, es]) => ({ stepKey, cost: costOfEntries(es) })) });
}

/** attemptId → stepKey for a run (an attempt's step row is FK-bound to the same run). */
export function attemptStepKeys(r: Repos, runId: RunId): Map<string, StepKey> {
  const steps = new Map(r.steps.listForRun(runId).map((s) => [s.id, s.stepKey]));
  return new Map(r.attempts.listForRun(runId).flatMap((a) => {
    const key = steps.get(a.stepRunId);
    return key === undefined ? [] : [[a.id, key] as const];
  }));
}
