// Founder decisions 1–3 end to end on the real runtime (SQLite file, real engine loop, fake provider):
//   1. an uncertain outcome is settled at once as an estimate ("~$X (estimated)", "may not have been charged"); old
//      databases are converted at start (idempotent); the ledger balances, nothing stays reserved, nothing is counted twice;
//   2. Pause in queued / running / awaiting_approval resumes exactly where it stopped; Export works while in progress;
//   3. per-step output limits: an override changes the reservation; a bad one is refused.
import { existsSync } from 'node:fs';
import { copyFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { upperBound } from '@relay/contracts';
import type { RunId } from '@relay/contracts';
import { allRuns, expectLedgerMatchesAttempts, expectNoNegativeReserved } from '../helpers/assert-ledger.js';
import { DEFAULT_REL_PATHS, createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { FIXTURE_DB_PATH } from '../helpers/make-fixture-db.js';
import { cleanupTempDirs, copyFixture, makeTempDir } from '../helpers/temp-dirs.js';
import { attemptEntries, expectedEstimate } from './uncertain-estimate.js';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const x of harnesses.splice(0)) await x.dispose();
  await cleanupTempDirs();
});

async function open(o: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const x = await createHarness(o);
  harnesses.push(x);
  return x;
}

const notActive = (r: { status: string }) => !['queued', 'running'].includes(r.status);

async function detail(h: Harness, runId: RunId) {
  const d = await h.call('relay/v1/runs.get', { runId });
  if (!d.ok) throw new Error(d.error.code);
  return d.data;
}

/** Every attempt of every run: nothing reserved after it finished, no unknown liability, ledger = Σ attempts. */
function expectBalancedLedger(h: Harness): void {
  expectNoNegativeReserved(h.db);
  for (const run of allRuns(h.db)) {
    expectLedgerMatchesAttempts(h.db, run.id);
    expect(h.db.repos.ledger.runBalances(run.id).U, `U of ${run.id}`).toBe(0);
    for (const a of h.db.repos.attempts.listForRun(run.id)) {
      if (['created', 'reserved', 'dispatching'].includes(a.state)) continue;
      expect(h.db.repos.ledger.attemptBalances(a.id), a.id).toEqual(expect.objectContaining({ reserved: 0, unknown: 0 }));
    }
  }
}

async function exportTo(h: Harness, runId: RunId, what: 'report' | 'patch' | 'both') {
  const dir = await makeTempDir('relay-int-decisions-export-');
  const res = await h.call('relay/v1/artifacts.exportTo', { runId, what, destinationRealpath: dir });
  const files = await readdir(dir);
  const read = async (suffix: string) => {
    const f = files.find((n) => n.endsWith(suffix));
    return f === undefined ? null : readFile(join(dir, f), 'utf8');
  };
  return { res, md: await read('.md'), patch: await read('.patch') };
}

