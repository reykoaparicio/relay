/**
 * Budget-contention worker (11 §K5 `budget-contention.int.test.ts`). Each worker thread opens its OWN `DatabaseSync`
 * connection (through @relay/storage `openDb`) on the shared userData DB, waits on a shared barrier, then races an
 * admission check + reserve inside one `BEGIN IMMEDIATE` transaction (`db.tx('immediate')`). The §9.3 admission
 * inequality `C + R + U + N <= L` is restated here because the engine does not export its internal `admit`.
 */
import './no-network.js';
import { randomBytes } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { createIdGen, epochMs, systemClock } from '@relay/contracts';
import type { ProjectId, RunId } from '@relay/contracts';
import { openDb } from '@relay/storage';

export interface ContentionJob {
  readonly dbPath: string;
  readonly backupsDir: string;
  readonly runId: RunId;
  readonly projectId: ProjectId;
  readonly N: number;
  /** 'run' checks the run allowance; 'project' checks the project-month allowance too. */
  readonly scope: 'run' | 'project';
  readonly projectAllowance: number | null;
  /** Int32Array over a SharedArrayBuffer: [arrived]. */
  readonly barrier: SharedArrayBuffer;
  readonly parties: number;
}

export type ContentionResult = { readonly outcome: 'reserved' | 'BUDGET_BLOCKED'; readonly details: Record<string, number> } | { readonly outcome: 'error'; readonly message: string };

function monthWindow(now: number): { start: number; end: number } {
  const d = new Date(now);
  return { start: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), end: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() };
}

async function main(job: ContentionJob): Promise<ContentionResult> {
  const ids = createIdGen(systemClock, (n) => new Uint8Array(randomBytes(n)));
  const db = await openDb({ path: job.dbPath, clock: systemClock, ids, backupsDir: job.backupsDir });
  try {
    const arrived = new Int32Array(job.barrier);
    Atomics.add(arrived, 0, 1);
    Atomics.notify(arrived, 0);
    while (Atomics.load(arrived, 0) < job.parties) Atomics.wait(arrived, 0, Atomics.load(arrived, 0), 50);
    return db.tx('immediate', (r): ContentionResult => {
      const run = r.ledger.runBalances(job.runId);
      const runTotal = run.C + run.R + run.U + job.N;
      if (runTotal > run.L) return { outcome: 'BUDGET_BLOCKED', details: { scope: 0, L: run.L, C: run.C, R: run.R, U: run.U, N: job.N } };
      if (job.scope === 'project' && job.projectAllowance !== null) {
        const { start, end } = monthWindow(Date.now());
        const p = r.ledger.projectMonthBalances(job.projectId, epochMs(start), epochMs(end));
        if (p.C + p.R + p.U + job.N > job.projectAllowance) {
          return { outcome: 'BUDGET_BLOCKED', details: { scope: 1, L: job.projectAllowance, C: p.C, R: p.R, U: p.U, N: job.N } };
        }
      }
      r.ledger.append([{ scope: 'run', type: 'reserve', bucket: 'reserved', deltaMicrousd: job.N, runId: job.runId, projectId: job.projectId }]);
      return { outcome: 'reserved', details: { N: job.N } };
    });
  } finally {
    db.close();
  }
}

main(workerData as ContentionJob).then(
  (res) => parentPort?.postMessage(res),
  (e: unknown) => parentPort?.postMessage({ outcome: 'error', message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) } satisfies ContentionResult),
);
