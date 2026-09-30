// 11 §K5 / §17.1 "Artifact export fails" (@m4): a read-only destination → ARTIFACT_WRITE_FAILED with the run row
// unchanged; the retry succeeds; a destination inside (or containing) the project root → PERMISSION_DENIED.
// `artifacts.exportTo` is not implemented in the runner yet, so the export runs through @relay/tools `exportArtifacts`
// (the function the op will call) over the REAL artifact store of a completed run; the IPC path is a todo.
import { chmod, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunId } from '@relay/contracts';
import { exportArtifacts } from '@relay/tools';
import { createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { cleanupTempDirs, makeTempDir } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
const readOnly: string[] = [];
afterEach(async () => {
  for (const d of readOnly.splice(0)) await chmod(d, 0o755).catch(() => undefined);
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

async function completedRun(): Promise<{ x: Harness; runId: RunId }> {
  const x = await createHarness();
  h = x;
  const runId = await x.startRun();
  await x.waitFor(runId, 'awaiting_approval');
  await x.approve(runId);
  await x.waitFor(runId, 'completed');
  await x.waitUntil(() => x.db.repos.artifacts.listForRun(runId, ['report']).length === 1, 10_000, 'report');
  return { x, runId };
}

function exportFiles(x: Harness, runId: RunId) {
  const [report] = x.db.repos.artifacts.listForRun(runId, ['report']);
  const [patch] = x.db.repos.artifacts.listForRun(runId, ['patch']);
  return [{ relPath: report!.relPath, suggestedName: 'report.json' }, { relPath: patch!.relPath, suggestedName: 'patch.json' }];
}

describe('artifact export @m4', () => {
  it('read-only destination → ARTIFACT_WRITE_FAILED, run row unchanged; the retry succeeds @m4', async () => {
    const { x, runId } = await completedRun();
    const dest = await makeTempDir('relay-export-');
    await chmod(dest, 0o555);
    readOnly.push(dest);
    const runBefore = x.db.repos.runs.get(runId);

    const failed = await exportArtifacts({ files: exportFiles(x, runId), destinationRealpath: dest, projectRoots: [x.projectRoot], store: x.artifacts });

    expect(failed.ok ? null : failed.error.code).toBe('ARTIFACT_WRITE_FAILED');
    expect(x.db.repos.runs.get(runId)).toEqual(runBefore);
    await chmod(dest, 0o755);
    const retried = await exportArtifacts({ files: exportFiles(x, runId), destinationRealpath: dest, projectRoots: [x.projectRoot], store: x.artifacts });
    expect(retried.ok && retried.value.written.sort()).toEqual(['patch.json', 'report.json']);
    expect((await readdir(dest)).sort()).toEqual(['patch.json', 'report.json']);
    const [report] = x.db.repos.artifacts.listForRun(runId, ['report']);
    expect(await readFile(join(dest, 'report.json'))).toEqual(await readFile(join(x.userDataDir, report!.relPath)));
    expect(x.db.repos.runs.get(runId)).toEqual(runBefore);
  });

  it('a destination inside the project root, or one containing it → PERMISSION_DENIED, nothing written @m4', async () => {
    const { x, runId } = await completedRun();
    const inside = join(x.projectRoot, 'exports');
    await mkdir(inside);

    const insideRes = await exportArtifacts({ files: exportFiles(x, runId), destinationRealpath: inside, projectRoots: [x.projectRoot], store: x.artifacts });
    const containing = await exportArtifacts({ files: exportFiles(x, runId), destinationRealpath: dirname(x.projectRoot), projectRoots: [x.projectRoot], store: x.artifacts });

    expect(insideRes.ok ? null : [insideRes.error.code, insideRes.error.details?.['reason']]).toEqual(['PERMISSION_DENIED', 'inside_project']);
    expect(containing.ok ? null : [containing.error.code, containing.error.details?.['reason']]).toEqual(['PERMISSION_DENIED', 'contains_project']);
    expect(await readdir(inside)).toEqual([]);
  });

  it.todo('artifacts.exportTo over IPC (runner op is not_implemented yet): read-only dest → ARTIFACT_WRITE_FAILED, retry ok, inside project → PERMISSION_DENIED');
});
