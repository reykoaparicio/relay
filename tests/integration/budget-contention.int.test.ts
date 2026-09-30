// 11 §K5 / §17.1 "Two reservations contend" (@m3): two DatabaseSync connections in two worker threads (tsx execArgv,
// no-network imported first) race admit + reserve for the same run where L admits only one → exactly 1 reserve entry;
// the loser gets BUDGET_BLOCKED (BEGIN IMMEDIATE serialization). Also project-month contention across 2 runs.
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunId } from '@relay/contracts';
import type { ContentionJob, ContentionResult } from '../helpers/contention-worker.js';
import { createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { queryAll } from '../helpers/sqlite-inspect.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

const WORKER_URL = new URL('../helpers/contention-worker.ts', import.meta.url);

function race(jobs: readonly Omit<ContentionJob, 'barrier' | 'parties'>[]): Promise<ContentionResult[]> {
  const barrier = new SharedArrayBuffer(4);
  return Promise.all(jobs.map((job) => new Promise<ContentionResult>((resolve, reject) => {
    const w = new Worker(WORKER_URL, { execArgv: ['--import', 'tsx', '--conditions=development'], workerData: { ...job, barrier, parties: jobs.length } });
    w.once('message', (m: ContentionResult) => {
      resolve(m);
      void w.terminate();
    });
    w.once('error', reject);
  })));
}

const N = 100_000;
const reserves = (x: Harness, runIds: readonly RunId[]) =>
  queryAll(x.dbPath, `SELECT run_id AS runId FROM ledger_entries WHERE type = 'reserve' AND run_id IN (${runIds.map(() => '?').join(',')})`, ...runIds);

describe('budget contention @m3', () => {
  it('same run, L admits one N: exactly one reserve entry; the loser is BUDGET_BLOCKED (BEGIN IMMEDIATE) @m3', async () => {
    h = await createHarness({ start: false });
    const runId = await h.startRun({ limits: { budgetMicrousd: N + N / 2 } });
    const base = { dbPath: h.dbPath, backupsDir: join(h.userDataDir, 'backups'), runId, projectId: h.projectId, N, scope: 'run' as const, projectAllowance: null };

    const results = await race([base, base]);

    expect(results.filter((r) => r.outcome === 'error')).toEqual([]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['BUDGET_BLOCKED', 'reserved']);
    const loser = results.find((r) => r.outcome === 'BUDGET_BLOCKED');
    expect(loser?.outcome === 'BUDGET_BLOCKED' && loser.details).toEqual({ scope: 0, L: N + N / 2, C: 0, R: N, U: 0, N });
    expect(reserves(h, [runId])).toHaveLength(1);
    expect(h.db.repos.ledger.runBalances(runId).R).toBe(N);
  });

  it('project month: two runs of one project race for an allowance that admits one N → exactly one reserve @m3', async () => {
    h = await createHarness({ start: false, monthlyAllowanceMicrousd: N + N / 2 });
    const a = await h.startRun({ key: 'contention-run-a-01', limits: { budgetMicrousd: 10 * N } });
    const b = await h.startRun({ key: 'contention-run-b-01', limits: { budgetMicrousd: 10 * N } });
    const base = { dbPath: h.dbPath, backupsDir: join(h.userDataDir, 'backups'), projectId: h.projectId, N, scope: 'project' as const, projectAllowance: N + N / 2 };

    const results = await race([{ ...base, runId: a }, { ...base, runId: b }]);

    expect(results.filter((r) => r.outcome === 'error')).toEqual([]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['BUDGET_BLOCKED', 'reserved']);
    const loser = results.find((r) => r.outcome === 'BUDGET_BLOCKED');
    expect(loser?.outcome === 'BUDGET_BLOCKED' && loser.details).toEqual(expect.objectContaining({ scope: 1, R: N, N }));
    expect(reserves(h, [a, b])).toHaveLength(1);
  });
});
