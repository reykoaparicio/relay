// 11 §K6 project-export (@m4): projects.exportTo writes a bundle with the project metadata, runs, ledger entries, memory
// records, and the report/patch artifacts; it contains no absolute realpath of the project root or userData and no key
// (nor its middle 10 chars); a destination inside the project root → PERMISSION_DENIED. The bundle is parsed and
// asserted structurally (not by substring).
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

/** The parts of the `relay.project-export` v1 bundle this test reads. */
interface Bundle {
  readonly format: string;
  readonly formatVersion: number;
  readonly project: { readonly id: string; readonly name: string } & Record<string, unknown>;
  readonly memory: readonly { readonly record: Record<string, unknown> & { readonly id: string }; readonly revisions: readonly { revision: number; title: string; content: string }[] }[];
  readonly runs: readonly {
    readonly summary: { readonly id: string; readonly status: string };
    readonly report: (Record<string, unknown> & { readonly approvals?: readonly { decision: string | null }[] }) | null;
    readonly patch: string | null;
    readonly ledger: readonly { readonly type: string; readonly runId: string | null }[];
  }[];
}

const KEY = 'sk-ant-test-SECRET-abcdefghij';
const MIDDLE = KEY.slice(9, 19);

describe('project export @m4', () => {
  it('bundle has the project, its memory records, the run summary, ledger, report.v1 and patch; no absolute realpath, no key; inside-root destination → PERMISSION_DENIED @m4', async () => {
    h = await createHarness({ apiKey: KEY });
    const rule = await h.call('relay/v1/memory.create', { idempotencyKey: 'export-memory-0001', projectId: h.projectId, type: 'user_rule', title: 'Keep fields',
      content: 'Keep existing public response fields.', scope: { roles: 'all' }, pinned: true });
    if (!rule.ok) throw new Error(rule.error.code);
    const runId = await h.startRun();
    await h.waitFor(runId, 'awaiting_approval');
    await h.approve(runId);
    await h.waitFor(runId, 'completed');
    await h.waitUntil(() => h!.db.repos.artifacts.listForRun(runId, ['report']).length === 1, 10_000, 'report');
    const dest = await makeTempDir('relay-export-');

    const res = await h.call('relay/v1/projects.exportTo', { projectId: h.projectId, destinationRealpath: dest });

    if (!res.ok) throw new Error(res.error.code);
    const files = await listFiles(dest, dest);
    expect(files).toEqual([`relay-project-${h.projectId}.json`]);
    const text = await readFile(join(dest, files[0] ?? ''), 'utf8');
    const bundle = JSON.parse(text) as Bundle;
    expect([bundle.format, bundle.formatVersion, bundle.project.id, bundle.project.name]).toEqual(['relay.project-export', 1, h.projectId, 'Sample API']);
    expect(Object.keys(bundle.project)).not.toContain('rootRealpath');
    const memory = bundle.memory.find((m) => m.record.id === rule.data.id);
    expect(memory?.record).toEqual(expect.objectContaining({ projectId: h.projectId, type: 'user_rule', status: 'approved', pinned: true }));
    expect(memory?.revisions.map((r) => [r.revision, r.title, r.content])).toEqual([[1, 'Keep fields', 'Keep existing public response fields.']]);
    expect(bundle.runs).toHaveLength(1);
    const [run] = bundle.runs;
    expect([run?.summary.id, run?.summary.status]).toEqual([runId, 'completed']);
    expect(run?.report).toEqual(expect.objectContaining({ schemaId: 'report.v1', runId, status: 'completed', verdict: 'accept' }));
    expect(run?.report?.approvals?.map((a) => a.decision)).toEqual(['approved']);
    expect(run?.patch).toEqual(expect.any(String));
    expect(run?.patch?.length).toBeGreaterThan(0);
    const types = new Set(run?.ledger.map((e) => e.type));
    for (const t of ['allowance_set', 'reserve', 'release', 'settle']) expect(types.has(t), t).toBe(true);
    expect(run?.ledger.every((e) => e.runId === runId)).toBe(true);
    for (const forbidden of [h.projectRoot, h.userDataDir, KEY, MIDDLE]) expect(text).not.toContain(forbidden);

    const inside = await h.call('relay/v1/projects.exportTo', { projectId: h.projectId, destinationRealpath: join(h.projectRoot, 'src') });
    expect(inside.ok ? null : inside.error.code).toBe('PERMISSION_DENIED');
  });
});