describe('decision 1: uncertain outcomes are estimates @m3', () => {
  it('no response byte → estimate with "may not have been charged"; survives a restart with no unknowns; only retry_step / stop; retry completes; ledger balanced @m3', async () => {
    const first = await open({ scenario: 'unknown-before-response' });
    const runId = await first.startRun();
    await first.waitFor(runId, 'awaiting_approval');
    await first.approve(runId);
    const paused = await first.waitFor(runId, notActive);
    expect([paused.status, paused.pauseReason]).toEqual(['paused', 'unknown_outcome']);
    const [a] = first.attempts(runId, 'implement');
    const E = expectedEstimate(a!, 0);
    expect(attemptEntries(first.db, runId, a!.id).map(([t, , d, c]) => [t, d, c])).toEqual([['reserve', a!.reservationMicrousd, null], ['release', 0 - a!.reservationMicrousd, null], ['settle', E, 'estimated']]);
    await first.dispose();

    const h = await open({ scenario: 'unknown-before-response', userDataDir: first.userDataDir, projectRoot: first.projectRoot });
    const d = await detail(h, runId);
    expect(d.availableActions).toEqual(['retry_step', 'stop', 'export_report']);
    expect(d.unresolvedAttempts).toEqual([]);
    expect(d.uncertainAttempts.map((v) => [v.id, v.state, v.cost, v.mayNotHaveBeenCharged])).toEqual([[a!.id, 'unknown', { microusd: E, certainty: 'estimated' }, true]]);
    expect([d.cost.hasEstimates, d.cost.unknown, d.cost.settledEstimated]).toEqual([true, 0, E]);
    const decide = await h.decideUnknown(runId, a!.id, 'accept_estimated_charge');
    expect(decide.ok ? null : decide.error.details?.['reason']).toBe('decision_not_applicable');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.calls({ runId, stepKey: 'implement' })).toHaveLength(1); // never retried on its own

    const retried = await h.retryStep(runId, 'implement');
    expect(retried.ok && ['queued', 'running']).toContain(retried.ok ? retried.data.status : null);
    const done = await h.waitFor(runId, notActive);
    expect(done.status).toBe('completed');
    expect(h.calls({ runId, stepKey: 'implement' })).toHaveLength(2);
    expect(h.db.repos.ledger.attemptBalances(a!.id)).toEqual({ reserved: 0, unknown: 0, settled: E }); // counted exactly once
    expectBalancedLedger(h);
    const { md } = await exportTo(h, runId, 'report');
    expect(md).toContain(`- implement attempt ${a!.id}: ~$`);
    expect(md).toContain('(estimated) — the outcome was uncertain; may not have been charged');
    expect(md).toContain('(includes estimates)');
    expect(md).not.toContain('In progress');
  });

  it.skipIf(!existsSync(FIXTURE_DB_PATH))('the pilot DB (pre-decision-1 unknown liabilities) converts at engine start: U = 0 everywhere, C grows by the estimates only, idempotent across restarts, logged @m4', async () => {
    const userDataDir = await makeTempDir('relay-int-decisions-ud-');
    await copyFile(FIXTURE_DB_PATH, join(userDataDir, 'relay.sqlite'));
    const projectRoot = await copyFixture('sample-api');
    const cold = await open({ userDataDir, projectRoot, start: false });
    const before = new Map(allRuns(cold.db).map((r) => [r.id, cold.db.repos.ledger.runBalances(r.id)]));
    const legacy = cold.db.repos.ledger.openUnknownLiabilities();
    expect(legacy.length).toBeGreaterThan(0); // the fixture holds an undecided unknown charge
    await cold.dispose();

    const h = await open({ userDataDir, projectRoot });
    expect(h.db.repos.ledger.openUnknownLiabilities()).toEqual([]);
    expect(h.logger.lines.some((l) => l.includes('"recovery.unknown_converted"'))).toBe(true);
    let estimates = 0;
    for (const { attemptId } of legacy) {
      const a = h.db.repos.attempts.get(attemptId!);
      expect(a.outcomeUncertain).toBe(true);
      estimates += h.db.repos.ledger.attemptBalances(a.id).settled;
    }
    let grown = 0;
    for (const [runId, b] of before) {
      const after = h.db.repos.ledger.runBalances(runId);
      expect([after.L, after.R, after.U]).toEqual([b.L, b.R, 0]);
      grown += after.C - b.C;
    }
    expect(grown).toBe(estimates);
    expectBalancedLedger(h);
    for (const run of allRuns(h.db).filter((r) => r.status === 'paused' && r.pauseReason === 'unknown_outcome')) {
      expect((await detail(h, run.id)).availableActions).toEqual(expect.arrayContaining(['stop']));
      expect((await detail(h, run.id)).availableActions).not.toContain('decide_unknown');
    }
    const entries = h.db.repos.ledger.listForRun(allRuns(h.db)[0]!.id).length;
    await h.dispose();

    const again = await open({ userDataDir, projectRoot });
    expect(again.logger.lines.some((l) => l.includes('"recovery.unknown_converted"'))).toBe(false); // nothing left to convert
    expect(again.db.repos.ledger.listForRun(allRuns(again.db)[0]!.id)).toHaveLength(entries);
    expectBalancedLedger(again);
  });
});

