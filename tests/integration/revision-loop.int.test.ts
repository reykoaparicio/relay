// 11 §K6 revision loop (@m3): revise → accept (1 cycle, no new approval inside the approved scope); revise ×3 with
// maxRevisionCycles 2 → incomplete, artifacts retained, a report.v1 artifact generated.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reportV1Schema } from '@relay/contracts';
import { createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

describe('revision loop @m3', () => {
  it('revise-then-accept: one revision cycle (implement + verify repeated), no second approval, completed @m3', async () => {
    h = await createHarness({ scenario: 'revise-then-accept' });
    const runId = await h.startRun();
    await h.waitFor(runId, 'awaiting_approval');
    await h.approve(runId);

    const run = await h.waitFor(runId, ['completed', 'incomplete', 'paused', 'failed', 'awaiting_approval']);

    expect(run.status).toBe('completed');
    expect(run.revisionCycle).toBe(1);
    expect(h.calls({ runId, stepKey: 'implement' })).toHaveLength(2);
    expect(h.calls({ runId, stepKey: 'verify' })).toHaveLength(2);
    expect(h.calls({ runId, stepKey: 'plan' })).toHaveLength(1);
    expect(h.steps(runId, 'approve')).toHaveLength(1);
    expect(h.steps(runId, 'implement').map((s) => s.revisionIndex)).toEqual([0, 1]);
  });

  it('revise-until-limit with maxRevisionCycles 2: revise ×3 → incomplete, artifacts retained, report.v1 generated @m3', async () => {
    h = await createHarness({ scenario: 'revise-until-limit', limits: { maxRevisionCycles: 2 } });
    const runId = await h.startRun();
    await h.waitFor(runId, 'awaiting_approval');
    await h.approve(runId);

    const run = await h.waitFor(runId, ['completed', 'incomplete', 'paused', 'failed', 'awaiting_approval']);

    expect(run.status).toBe('incomplete');
    expect(h.calls({ runId, stepKey: 'verify' })).toHaveLength(3);
    expect(h.calls({ runId, stepKey: 'implement' })).toHaveLength(3);
    const patches = h.db.repos.artifacts.listForRun(runId, ['patch']);
    expect(patches.length).toBeGreaterThanOrEqual(1); // retained
    for (const p of patches) expect((await readFile(join(h.userDataDir, p.relPath))).length).toBe(p.sizeBytes);
    await h.waitUntil(() => h!.db.repos.artifacts.listForRun(runId, ['report']).length === 1, 10_000, 'report');
    const [report] = h.db.repos.artifacts.listForRun(runId, ['report']);
    expect(report?.schemaId).toBe('report.v1');
    const parsed = reportV1Schema.safeParse(JSON.parse(await readFile(join(h.userDataDir, report!.relPath), 'utf8')));
    expect(parsed.success).toBe(true);
  });
});
