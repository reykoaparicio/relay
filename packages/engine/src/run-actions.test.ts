// runs.resume (every RecoveryDecision kind), raise_limits (F12), review_recovery, and the project-budget re-evaluation.
import { afterEach, describe, expect, it } from 'vitest';
import { errors } from '@relay/contracts';
import type { RunId, StepKey } from '@relay/contracts';
import { applyRunEvent } from './run-machine.js';
import { snapshotOf } from './snapshot.js';
import type { RunMachineEvent } from './run-machine.js';
import { estimateNextReservation } from './run-actions.js';
import { tick } from './runner.js';
import { createHarness } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';
import { drive } from './testing/drive.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** A run moved to `running` by the loop, then by `ev` (applied directly). */
async function runWith(ev: RunMachineEvent | null, o: HarnessOptions = {}): Promise<{ x: Harness; runId: RunId }> {
  const x = await createHarness(o);
  h = x;
  const runId = await x.startRun();
  await tick(x.ctx); // CHECKS_PASSED
  if (ev !== null) x.db.tx('immediate', (r) => applyRunEvent(r, r.runs.get(runId), ev, x.clock.now(), []));
  return { x, runId };
}

const resume = (x: Harness, runId: RunId, key: string, decision: Parameters<Harness['engine']['handle']>[1] extends never ? never : object) =>
  x.engine.handle('relay/v1/runs.resume', { idempotencyKey: key, runId, decision } as never);

