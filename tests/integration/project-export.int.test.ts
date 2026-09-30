// 11 §K6 project-export (@m4): projects.exportTo writes a bundle with the project metadata, runs, ledger entries, memory
// records, and the report/patch artifacts; it contains no absolute realpath of the project root or userData and no key
// (nor its middle 10 chars); a destination inside the project root → PERMISSION_DENIED.
// projects.exportTo is still the not_implemented stub in the runner; the full test is written and SKIPPED while that is
// so (a load-time probe switches it on when the op lands).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { listFiles } from '../helpers/invariants.js';
import { cleanupTempDirs, makeTempDir } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

const KEY = 'sk-ant-test-SECRET-abcdefghij';
const MIDDLE = KEY.slice(9, 19);

const EXPORT_PENDING = await (async () => {
  const probe = await createHarness({ start: false });
  try {
    const dest = await makeTempDir('relay-export-probe-');
    const res = await probe.call('relay/v1/projects.exportTo', { projectId: probe.projectId, destinationRealpath: dest });
    return !res.ok && res.error.details?.['reason'] === 'not_implemented';
  } finally {
    await probe.dispose();
    await cleanupTempDirs();
  }
})();

describe('project export @m4', () => {
  it('status: projects.exportTo answers INTERNAL not_implemented until it lands (never a silent success) @m4', async () => {
    h = await createHarness({ start: false });
    const dest = await makeTempDir('relay-export-');
    const res = await h.call('relay/v1/projects.exportTo', { projectId: h.projectId, destinationRealpath: dest });
    if (EXPORT_PENDING) expect(res.ok ? null : [res.error.code, res.error.details?.['reason']]).toEqual(['INTERNAL', 'not_implemented']);
    else expect(res.ok).toBe(true);
  });

  it.skipIf(EXPORT_PENDING)('bundle has metadata, runs, ledger, memory, report/patch; no absolute realpath, no key; inside-root destination → PERMISSION_DENIED @m4 (projects.exportTo not_implemented yet)', async () => {
    h = await createHarness({ apiKey: KEY });
    const runId = await h.startRun();
    await h.waitFor(runId, 'awaiting_approval');
    await h.approve(runId);
    await h.waitFor(runId, 'completed');
    await h.waitUntil(() => h!.db.repos.artifacts.listForRun(runId, ['report']).length === 1, 10_000, 'report');
    const dest = await makeTempDir('relay-export-');

    const res = await h.call('relay/v1/projects.exportTo', { projectId: h.projectId, destinationRealpath: dest });

    expect(res.ok).toBe(true);
    const files = await listFiles(dest, dest);
    const all = (await Promise.all(files.map((f) => readFile(join(dest, f), 'latin1')))).join('\n');
    expect(all).toContain(runId);
    for (const needle of ['ledger', 'memory', 'report', 'patch']) expect(all.toLowerCase()).toContain(needle);
    expect(all).not.toContain(h.projectRoot);
    expect(all).not.toContain(h.userDataDir);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(MIDDLE);

    const inside = await h.call('relay/v1/projects.exportTo', { projectId: h.projectId, destinationRealpath: join(h.projectRoot, 'src') });
    expect(inside.ok ? null : inside.error.code).toBe('PERMISSION_DENIED');
  });
});
