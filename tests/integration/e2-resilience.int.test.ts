// E2 database resilience over the real runtime: a lock held by another process during use never blocks the event loop
// for seconds and never fails a run (#2); diagnostics count the WAL (#5); report regeneration is bounded at start and
// finishes in the background (#6); an automatic backup is taken at start (#4); lowering the raw-response retention
// sweeps right away (#19).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunId } from '@relay/contracts';
import { openNodeSqlite } from '@relay/storage';
import type { SqlDriver } from '@relay/storage';
import { createHarness, sleep } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { createManualClock } from '../helpers/manual-clock.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
let holder: SqlDriver | undefined;
afterEach(async () => {
  if (holder?.inTransaction === true) holder.exec('ROLLBACK');
  holder?.close();
  holder = undefined;
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

/** Another process's connection holding the write lock (BEGIN IMMEDIATE) until released. */
function lockDb(dbPath: string): SqlDriver {
  const d = openNodeSqlite(dbPath);
  d.exec('BEGIN IMMEDIATE');
  holder = d;
  return d;
}

/** Longest gap between ticks of a 20 ms interval while `fn` runs: how long the event loop was blocked. */
async function maxLoopGap<T>(fn: () => Promise<T>): Promise<{ out: T; gap: number }> {
  let last = performance.now();
  let gap = 0;
  const t = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
  }, 20);
  try {
    const out = await fn();
    return { out, gap };
  } finally {
    clearInterval(t);
  }
}

describe('E2 database busy during use (#2)', () => {
  it('a write op under a foreign lock fails fast with retryable DATABASE_UNAVAILABLE database_busy; the event loop is never blocked for seconds', async () => {
    const x = await createHarness();
    h = x;
    lockDb(x.dbPath);

    const t0 = performance.now();
    const { out, gap } = await maxLoopGap(() => x.call('relay/v1/app.updateSettings', { theme: 'dark' }));
    const elapsed = performance.now() - t0;

    expect(out.ok ? null : out.error).toMatchObject({ code: 'DATABASE_UNAVAILABLE', retryable: true, nextAction: 'wait', details: { reason: 'database_busy' } });
    expect(elapsed).toBeLessThan(2_000); // busy_timeout was 5 s
    expect(gap).toBeLessThan(1_000);
    holder?.exec('ROLLBACK');
    const ok = await x.call('relay/v1/app.updateSettings', { theme: 'dark' });
    expect(ok.ok).toBe(true);
  });

  it('a lock held while a run is in progress backs the loop off; the run is never failed and continues after the release', async () => {
    const x = await createHarness();
    h = x;
    const runId = await x.startRun();
    lockDb(x.dbPath);
    await sleep(1_200);
    expect(x.db.repos.runs.get(runId).status).not.toBe('failed'); // reads still work in WAL mode
    holder?.exec('ROLLBACK');

    const run = await x.waitFor(runId, ['awaiting_approval', 'failed', 'paused']);

    expect(run.status).toBe('awaiting_approval');
  });
});

describe('E2 diagnostics, reports, backups, retention', () => {
  it('#5: app.getDiagnostics db.sizeBytes includes the WAL', async () => {
    const x = await createHarness();
    h = x;
    const d = await x.call('relay/v1/app.getDiagnostics', {});
    const main = statSync(x.dbPath).size;
    const wal = statSync(`${x.dbPath}-wal`).size;

    expect(wal).toBeGreaterThan(0);
    expect(d.ok && d.data.db.sizeBytes).toBeGreaterThanOrEqual(main + wal - 64 * 1024); // the WAL may grow between stats
    expect(d.ok && d.data.db.sizeBytes).toBeGreaterThan(main);
  });

  it('#6: missing reports never hold up start beyond a bounded first batch; the rest are generated in the background', async () => {
    let x = await createHarness({ start: false });
    h = x;
    const { userDataDir, projectRoot } = x;
    const runs: RunId[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await x.startRun();
      expect(x.db.repos.runs.updateStatus(id, ['queued'], 'cancelled', {})).toBe(true);
      runs.push(id);
    }
    await x.dispose();

    x = await createHarness({ userDataDir, projectRoot });
    h = x;
    const atReady = runs.filter((id) => x.db.repos.artifacts.listForRun(id, ['report']).length === 1).length;
    await x.waitUntil(() => runs.every((id) => x.db.repos.artifacts.listForRun(id, ['report']).length === 1), 15_000, 'all reports');

    expect(atReady).toBeLessThanOrEqual(2);
    expect(x.db.repos.runs.listTerminalWithoutReport()).toEqual([]);
  });

  it('#4: start takes a rolling automatic backup (atomic: manifest present, no *.partial left)', async () => {
    const x = await createHarness();
    h = x;
    const dir = join(x.userDataDir, 'backups-auto'); // its own folder: backups/ keeps only manual + pre-migration ones

    await x.waitUntil(() => {
      try {
        return readdirSync(dir).some((n) => n.endsWith('-auto'));
      } catch {
        return false;
      }
    }, 10_000, 'auto backup');
    const auto = readdirSync(dir).filter((n) => n.endsWith('-auto'));

    expect(auto).toHaveLength(1);
    expect(readdirSync(join(dir, auto[0] ?? '')).sort()).toEqual(['manifest.json', 'relay.sqlite']);
    expect(readdirSync(dir).filter((n) => n.endsWith('.partial'))).toEqual([]);
  });

  it('#19: lowering rawResponseRetentionDays purges the now-expired raw responses immediately; raising it does not', async () => {
    const mc = createManualClock();
    const x = await createHarness({ clock: mc });
    h = x;
    const runId = await x.startRun();
    const pump = setInterval(() => {
      mc.advance(50);
    }, 5);
    try {
      await x.waitFor(runId, 'awaiting_approval', 30_000);
    } finally {
      clearInterval(pump);
    }
    const raw = () => x.db.repos.artifacts.listForRun(runId, ['raw_response']);
    expect(raw().length).toBeGreaterThan(0);
    mc.advance(3 * 86_400_000);

    const raised = await x.call('relay/v1/app.updateSettings', { rawResponseRetentionDays: 60 });
    expect(raised.ok).toBe(true);
    expect(raw().every((a) => a.purgedAt === null)).toBe(true);

    const lowered = await x.call('relay/v1/app.updateSettings', { rawResponseRetentionDays: 2 });

    expect(lowered.ok && lowered.data.rawResponseRetentionDays).toBe(2);
    expect(raw().every((a) => a.purgedAt !== null)).toBe(true);
  });
});
