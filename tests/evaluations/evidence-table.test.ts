// 13 §M4: scripts/evidence-table.ts against a dry-run fixture results dir (mixed completed / incomplete / failed /
// cancelled / cost-cap runs). The denominator must count every attempted run; empty cells print "Not yet measured".
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDirs, makeTempDir } from '../helpers/temp-dirs.js';
import { runScript } from './run-script.js';

afterEach(async () => {
  await cleanupTempDirs();
});

type Status = 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'not_started';

function result(config: string, taskId: string, repeat: number, status: Status, o: { stopReason?: string; calc?: number; est?: number; unknown?: number } = {}): unknown {
  return {
    schemaVersion: 1, config, taskId, repeat, order: repeat, runId: status === 'not_started' ? null : `run_${taskId}_${String(repeat)}`, status, pauseReason: null,
    stopReason: o.stopReason ?? null,
    costs: { settledReportedMicrousd: 0, settledCalculatedMicrousd: o.calc ?? 0, settledEstimatedMicrousd: o.est ?? 0, unknownMicrousd: o.unknown ?? 0 },
    elapsedMs: 1000, startedAt: '2026-10-01T00:00:00.000Z', steps: [], approvals: 0, artifacts: [],
  };
}

async function writeResults(dir: string, rows: readonly unknown[]): Promise<void> {
  for (const r of rows) {
    const x = r as { config: string; taskId: string; repeat: number };
    await mkdir(join(dir, x.config), { recursive: true });
    await writeFile(join(dir, x.config, `${x.taskId}-${String(x.repeat)}.json`), JSON.stringify(r));
  }
}

const row = (out: string, metric: string): string[] => {
  const line = out.split('\n').find((l) => l.startsWith(`| ${metric} |`));
  if (line === undefined) throw new Error(`no row ${metric}\n${out}`);
  return line.split('|').slice(1, -1).map((c) => c.trim());
};

describe('evidence-table', () => {
  it('counts incomplete, failed, cancelled, and cost-cap runs in the denominator; only rubric-accepted runs in the numerator', async () => {
    const dir = await makeTempDir('relay-evidence-');
    await writeResults(dir, [
      result('relay', 'T1-a', 1, 'completed', { calc: 121_000 }),
      result('relay', 'T1-a', 2, 'completed', { calc: 100_000, est: 30_000 }),
      result('relay', 'T2-b', 1, 'incomplete', { calc: 90_000 }),
      result('relay', 'T3-c', 1, 'failed', { calc: 10_000 }),
      result('relay', 'T4-d', 1, 'cancelled', { calc: 5_000, unknown: 40_000 }),
      result('relay', 'T5-e', 1, 'cancelled', { stopReason: 'cost_cap', calc: 50_000 }),
      result('relay', 'T6-f', 1, 'not_started', { stopReason: 'cost_cap' }),
      result('single-agent', 'T1-a', 1, 'completed', { calc: 40_000 }),
      result('single-agent', 'T2-b', 1, 'failed'),
    ]);
    await writeFile(join(dir, 'scores.csv'), [
      'config,task,repeat,accepted,correctness,coverage,unintended_changes,explanation,review_minutes,setup_minutes,notes',
      'relay,T1-a,1,yes,2,2,2,2,6,,"first, accepted"',
      'relay,T1-a,2,yes,1,2,2,1,9,,accepted flag but correctness 1: not accepted by the rubric',
      'relay,T2-b,1,,,,,,4,,incomplete run still reviewed',
      'single-agent,T1-a,1,yes,2,2,1,1,12,,',
    ].join('\n'));

    const r = await runScript('evidence-table.ts', ['--results', dir]);

    expect(r.code, r.stderr).toBe(0);
    const accepted = row(r.stdout, 'Accepted tasks / total');
    expect(accepted[3]).toBe('1/7 (14%)'); // relay: 7 attempted (2 completed, incomplete, failed, cancelled, 2 cost-cap)
    expect(accepted[2]).toBe('1/2 (50%)'); // single-agent: the failed run counts too
    expect(accepted[1]).toBe('Not yet measured'); // no manual baseline rows
    const minutes = row(r.stdout, 'Median human intervention minutes');
    expect(minutes[3]).toBe('6 min (n = 3)');
    expect(minutes[2]).toBe('12 min (n = 1)');
    expect(row(r.stdout, 'Total tracked model cost')[3]).toBe('$0.41 tracked ($0.03 of it estimated; $0.04 unknown) over n = 7');
    expect(row(r.stdout, 'Median setup time')).toEqual(['Median setup time', 'Not yet measured', 'Not yet measured', 'Not yet measured', 'Not yet measured']);
    expect(row(r.stdout, 'Repeat users')[3]).toBe('Not yet observed');
    expect(r.stdout).toContain('relay: n = 7 attempted run(s)');
    expect(r.stdout).toContain('2 stopped by cost cap');
  });

  it('never shows a rate while a completed run is unscored', async () => {
    const dir = await makeTempDir('relay-evidence-');
    await writeResults(dir, [result('relay', 'T1-a', 1, 'completed'), result('relay', 'T2-b', 1, 'failed')]);

    const r = await runScript('evidence-table.ts', ['--results', dir]);

    expect(r.code, r.stderr).toBe(0);
    expect(row(r.stdout, 'Accepted tasks / total')[3]).toBe('Not yet measured (1 of 2 runs unscored)');
  });

  it('prints "Not yet measured" in every empty cell and invents no number', async () => {
    const dir = await makeTempDir('relay-evidence-');

    const r = await runScript('evidence-table.ts', ['--results', dir]);

    expect(r.code, r.stderr).toBe(0);
    for (const metric of ['Accepted tasks / total', 'Median human intervention minutes', 'Total tracked model cost', 'Median setup time']) {
      expect(row(r.stdout, metric).slice(1)).toEqual(['Not yet measured', 'Not yet measured', 'Not yet measured', 'Not yet measured']);
    }
    const table = r.stdout.split('\n').filter((l) => l.startsWith('|')).join('\n');
    expect(table).not.toMatch(/\d+\s*%|\$\d/);
  });
});
