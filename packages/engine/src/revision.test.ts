// F10: the quality-revision loop and the approval reuse rule (§12.4), plus the approval_stale recovery decisions.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunId, StepKey } from '@relay/contracts';
import { FAKE_FIXTURES } from '@relay/providers';
import type { ModelResult } from '@relay/providers';
import type { Repos, StepRow } from '@relay/storage';
import { revisionRows } from './revision.js';
import { SAMPLE_FILES, createHarness } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';
import { approvePending, drive, driveThroughApproval, wrapAdapters } from './testing/drive.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function start(o: HarnessOptions = {}): Promise<{ x: Harness; runId: RunId }> {
  const x = await createHarness(o);
  h = x;
  return { x, runId: await x.startRun() };
}

const rows = (r: Repos, runId: RunId, key: string) => r.steps.listForRun(runId).filter((s) => s.stepKey === (key as StepKey));

describe('revisionRows (pure)', () => {
  const latest = [
    { stepKey: 'implement', runId: 'run_1', ordinal: 4, revisionIndex: 0, profileName: 'Balanced' },
    { stepKey: 'verify', runId: 'run_1', ordinal: 5, revisionIndex: 0, profileName: 'Balanced' },
  ] as unknown as StepRow[];
  const policy = { triggerStep: 'verify', triggerOutcome: 'revise', repeatSteps: ['implement', 'verify'] };
  const step = { stepKey: 'verify', outcome: 'revise', outputArtifactId: 'art_review' } as unknown as StepRow;

  it('opens cycle n+1 below the limit: pending implement (with the review as structured input) + verify', () => {
    expect(revisionRows({ step, policy, cycle: 0, maxCycles: 2, latest })).toEqual({
      cycle: 1,
      rows: [
        expect.objectContaining({ stepKey: 'implement', revisionIndex: 1, state: 'pending', inputArtifactIds: ['art_review'] }),
        expect.objectContaining({ stepKey: 'verify', revisionIndex: 1, state: 'pending', inputArtifactIds: [] }),
      ],
    });
  });

  it('does nothing at the limit, for accept / incomplete, or for another step', () => {
    expect(revisionRows({ step, policy, cycle: 2, maxCycles: 2, latest })).toBeNull();
    expect(revisionRows({ step: { ...step, outcome: 'accept' }, policy, cycle: 0, maxCycles: 2, latest })).toBeNull();
    expect(revisionRows({ step: { ...step, stepKey: 'implement' } as StepRow, policy, cycle: 0, maxCycles: 2, latest })).toBeNull();
  });
});