describe('decision 2: Pause and Export while in progress @m3', () => {
  it('pause during an in-flight call: the call completes, the pause applies before the next step, resume continues without re-running anything @m3', async () => {
    const h = await open({ scenario: { name: 'slow-plan', steps: [{ match: { stepKey: 'plan' }, delayMs: 400, result: { kind: 'success' } }] } });
    const runId = await h.startRun();
    await h.waitUntil(() => h.attempts(runId, 'plan')[0]?.state === 'dispatching', 10_000, 'plan in flight');

    const paused = await h.call('relay/v1/runs.pause', { runId });
    expect(paused.ok && paused.data).toEqual({ status: 'running', inFlight: 'waiting' });
    const run = await h.waitFor(runId, notActive);

    expect([run.status, run.pauseReason]).toEqual(['paused', 'user']);
    expect(h.attempts(runId, 'plan').map((a) => a.state)).toEqual(['succeeded']); // completed normally
    expect(h.steps(runId, 'plan').at(-1)?.state).toBe('succeeded');
    expect(h.db.repos.approvals.pendingForRun(runId)).toBeUndefined(); // paused before the approval step
    const outputOf = (key: string) => h.steps(runId, key).at(-1)?.outputArtifactId ?? null;
    const outputs = [outputOf('review'), outputOf('plan')];
    expect(outputs.every((o) => o !== null)).toBe(true);

    const resumed = await h.resume(runId, { kind: 'continue' });
    expect(resumed.ok && resumed.data.status).toBe('queued');
    await h.waitFor(runId, 'awaiting_approval');
    expect([outputOf('review'), outputOf('plan')]).toEqual(outputs); // completed steps keep their outputs
    await h.approve(runId);
    expect((await h.waitFor(runId, notActive)).status).toBe('completed');
    expect(h.calls({ runId }).map((c) => c.stepKey)).toEqual(['review', 'plan', 'implement', 'verify']); // nothing ran twice
    expectBalancedLedger(h);
  });

  it('pause while awaiting approval keeps the approval; resume returns to awaiting_approval; export while paused writes an interim report (never stored) @m3', async () => {
    const h = await open();
    const runId = await h.startRun();
    await h.waitFor(runId, 'awaiting_approval');
    const pending = (await detail(h, runId)).pendingApproval;

    const paused = await h.call('relay/v1/runs.pause', { runId });
    expect(paused.ok && paused.data).toEqual({ status: 'paused', inFlight: 'none' });
    const d = await detail(h, runId);
    expect([d.status, d.pauseReason, d.pendingApproval?.id, d.availableActions]).toEqual(['paused', 'user', pending?.id, ['resume', 'stop', 'export_report']]);

    const { res, md } = await exportTo(h, runId, 'both');
    expect(res.ok && [res.data.written?.map((w) => w.what), res.data.failed?.map((f) => [f.what, f.code])]).toEqual([['report'], [['patch', 'NOT_FOUND']]]);
    expect(md).toMatch(/^# Relay run report \(in progress\) — run_\w+\n\n> In progress — exported \d{4}-\d{2}-\d{2}T\S+Z; 3 of 7 steps finished\n/);
    expect(md).toContain('- Status: paused');
    expect(md).toContain('### review — findings (');
    expect(md).toContain('### plan — plan (');
    expect(md).toContain('| not decided |');
    expect(h.db.repos.artifacts.listForRun(runId, ['report'])).toEqual([]);

    const resumed = await h.resume(runId, { kind: 'continue' });
    expect(resumed.ok && resumed.data.status).toBe('awaiting_approval');
    expect((await detail(h, runId)).pendingApproval?.id).toBe(pending?.id);
    await h.approve(runId);
    expect((await h.waitFor(runId, notActive)).status).toBe('completed');
    const final = await exportTo(h, runId, 'both');
    expect(final.md).not.toContain('In progress');
    expect(final.res.ok && final.res.data.written?.map((w) => w.what)).toEqual(['report', 'patch']);
    expect(h.calls({ runId, stepKey: 'plan' })).toHaveLength(1);
  });

  it('pause while queued (behind a running run): paused at once, never started; resume → it runs; every offered action succeeds @m3', async () => {
    const h = await open({ scenario: { name: 'slow-review', steps: [{ match: { stepKey: 'review' }, times: 1, delayMs: 300, result: { kind: 'success' } }] } });
    const first = await h.startRun();
    await h.waitFor(first, 'running');
    const second = await h.startRun();
    expect((await detail(h, second)).availableActions).toEqual(['pause', 'cancel', 'export_report']);

    const paused = await h.call('relay/v1/runs.pause', { runId: second });
    expect(paused.ok && paused.data).toEqual({ status: 'paused', inFlight: 'none' });
    await h.waitFor(first, 'awaiting_approval');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.db.repos.runs.get(second)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'user', startedAt: null }));
    expect(h.calls({ runId: second })).toEqual([]);

    const resumed = await h.resume(second, { kind: 'continue' });
    expect(resumed.ok && resumed.data.status).toBe('queued');
    await h.waitFor(second, 'awaiting_approval');
    expect(h.calls({ runId: second }).map((c) => c.stepKey)).toEqual(['review', 'plan']);
  });
});