describe('runs.resume continue', () => {
  it('resumes paused(user) and paused(setup_blocked) → queued; the loop re-runs the checks', async () => {
    const { x, runId } = await runWith({ type: 'USER_PAUSE' });

    const res = await resume(x, runId, 'continue-key-0001', { kind: 'continue' });

    expect(res.ok && res.data).toEqual({ status: 'queued' });
    expect(x.db.repos.runs.get(runId).pauseRequested).toBe(false);
    await tick(x.ctx);
    expect(x.db.repos.runs.get(runId).status).toBe('running');
  });

  it('auth_required needs a credential ref for every provider still to be called (AUTH_REQUIRED otherwise)', async () => {
    const { x, runId } = await runWith({ type: 'AUTH_FAILED', error: errors.authRequired('anthropic') });
    x.db.repos.credentials.delete('anthropic'); // the key was removed while the run was running

    const missing = await resume(x, runId, 'continue-auth-001', { kind: 'continue' });
    await x.engine.handle('relay/v1/providers.recordCredentialRef', { providerId: 'anthropic', storageMode: 'session', vaultFile: null, redactedLabel: 'sk-…' });
    const ok = await resume(x, runId, 'continue-auth-002', { kind: 'continue' });

    expect(missing.ok ? null : [missing.error.code, missing.error.details?.['providerId']]).toEqual(['AUTH_REQUIRED', 'anthropic']);
    expect(ok.ok && ok.data.status).toBe('queued');
  });

  it('paused(unknown_outcome) with no step left to retry (e.g. reconciled meanwhile) offers resume → queued', async () => {
    const { x, runId } = await runWith({ type: 'UNKNOWN_OUTCOME', attemptId: 'att_01J9ZZZZZZZZZZZZZZZZZZZZZ1' as never, error: errors.requestOutcomeUnknown('att_01J9ZZZZZZZZZZZZZZZZZZZZZ1' as never) });
    const detail = await x.engine.handle('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.availableActions).toEqual(['resume', 'stop', 'export_report']); // nothing uncertain or failed

    const res = await resume(x, runId, 'continue-unk-0001', { kind: 'continue' });

    expect(res.ok && res.data.status).toBe('queued');
    await tick(x.ctx);
    expect(x.db.repos.runs.get(runId).status).toBe('running');
  });

  it('paused(unknown_outcome) with the uncertain step still open refuses continue (decision 1: retry_step or stop only)', async () => {
    const { x, runId } = await runWith({ type: 'UNKNOWN_OUTCOME', attemptId: 'att_01J9ZZZZZZZZZZZZZZZZZZZZZ1' as never, error: errors.requestOutcomeUnknown('att_01J9ZZZZZZZZZZZZZZZZZZZZZ1' as never) });
    x.db.tx('immediate', (r) => {
      const run = r.runs.get(runId);
      const s = r.steps.latestFor(runId, 'intake' as StepKey);
      if (s === undefined) throw new Error('intake');
      const snap = snapshotOf(run).steps['review' as StepKey];
      if (snap?.kind !== 'model') throw new Error('review');
      r.attempts.insert({ id: 'att_01J9ZZZZZZZZZZZZZZZZZZZZZ1' as never, runId, stepRunId: s.id, seq: 1, purpose: 'initial', providerId: snap.profile.providerId,
        modelId: snap.profile.modelId, profileSnapshot: snap.profile, requestFingerprint: 'f'.repeat(64), state: 'reserved', reservationMicrousd: 10,
        priceCatalogVersion: snap.profile.priceCatalogVersion, createdAt: x.clock.now() });
      r.attempts.transition('att_01J9ZZZZZZZZZZZZZZZZZZZZZ1' as never, ['reserved'], 'unknown', {});
      r.steps.transition(s.id, [s.state], 'unknown', {});
    });

    const res = await resume(x, runId, 'continue-unk-0002', { kind: 'continue' });
    const detail = await x.engine.handle('relay/v1/runs.get', { runId });

    expect(res.ok ? null : res.error.details?.['reason']).toBe('decision_not_applicable');
    expect(detail.ok && detail.data.availableActions).toEqual(['retry_step', 'stop', 'export_report']);
  });

  it('is CONFLICT for pause reasons that need another decision, and for a running run', async () => {
    const { x, runId } = await runWith(null);
    const running = await resume(x, runId, 'continue-bad-0001', { kind: 'continue' });
    x.db.tx('immediate', (r) => applyRunEvent(r, r.runs.get(runId), { type: 'OUTPUT_INVALID_EXHAUSTED', error: errors.outputInvalid() }, x.clock.now(), []));
    const invalid = await resume(x, runId, 'continue-bad-0002', { kind: 'continue' });
    const ack = await resume(x, runId, 'continue-bad-0003', { kind: 'acknowledge_overrun' });
    const raise = await resume(x, runId, 'continue-bad-0004', { kind: 'raise_limits', maxAttempts: 20 });
    const replan = await resume(x, runId, 'continue-bad-0005', { kind: 'resnapshot_and_replan' });

    for (const res of [running, invalid, ack, raise, replan]) expect(res.ok ? null : res.error.details?.['reason']).toBe('decision_not_applicable');
  });

  it('review_recovery on interrupted: RECOVERY_DECIDED', async () => {
    const { x, runId } = await runWith({ type: 'RUNNER_LOST' });
    expect(x.db.repos.runs.get(runId).status).toBe('interrupted');
    const detail = await x.engine.handle('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.availableActions).toEqual(['review_recovery', 'stop', 'export_report']);

    const res = await resume(x, runId, 'recovery-key-0001', { kind: 'continue' });

    expect(res.ok && res.data.status).toBe('queued');
  });

  it('decision 1: review_recovery with an uncertain attempt is accepted; the loop then pauses unknown_outcome (retry_step / stop), never retrying it', async () => {
    const x = await createHarness({ scenario: 'midstream-error' });
    h = x;
    const runId = await x.startRun();
    await drive(x, runId, ['paused']);
    x.db.tx('immediate', (r) => {
      r.runs.updateStatus(runId, ['paused'], 'interrupted', {}); // as if recovery found it (test-only shortcut)
    });

    const res = await resume(x, runId, 'recovery-key-0002', { kind: 'continue' });
    expect(res.ok && res.data.status).toBe('queued');
    expect(await drive(x, runId, ['paused'])).toBe('paused');

    const detail = await x.engine.handle('relay/v1/runs.get', { runId });
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('unknown_outcome');
    expect(detail.ok && detail.data.availableActions).toEqual(['retry_step', 'stop', 'export_report']);
    expect(x.db.repos.attempts.listForRun(runId)).toHaveLength(1); // no automatic retry
  });
});

describe('raise_limits (F12)', () => {
  it('validates each value strictly above what is used and requires raising the limit that paused the run', async () => {
    const { x, runId } = await runWith({ type: 'LIMIT_REACHED', reason: 'deadline', error: errors.limitReached('deadline') });
    x.db.tx('immediate', (r) => {
      r.runs.incrementAttemptCount(runId);
      r.runs.incrementAttemptCount(runId);
    });

    const onlyAttempts = await resume(x, runId, 'raise-key-000001', { kind: 'raise_limits', maxAttempts: 20 });
    const notAbove = await resume(x, runId, 'raise-key-000002', { kind: 'raise_limits', maxAttempts: 2, executionTimeoutSeconds: 60 });
    const ok = await resume(x, runId, 'raise-key-000003', { kind: 'raise_limits', executionTimeoutSeconds: 1800 });
    const replay = await resume(x, runId, 'raise-key-000003', { kind: 'raise_limits', executionTimeoutSeconds: 1800 });

    expect(onlyAttempts.ok ? null : onlyAttempts.error.details?.['issues']).toEqual([expect.objectContaining({ path: 'decision.executionTimeoutSeconds', code: 'required' })]);
    expect(notAbove.ok ? null : (notAbove.error.details?.['issues'] as { path: string }[]).map((i) => i.path)).toEqual(['decision.maxAttempts']);
    expect(ok.ok && ok.data.status).toBe('queued');
    expect(replay.ok && replay.data.status).toBe('queued');
    const run = x.db.repos.runs.get(runId);
    expect(run.limits.executionTimeoutSeconds).toBe(1800);
    expect(x.db.repos.events.list(runId, 0, 1000).filter((e) => e.type === 'run.limits_raised')).toHaveLength(1);
  });

  it('limit_attempts: raising maxAttempts above attempt_count resumes; at or below it is VALIDATION_FAILED', async () => {
    const { x, runId } = await runWith({ type: 'LIMIT_REACHED', reason: 'limit_attempts', error: errors.limitReached('attempts') });
    x.db.tx('immediate', (r) => {
      for (let i = 0; i < 10; i += 1) r.runs.incrementAttemptCount(runId);
    });

    const atUsed = await resume(x, runId, 'raise-att-000001', { kind: 'raise_limits', maxAttempts: 10 });
    const above = await resume(x, runId, 'raise-att-000002', { kind: 'raise_limits', maxAttempts: 11 });

    expect(atUsed.ok ? null : atUsed.error.code).toBe('VALIDATION_FAILED');
    expect(above.ok && above.data.status).toBe('queued');
    expect(x.db.repos.runs.get(runId).limits.maxAttempts).toBe(11);
  });
});

describe('switch_profile guards', () => {
  it('rejects a non-model step, an unknown profile, and a step that already finished', async () => {
    const { x, runId } = await runWith({ type: 'SETUP_BLOCKED', reason: 'setup_blocked', error: errors.permissionDenied('provider_not_allowed') });
    const economy = x.db.repos.profiles.getByName('Economy');

    const notModel = await resume(x, runId, 'switch-bad-00001', { kind: 'switch_profile', stepKey: 'approve', profileId: economy?.id });
    const noProfile = await resume(x, runId, 'switch-bad-00002', { kind: 'switch_profile', stepKey: 'review', profileId: 'prf_01J9ZZZZZZZZZZZZZZZZZZZZZ0' });
    x.db.tx('immediate', (r) => {
      const review = r.steps.latestFor(runId, 'review' as StepKey);
      if (review !== undefined) r.steps.transition(review.id, ['pending'], 'succeeded', {});
    });
    const done = await resume(x, runId, 'switch-bad-00003', { kind: 'switch_profile', stepKey: 'review', profileId: economy?.id });
    const ok = await resume(x, runId, 'switch-ok-000001', { kind: 'switch_profile', stepKey: 'plan', profileId: economy?.id });

    expect(notModel.ok ? null : notModel.error.code).toBe('VALIDATION_FAILED');
    expect(noProfile.ok ? null : noProfile.error.code).toBe('NOT_FOUND');
    expect(done.ok ? null : done.error.details?.['reason']).toBe('step_not_ready');
    expect(ok.ok && ok.data.status).toBe('queued');
    expect(x.db.repos.configRevisions.list(runId).map((c) => [c.stepKey, c.reason])).toEqual([['plan', 'user_switch']]);
  });
});

describe('edit_project_allowance (projects.update)', () => {
  it('re-evaluates paused(budget_project) runs and resumes those whose next admission now passes', async () => {
    const x = await createHarness({ monthlyAllowanceMicrousd: 1_000 });
    h = x;
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('budget_project');
    const N = await estimateNextReservation(x.ctx, runId);
    expect(N).toBeGreaterThan(1_000);

    const project = x.db.repos.projects.get(x.projectId);
    const small = await x.engine.handle('relay/v1/projects.update', { projectId: x.projectId, expectedUpdatedAt: project.updatedAt, patch: { monthlyAllowanceMicrousd: 2_000 } });
    expect(x.db.repos.runs.get(runId).status).toBe('paused');
    const big = await x.engine.handle('relay/v1/projects.update', { projectId: x.projectId, expectedUpdatedAt: small.ok ? small.data.updatedAt : 0,
      patch: { monthlyAllowanceMicrousd: 90_000_000, name: 'Renamed' } });

    expect(big.ok && [big.data.name, big.data.monthlyAllowanceMicrousd]).toEqual(['Renamed', 90_000_000]);
    expect(x.db.repos.runs.get(runId).status).toBe('queued');
    const stale = await x.engine.handle('relay/v1/projects.update', { projectId: x.projectId, expectedUpdatedAt: project.updatedAt, patch: { name: 'x' } });
    expect(stale.ok ? null : stale.error.code).toBe('CONFLICT');
  });

  it('merges provider policy edits and archives only without an active run', async () => {
    const x = await createHarness();
    h = x;
    const p = x.db.repos.projects.get(x.projectId);
    const upd = await x.engine.handle('relay/v1/projects.update', { projectId: x.projectId, expectedUpdatedAt: p.updatedAt,
      patch: { allowedProviderIds: ['anthropic'], providerOptions: { openai: { storeResponses: false } } } });
    expect(upd.ok && upd.data.providerPolicy).toEqual({ allowedProviderIds: ['anthropic'], providerOptions: { openai: { storeResponses: false } } });

    const runId = await x.startRun();
    const blocked = await x.engine.handle('relay/v1/projects.archive', { projectId: x.projectId });
    await x.engine.handle('relay/v1/runs.cancel', { runId });
    const archived = await x.engine.handle('relay/v1/projects.archive', { projectId: x.projectId });
    const again = await x.engine.handle('relay/v1/projects.archive', { projectId: x.projectId });
    const none = await x.engine.handle('relay/v1/projects.archive', { projectId: 'prj_01J9ZZZZZZZZZZZZZZZZZZZZZ0' });
    const noneUpd = await x.engine.handle('relay/v1/projects.update', { projectId: 'prj_01J9ZZZZZZZZZZZZZZZZZZZZZ0', expectedUpdatedAt: 1, patch: {} });

    expect(blocked.ok ? null : [blocked.error.code, blocked.error.details?.['reason']]).toEqual(['CONFLICT', 'active_run']);
    expect(archived.ok && archived.data.archivedAt).not.toBeNull();
    expect(again.ok ? null : again.error.details?.['reason']).toBe('already_archived');
    expect(none.ok ? null : none.error.code).toBe('NOT_FOUND');
    expect(noneUpd.ok ? null : noneUpd.error.code).toBe('NOT_FOUND');
  });
});
