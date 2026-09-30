// 11 §K6 run-happy-path (@m2): the full review-propose-fix template end to end on the fake `happy-path` scenario,
// composed through createRuntime (real storage, tools, templates, engine).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeCost } from '@relay/contracts';
import type { RunId } from '@relay/contracts';
import { expectLedgerMatchesAttempts, expectNoNegativeReserved } from '../helpers/assert-ledger.js';
import { createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { computeFixtureManifest } from '../helpers/fixture-hash.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

function statusTrail(x: Harness, runId: RunId): string[] {
  const events = x.db.repos.events.list(runId, 0, 1000).filter((e) => e.type === 'run.status_changed');
  return ['queued', ...events.map((e) => (e.payload as { to: string }).to)];
}

describe('run happy path @m2', () => {
  it('queued → running → awaiting_approval → running → completed, 4 model attempts, report, output ≠ raw, calculated ledger, project untouched @m2', async () => {
    h = await createHarness({ scenario: 'happy-path' });
    const before = await computeFixtureManifest(h.projectRoot);

    const runId = await h.startRun();
    await h.waitFor(runId, 'awaiting_approval');
    expect((await h.approve(runId)).ok).toBe(true);
    const run = await h.waitFor(runId, ['completed', 'incomplete', 'failed', 'cancelled', 'paused']);

    expect(run.status).toBe('completed');
    expect(statusTrail(h, runId)).toEqual(['queued', 'running', 'awaiting_approval', 'queued', 'running', 'completed']);
    const r = h.db.repos;
    const latest = r.steps.latestPerStepKey(runId);
    expect(latest.map((s) => [s.stepKey, s.state])).toEqual([
      ['intake', 'succeeded'], ['review', 'succeeded'], ['plan', 'succeeded'], ['approve', 'succeeded'],
      ['implement', 'succeeded'], ['verify', 'succeeded'], ['finalize', 'succeeded'],
    ]);

    // 4 model attempts (review, plan, implement, verify), one fake call each.
    const attempts = r.attempts.listForRun(runId);
    expect(attempts.map((a) => a.state)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    for (const k of ['review', 'plan', 'implement', 'verify']) expect(h.calls({ runId, stepKey: k })).toHaveLength(1);
    expect(h.calls({ runId })).toHaveLength(4);

    // Validated output artifact AND raw response artifact exist on disk for every model attempt; bytes differ.
    await h.waitUntil(() => r.artifacts.listForRun(runId, ['report']).length > 0, 10_000, 'report artifact'); // post-commit effect
    const artifacts = r.artifacts.listForRun(runId);
    for (const a of attempts) {
      const mine = artifacts.filter((x) => x.attemptId === a.id);
      const raw = mine.find((x) => x.kind === 'raw_response');
      const out = mine.find((x) => ['findings', 'plan', 'patch', 'review'].includes(x.kind));
      expect(raw, `raw_response of ${a.id}`).toBeDefined();
      expect(out, `output of ${a.id}`).toBeDefined();
      if (raw === undefined || out === undefined) continue;
      const rawBytes = await readFile(join(h.userDataDir, raw.relPath));
      const outBytes = await readFile(join(h.userDataDir, out.relPath));
      expect(rawBytes.length).toBe(raw.sizeBytes);
      expect(outBytes.length).toBe(out.sizeBytes);
      expect(out.sha256).not.toBe(raw.sha256);
      expect(JSON.parse(outBytes.toString('utf8'))).toBeTypeOf('object');
    }
    const report = artifacts.filter((x) => x.kind === 'report');
    expect(report).toHaveLength(1);
    expect((await readFile(join(h.userDataDir, report[0]!.relPath))).length).toBeGreaterThan(0);
    // The patch applied to the snapshot: implement's output is a validated patch over the approved scope.
    const patch = artifacts.find((x) => x.kind === 'patch');
    const patchJson = JSON.parse(await readFile(join(h.userDataDir, patch!.relPath), 'utf8')) as { files: { relPath: string }[] };
    expect(patchJson.files.map((f) => f.relPath).sort()).toEqual(['src/handlers/orders.ts', 'src/handlers/user.ts', 'src/lib/format.ts']);

    // Ledger = Σ usage × snapshot prices, certainty calculated; nothing reserved or unknown.
    const expected = attempts.reduce((sum, a) => sum + computeCost(a.usage!, a.profileSnapshot.prices).microusd, 0);
    const b = r.ledger.runBalances(runId);
    expect(b).toEqual(expect.objectContaining({ C: expected, R: 0, U: 0 }));
    expect(r.ledger.settledByCertainty(runId)).toEqual(expect.objectContaining({ calculated: expected, estimated: 0 }));
    expectNoNegativeReserved(h.db);
    expectLedgerMatchesAttempts(h.db, runId);

    // FR-10: the project tree is unchanged.
    const after = await computeFixtureManifest(h.projectRoot);
    expect(after.treeHash).toBe(before.treeHash);
  });
});