describe('decision 3: per-step output limits @m3', () => {
  const base = (h: Harness, extra: Record<string, unknown>) => ({
    projectId: h.projectId, workflowId: h.workflowId, workflowVersion: 1, goal: 'Fix the defects in the handlers.',
    input: { kind: 'files' as const, relPaths: [...DEFAULT_REL_PATHS] }, ...extra,
  });

  it('preflight shows the boxes; an override sets the snapshot, the request maximum and the reservation; a too-large one is refused @m3', async () => {
    const h = await open();

    const pre = await h.call('relay/v1/runs.preflight', base(h, { outputTokenOverrides: { review: 2_000 } }));
    const bad = await h.call('relay/v1/runs.start', { idempotencyKey: 'int-d3-start-bad-01', ...base(h, { outputTokenOverrides: { review: 64_001 } }) });
    const started = await h.call('relay/v1/runs.start', { idempotencyKey: 'int-d3-start-ok-001', ...base(h, { outputTokenOverrides: { review: 2_000 } }) });

    expect(pre.ok && pre.data.stepLimits.map((s) => [s.stepKey, s.defaultMaxOutputTokens, s.minMaxOutputTokens, s.modelMaxOutputTokens])).toEqual([
      ['review', 8_000, 256, 64_000], ['plan', 8_000, 256, 128_000], ['implement', 16_000, 256, 128_000], ['verify', 8_000, 256, 128_000],
    ]);
    expect(bad.ok ? null : [bad.error.code, (bad.error.details?.['issues'] as { path: string }[])[0]?.path]).toEqual(['VALIDATION_FAILED', 'outputTokenOverrides.review']);
    if (!started.ok) throw new Error(started.error.code);
    const runId = started.data.runId;
    await h.waitFor(runId, 'awaiting_approval');
    const [review] = h.attempts(runId, 'review');
    const estimate = review!.estimate as { inputTokens: number; maxOutputTokens: number };
    expect(estimate.maxOutputTokens).toBe(2_000);
    expect(review!.reservationMicrousd).toBe(upperBound(estimate.inputTokens, 2_000, review!.profileSnapshot.prices));
    expect(pre.ok && pre.data.firstReservation.N).toBe(upperBound(pre.ok ? pre.data.inputSummary.estimatedInputTokens : 0, 2_000, review!.profileSnapshot.prices));
    expect(h.attempts(runId, 'plan')[0]?.estimate).toEqual(expect.objectContaining({ maxOutputTokens: 8_000 })); // default
  });
});
