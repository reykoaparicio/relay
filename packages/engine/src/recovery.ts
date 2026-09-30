// 06 F9 (Wave-1 subset; completed in Wave 3): crash recovery at engine.start(), one transaction per run.
// created/reserved attempts → released (failed_before_dispatch, step → ready); EVERY dispatching attempt → unknown
// with move_to_unknown N (R4-3); running → interrupted (RUNNER_LOST); cancelling → cancelled with open steps skipped.
// Succeeded steps are never touched (FR-07). The F9b reconcile task lands in Wave 3.
import { errors } from '@relay/contracts';
import type { EpochMs, RunId } from '@relay/contracts';
import type { AttemptRow, Repos } from '@relay/storage';
import { settlementEntries } from './budget.js';
import type { EngineCtx } from './ports.js';
import type { PostCommitEffect } from './run-machine.js';
import { appendRunEvent, applyRunEvent, runEffects } from './run-machine.js';
import { applyStepEvent, skipOpenSteps } from './step-machine.js';

function recoverAttempt(r: Repos, fx: PostCommitEffect[], a: AttemptRow, now: EpochMs): void {
  const N = r.ledger.attemptBalances(a.id).reserved;
  const run = r.runs.get(a.runId);
  const refs = { reservation: N, attemptId: a.id, runId: a.runId, projectId: run.projectId, priceCatalogVersion: a.priceCatalogVersion, createdAt: now };
  const step = r.steps.get(a.stepRunId);
  if (a.state === 'created' || a.state === 'reserved') {
    r.ledger.append(settlementEntries({ ...refs, cost: { kind: 'not_charged' } }));
    r.attempts.transition(a.id, [a.state], 'failed_before_dispatch', { finishedAt: now });
    if (step.state === 'reserved') applyStepEvent(r, fx, step, 'RESERVATION_RELEASED');
    return;
  }
  if (a.state === 'dispatching') {
    r.ledger.append(settlementEntries({ ...refs, cost: { kind: 'unknown' } }));
    r.attempts.transition(a.id, ['dispatching'], 'unknown', { error: errors.requestOutcomeUnknown(a.id), finishedAt: now });
    if (step.state === 'executing') applyStepEvent(r, fx, step, 'OUTCOME_UNKNOWN', { error: errors.requestOutcomeUnknown(a.id) });
    appendRunEvent(r, fx, a.runId, 'attempt.unknown', { attemptId: a.id, recovered: true });
  }
}

function recoverRun(ctx: EngineCtx, runId: RunId, attempts: readonly AttemptRow[]): PostCommitEffect[] {
  const fx: PostCommitEffect[] = [];
  ctx.db.tx('immediate', (r) => {
    const now = ctx.clock.now();
    for (const a of attempts) recoverAttempt(r, fx, a, now);
    const run = r.runs.get(runId);
    if (run.status === 'running') applyRunEvent(r, run, { type: 'RUNNER_LOST' }, now, fx);
    if (run.status === 'cancelling') {
      skipOpenSteps(r, fx, runId);
      applyRunEvent(r, run, { type: 'RUNNER_LOST' }, now, fx);
    }
  });
  return fx;
}

/** Runs recovery for every run with an in-flight attempt or a running/cancelling status. Returns the run ids. */
export async function recoverOnStart(ctx: EngineCtx): Promise<RunId[]> {
  const r = ctx.db.repos;
  const pending = r.attempts.listUnresolved().filter((a) => a.state !== 'unknown');
  const byRun = new Map<RunId, AttemptRow[]>();
  for (const a of pending) byRun.set(a.runId, [...(byRun.get(a.runId) ?? []), a]);
  for (const run of r.runs.listActive()) {
    if ((run.status === 'running' || run.status === 'cancelling') && !byRun.has(run.id)) byRun.set(run.id, []);
  }
  for (const [runId, attempts] of byRun) await runEffects(ctx, recoverRun(ctx, runId, attempts));
  return [...byRun.keys()];
}
