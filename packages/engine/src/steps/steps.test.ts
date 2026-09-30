import { afterEach, describe, expect, it } from 'vitest';
import { err, errors } from '@relay/contracts';
import type { StepKey } from '@relay/contracts';
import { createMemoryService } from '../memory.js';
import { tick } from '../runner.js';
import { createHarness } from '../testing/harness.js';
import type { Harness } from '../testing/harness.js';
import { finalEventFor, runFinalize } from './finalize.js';
import { runIntake } from './intake.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('intake (R4-6)', () => {
  it('blocks the run (setup_blocked) when a selected file is refused, reading nothing', async () => {
    h = await createHarness({ files: { 'src/a.ts': 'x\n', '.env': 'SECRET=1\n' } });
    const runId = await h.startRun({ relPaths: ['src/a.ts', '.env'] });

    await tick(h.ctx);
    await tick(h.ctx);

    expect(h.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'setup_blocked' }));
    expect(h.db.repos.runs.get(runId).statusDetail?.code).toBe('PERMISSION_DENIED');
    expect(h.db.repos.runs.inputFiles(runId)).toEqual([]);
  });

  it('blocks when the memory snapshot fails and is idempotent across a retried intake', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    await tick(h.ctx);
    const intake = h.db.repos.steps.latestFor(runId, 'intake' as StepKey);
    const failing = { ...h.ctx, memory: { ...createMemoryService(), snapshotForRun: () => err(errors.validationFailed([])) } };
    h.db.tx('immediate', (r) => r.steps.transition(intake?.id ?? ('' as never), ['pending'], 'ready', {}));

    await runIntake(failing, runId, intake?.id ?? ('' as never));

    expect(h.db.repos.runs.get(runId).pauseReason).toBe('setup_blocked');
    expect(h.db.repos.artifacts.listForRun(runId, ['input_file'])).toEqual([]);
  });

  it('dedupes identical file contents into one input_file artifact per sha', async () => {
    h = await createHarness({ files: { 'a.ts': 'same\n', 'b.ts': 'same\n' } });
    const runId = await h.startRun();

    await tick(h.ctx);
    await tick(h.ctx);

    expect(h.db.repos.runs.inputFiles(runId).map((f) => f.relPath)).toEqual(['a.ts', 'b.ts']);
    expect(h.db.repos.artifacts.listForRun(runId, ['input_file'])).toHaveLength(1);
    expect(h.db.repos.runs.get(runId).contextHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('finalize', () => {
  it('maps the verifier verdict: accept → ACCEPTED, incomplete → verifier_incomplete, revise → revision_limit (Wave-1)', async () => {
    h = await createHarness();
    const run = h.db.repos.runs.get(await h.startRun());
    const verify = h.db.repos.steps.latestFor(run.id, 'verify' as StepKey);
    const setOutcome = (outcome: string | null) => h?.db.repos.steps.transition(verify?.id ?? ('' as never), ['pending'], 'pending', { outcome });

    expect(finalEventFor(h.db.repos, run)).toEqual({ type: 'ACCEPTED' });
    setOutcome('incomplete');
    expect(finalEventFor(h.db.repos, run)).toEqual({ type: 'REVISION_LIMIT', cause: 'verifier_incomplete' });
    setOutcome('revise');
    expect(finalEventFor(h.db.repos, run)).toEqual({ type: 'REVISION_LIMIT', cause: 'revision_limit' });
  });

  it('logs memory failures without blocking completion, and does nothing for a run that is not running', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    const fin = h.db.repos.steps.latestFor(runId, 'finalize' as StepKey);
    const failing = { ...h.ctx, memory: { ...createMemoryService(), proposeFromRun: () => err(errors.validationFailed([])) } };

    await runFinalize(failing, runId, fin?.id ?? ('' as never));

    expect(h.logger.entries.some((e) => e.event === 'finalize.memory_failed')).toBe(true);
    expect(h.db.repos.runs.get(runId).status).toBe('queued');
    expect(h.db.repos.steps.get(fin?.id ?? ('' as never)).state).toBe('pending');
  });

  it('ends a revise-until-limit run as incomplete with its report', async () => {
    h = await createHarness({ scenario: 'revise-until-limit' });
    await h.engine.start();
    const runId = await h.startRun();
    await h.waitForStatus(runId, ['awaiting_approval']);
    const detail = await h.engine.handle('relay/v1/runs.get', { runId });
    const a = detail.ok ? detail.data.pendingApproval : null;
    await h.engine.handle('relay/v1/approvals.decide', { idempotencyKey: 'approve-key-000002', approvalId: a?.id ?? '', planHash: a?.planHash ?? '', contextHash: a?.contextHash ?? '', decision: 'approved' });

    expect(await h.waitForStatus(runId, ['incomplete', 'completed', 'failed'])).toBe('incomplete');
    await h.waitFor(() => h?.db.repos.artifacts.listForRun(runId, ['report']).length === 1);
  });
});

describe('memory service (Wave-1 stub)', () => {
  it('snapshots, proposes, and summarizes nothing, always successfully', () => {
    const m = createMemoryService();
    expect([m.snapshotForRun('run_x' as never, 'prj_x' as never, {}), m.proposeFromRun('run_x' as never), m.recordRunSummary('run_x' as never)].every((r) => r.ok)).toBe(true);
  });
});
