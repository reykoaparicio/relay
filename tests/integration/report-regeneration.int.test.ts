// 06 F1 step 3 / F17 crash-safety (Referee audit item 2): a terminal run whose post-commit report never ran (a crash
// between the terminal commit and the report write, simulated by committing the status directly) gets its report at
// the next `engine.start()` — exactly once, however often the runner restarts.
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

describe('report regeneration at start @m4', () => {
  it('terminal commit without its report → restart writes the report once; a second restart writes nothing @m4', async () => {
    h = await createHarness({ start: false });
    const { userDataDir, projectRoot } = h;
    const runId = await h.startRun();
    // The terminal transition commits, but the process dies before its post-commit report effect runs.
    expect(h.db.repos.runs.updateStatus(runId, ['queued'], 'cancelled', {})).toBe(true);
    expect(h.db.repos.artifacts.listForRun(runId, ['report'])).toEqual([]);
    await h.dispose();

    h = await createHarness({ userDataDir, projectRoot }); // restart: engine.start()
    const reports = h.db.repos.artifacts.listForRun(runId, ['report']);
    expect(reports).toHaveLength(1);
    const bytes = await h.artifacts.read(reports[0]?.relPath ?? '', 1_000_000);
    if (!bytes.ok) throw new Error(bytes.error.code);
    const report = reportV1Schema.parse(JSON.parse(Buffer.from(bytes.value).toString('utf8')));
    expect([report.runId, report.status, report.approvals, report.revisions?.cycles]).toEqual([runId, 'cancelled', [], 0]);
    await h.dispose();

    h = await createHarness({ userDataDir, projectRoot }); // second restart
    expect(h.db.repos.artifacts.listForRun(runId, ['report']).map((a) => a.id)).toEqual(reports.map((a) => a.id));
    expect(h.db.repos.events.list(runId, 0, 100).filter((e) => e.type === 'report.created')).toHaveLength(1);
  });
});