describe('F10 revision loop (fake scenarios)', () => {
  it('revise-then-accept: one more implement + verify cycle under the SAME approval, then completed', async () => {
    const { x, runId } = await start({ scenario: 'revise-then-accept' });

    expect(await driveThroughApproval(x, runId, ['completed', 'incomplete', 'paused'])).toBe('completed');

    const r = x.db.repos;
    expect(r.runs.get(runId).revisionCycle).toBe(1);
    expect(rows(r, runId, 'implement').map((s) => [s.revisionIndex, s.state])).toEqual([[0, 'succeeded'], [1, 'succeeded']]);
    expect(rows(r, runId, 'verify').map((s) => [s.revisionIndex, s.outcome])).toEqual([[0, 'revise'], [1, 'accept']]);
    const firstVerify = rows(r, runId, 'verify')[0];
    expect(rows(r, runId, 'implement')[1]?.inputArtifactIds).toEqual([firstVerify?.outputArtifactId]);
    const approvals = r.events.list(runId, 0, 1000).filter((e) => e.type === 'approval.requested');
    expect(approvals).toHaveLength(1); // unchanged scope reuses the approval
    expect(r.approvals.latestApprovedForRun(runId)?.invalidatedAt).toBeNull();
    expect(r.attempts.listForRun(runId)).toHaveLength(6);
  });

  it('revise-until-limit: revise → revise → revise at maxRevisionCycles = 2 → incomplete (REVISION_LIMIT)', async () => {
    const { x, runId } = await start({ scenario: 'revise-until-limit' });

    expect(await driveThroughApproval(x, runId, ['completed', 'incomplete', 'paused'])).toBe('incomplete');

    const r = x.db.repos;
    expect(r.runs.get(runId).revisionCycle).toBe(2);
    expect(rows(r, runId, 'verify').map((s) => s.outcome)).toEqual(['revise', 'revise', 'revise']);
    const changed = r.events.list(runId, 0, 1000).filter((e) => e.type === 'run.status_changed').at(-1);
    expect(changed?.payload).toEqual(expect.objectContaining({ to: 'incomplete', trigger: 'REVISION_LIMIT', incompleteCause: 'revision_limit', revisionCycle: 2, maxRevisionCycles: 2 }));
    const detail = await x.engine.handle('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.statusDetail?.details).toEqual({ limit: 'revisions', incompleteCause: 'revision_limit', revisionCycle: 2, maxRevisionCycles: 2 });
  });

  it('a verifier `incomplete` verdict ends the run incomplete without another cycle', async () => {
    const incomplete = { ...(FAKE_FIXTURES['review.v1.accept'] as object), outcome: 'incomplete' };
    const { x, runId } = await start({
      scenario: { name: 'verify-incomplete', steps: [{ match: { stepKey: 'verify' }, result: { kind: 'success', fixture: 'review.incomplete' } }] },
      extraFixtures: { 'review.incomplete': incomplete },
    });

    expect(await driveThroughApproval(x, runId, ['completed', 'incomplete', 'paused'])).toBe('incomplete');
    expect(x.db.repos.runs.get(runId).revisionCycle).toBe(0);
    expect(x.db.repos.runs.get(runId).statusDetail?.details).toEqual({ limit: 'revisions', incompleteCause: 'verifier_incomplete' });
  });

  it('a revision whose patch leaves the approved scope invalidates the approval (scope_changed) → paused(approval_stale); a replan re-approves', async () => {
    const validate = SAMPLE_FILES['src/lib/validate.ts'] ?? '';
    const widened = {
      ...(FAKE_FIXTURES['patch.v1'] as { files: object[] }),
      files: [{ relPath: 'src/lib/validate.ts', changeType: 'modify',
        unifiedDiff: createTwoFilesPatch('a/src/lib/validate.ts', 'b/src/lib/validate.ts', validate, validate.replace('Request body must be a JSON object', 'Body must be an object')) }],
    };
    let implementCalls = 0;
    const { x, runId } = await start({
      scenario: 'revise-then-accept',
      providers: wrapAdapters({
        generate: async (base, req, gctx) => {
          const res: ModelResult = await base.get(req.providerId).generate(req, gctx);
          if (req.metadata.stepKey !== 'implement' || res.kind !== 'success') return res;
          implementCalls += 1;
          return implementCalls === 2 ? { ...res, json: widened, rawText: JSON.stringify(widened) } : res;
        },
      }),
    });

    expect(await driveThroughApproval(x, runId, ['completed', 'paused'])).toBe('paused');

    const r = x.db.repos;
    const run = r.runs.get(runId);
    expect([run.pauseReason, run.statusDetail?.code, run.statusDetail?.details?.['reason']]).toEqual(['approval_stale', 'APPROVAL_STALE', 'scope_changed']);
    const approval = r.events.list(runId, 0, 1000).find((e) => e.type === 'approval.requested');
    expect(r.approvals.get(approval?.payload['approvalId'] as never)?.invalidatedReason).toBe('scope_changed');
    expect(rows(r, runId, 'implement').at(-1)?.state).toBe('ready');
    const detail = await x.engine.handle('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.availableActions).toEqual(['resnapshot_and_replan', 'use_preserved_snapshot', 'stop']);

    const preserved = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'preserve-key-0001', runId, decision: { kind: 'use_preserved_snapshot' } });
    const replan = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'replan-key-000001', runId, decision: { kind: 'resnapshot_and_replan' } });

    expect(preserved.ok ? null : preserved.error.details?.['reason']).toBe('not_a_project_change');
    expect(replan.ok && replan.data.status).toBe('queued');
    expect(rows(r, runId, 'plan').map((s) => [s.revisionIndex, s.state])).toEqual([[0, 'succeeded'], [1, 'pending']]);
    expect(rows(r, runId, 'implement').at(-2)?.state).toBe('skipped');
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    await approvePending(x, runId, 'approve-key-000002');
    expect(await drive(x, runId, ['completed', 'paused', 'incomplete'])).toBe('completed');
  });
});

describe('approval_stale decisions (F2 resume)', () => {
  it('use_preserved_snapshot after a decide-time PROJECT_CHANGED re-opens the approval and approves without re-hashing', async () => {
    const { x, runId } = await start();
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    await writeFile(join(x.projectRoot, 'src', 'lib', 'format.ts'), '// changed on disk\n');

    const detail = await x.engine.handle('relay/v1/runs.get', { runId });
    const a = detail.ok ? detail.data.pendingApproval : null;
    const stale = await x.engine.handle('relay/v1/approvals.decide', { idempotencyKey: 'approve-stale-0001', approvalId: a?.id ?? '',
      planHash: a?.planHash ?? '', contextHash: a?.contextHash ?? '', decision: 'approved' });
    expect(stale.ok ? null : stale.error.code).toBe('PROJECT_CHANGED');
    expect(x.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'approval_stale' }));

    const res = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'preserve-key-0002', runId, decision: { kind: 'use_preserved_snapshot' } });

    expect(res.ok && res.data.status).toBe('queued');
    expect(x.db.repos.events.list(runId, 0, 1000).some((e) => e.type === 'run.snapshot_preserved')).toBe(true);
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    await approvePending(x, runId, 'approve-key-000003');
    expect(await drive(x, runId, ['completed', 'paused'])).toBe('completed');
  });
});
