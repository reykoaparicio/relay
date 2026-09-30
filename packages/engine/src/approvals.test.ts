import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalView, RunId, StepKey } from '@relay/contracts';
import type { CrashHookCtx } from './ports.js';
import { decideApproval } from './approvals.js';
import { tick } from './runner.js';
import { createHarness } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function awaitingApproval(o: HarnessOptions = {}): Promise<{ harness: Harness; runId: RunId; approval: ApprovalView }> {
  const harness = await createHarness(o);
  h = harness;
  const runId = await harness.startRun();
  for (let i = 0; i < 20 && harness.db.repos.runs.get(runId).status !== 'awaiting_approval'; i += 1) await tick(harness.ctx);
  const detail = await harness.engine.handle('relay/v1/runs.get', { runId });
  if (!detail.ok || detail.data.pendingApproval === null) throw new Error('not awaiting approval');
  return { harness, runId, approval: detail.data.pendingApproval };
}

const decide = (harness: Harness, a: ApprovalView, over: Record<string, unknown> = {}) =>
  harness.engine.handle('relay/v1/approvals.decide', {
    idempotencyKey: 'decide-key-000001', approvalId: a.id, planHash: a.planHash, contextHash: a.contextHash, decision: 'approved', ...over,
  });

describe('approvals.decide (F10, Wave-1 minimal)', () => {
  it('binds plan hash, context hash, file scope, and the providers that will receive context (R3-11)', async () => {
    const { harness, runId, approval } = await awaitingApproval();

    const plan = harness.db.repos.steps.latestFor(runId, 'plan' as StepKey);
    const planArtifact = harness.db.repos.artifacts.get(plan?.outputArtifactId ?? ('' as never));
    expect(approval.planHash).toBe(planArtifact?.sha256);
    expect(approval.contextHash).toBe(harness.db.repos.runs.get(runId).contextHash);
    expect(approval.providers).toEqual(['anthropic']);
    expect(approval.fileScope).toEqual(['src/handlers/user.ts', 'src/handlers/orders.ts', 'src/lib/format.ts']);
    expect(harness.db.repos.steps.latestFor(runId, 'approve' as StepKey)?.state).toBe('awaiting_approval');
  });

  it('approves: step succeeded, run queued (B2), afterApprovalCommit fires after commit, and a replay returns the stored result', async () => {
    const calls: CrashHookCtx[] = [];
    const { harness, runId, approval } = await awaitingApproval({ hooks: { afterApprovalCommit: (c) => calls.push(c) } });
    let hashCalls = 0;
    const fs = harness.ctx.projectFs;
    const ctx = { ...harness.ctx, projectFs: { ...fs, hashFiles: (...a: Parameters<typeof fs.hashFiles>) => { hashCalls += 1; return fs.hashFiles(...a); } } };
    const input = { idempotencyKey: 'decide-key-000001', approvalId: approval.id, planHash: approval.planHash, contextHash: approval.contextHash, decision: 'approved' as const };

    const first = await decideApproval(ctx, input);
    const replay = await decideApproval(ctx, input);
    const reused = await decideApproval(ctx, { ...input, decision: 'rejected' });
    const otherKey = await decideApproval(ctx, { ...input, idempotencyKey: 'decide-key-000002' });

    expect(first.ok && first.value).toEqual({ approval: expect.objectContaining({ decision: 'approved' }) as unknown, runStatus: 'queued' });
    expect(replay).toEqual(first);
    expect(hashCalls).toBe(1); // the idempotency lookup happens before any hashing
    expect(reused.ok ? null : reused.error.details?.['reason']).toBe('idempotency_key_reused');
    expect(otherKey.ok ? null : otherKey.error.details?.['reason']).toBe('already_decided');
    expect(calls).toEqual([{ stepKey: 'approve', purpose: null, attemptSeq: 0 }]);
    expect(harness.db.repos.steps.latestFor(runId, 'approve' as StepKey)?.state).toBe('succeeded');
  });

  it('returns APPROVAL_STALE when the echoed plan hash does not match', async () => {
    const { harness, approval } = await awaitingApproval();

    const res = await decide(harness, approval, { planHash: 'f'.repeat(64) });

    expect(res.ok ? null : res.error).toEqual(expect.objectContaining({ code: 'APPROVAL_STALE', details: { reason: 'plan_changed' } }));
  });

  it('returns PROJECT_CHANGED and invalidates the approval when an input file changed on disk', async () => {
    const { harness, runId, approval } = await awaitingApproval();
    await writeFile(join(harness.projectRoot, 'src', 'handlers', 'user.ts'), 'changed\n');

    const res = await decide(harness, approval);
    const again = await decide(harness, approval, { idempotencyKey: 'decide-key-000003' });

    expect(res.ok ? null : res.error.code).toBe('PROJECT_CHANGED');
    expect(res.ok ? null : res.error.details?.['changedPaths']).toEqual(['src/handlers/user.ts']);
    expect(harness.db.repos.approvals.get(approval.id)?.invalidatedReason).toBe('project_changed');
    expect(harness.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'approval_stale' }));
    expect(again.ok ? null : again.error.details?.['reason']).toBe('project_changed');
  });

  it('marks the approval stale when the run context hash no longer matches', async () => {
    const { harness, runId, approval } = await awaitingApproval();
    harness.db.repos.runs.setContextHash(runId, 'e'.repeat(64));

    const res = await decide(harness, approval);

    expect(res.ok ? null : res.error.code).toBe('APPROVAL_STALE');
    expect(harness.db.repos.approvals.get(approval.id)?.invalidatedReason).toBe('plan_changed');
  });

  it('a concurrent duplicate with the same key gets CONFLICT(duplicate_in_flight), later replays succeed', async () => {
    const { harness, approval } = await awaitingApproval();

    const [a, b] = await Promise.all([decide(harness, approval), decide(harness, approval)]);
    const later = await decide(harness, approval);

    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const failed = a.ok ? b : a;
    expect(failed.ok ? null : failed.error.details?.['reason']).toBe('duplicate_in_flight');
    expect(later.ok).toBe(true);
  });

  it('reject cancels the run, skips the remaining steps, and generates the report', async () => {
    const { harness, runId, approval } = await awaitingApproval();

    const res = await decide(harness, approval, { decision: 'rejected' });

    expect(res.ok && res.data.runStatus).toBe('cancelled');
    expect(harness.db.repos.steps.latestFor(runId, 'implement' as StepKey)?.state).toBe('skipped');
    await harness.waitFor(() => harness.db.repos.artifacts.listForRun(runId, ['report']).length === 1);
  });

  it('revision_requested re-runs the planner (new plan row) and re-opens the approval', async () => {
    const { harness, runId, approval } = await awaitingApproval();

    const res = await decide(harness, approval, { decision: 'revision_requested', note: 'Keep the public response fields.' });
    for (let i = 0; i < 10 && harness.db.repos.runs.get(runId).status !== 'awaiting_approval'; i += 1) await tick(harness.ctx);

    expect(res.ok && res.data.runStatus).toBe('queued');
    const plans = harness.db.repos.steps.listForRun(runId).filter((s) => s.stepKey === 'plan');
    expect(plans.map((s) => [s.revisionIndex, s.state])).toEqual([[0, 'succeeded'], [1, 'succeeded']]);
    expect(harness.db.repos.runs.get(runId).status).toBe('awaiting_approval');
    expect(harness.db.repos.attempts.listForRun(runId)).toHaveLength(3); // the replan consumes a planner attempt
  });

  it('returns NOT_FOUND for an unknown approval and CONFLICT when the run is no longer awaiting approval', async () => {
    const { harness, runId, approval } = await awaitingApproval();
    const unknown = await decide(harness, { ...approval, id: 'apr_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as ApprovalView['id'] });
    await harness.engine.handle('relay/v1/runs.cancel', { runId });

    const late = await decide(harness, approval, { idempotencyKey: 'decide-key-000009', decision: 'rejected' });

    expect(unknown.ok ? null : unknown.error.code).toBe('NOT_FOUND');
    expect(late.ok ? null : late.error.code).toBe('CONFLICT');
  });

  it('B2: a run approved while another run is running is queued; only one run is ever running', async () => {
    const { harness, runId: a, approval } = await awaitingApproval();
    const b = await harness.startRun();
    await tick(harness.ctx); // B: queued → running (A is awaiting approval, so the slot is free)
    expect(harness.db.repos.runs.get(b).status).toBe('running');

    const res = await decide(harness, approval);

    expect(res.ok && res.data.runStatus).toBe('queued');
    const slotHolders = () => harness.db.repos.runs.listActive().filter((x) => x.status === 'running' || x.status === 'cancelling').map((x) => x.id);
    expect(slotHolders()).toEqual([b]);
    for (let i = 0; i < 30; i += 1) {
      await tick(harness.ctx);
      expect(slotHolders().length).toBeLessThanOrEqual(1);
    }
    expect(harness.db.repos.runs.get(a).status).not.toBe('awaiting_approval');
  });
});
