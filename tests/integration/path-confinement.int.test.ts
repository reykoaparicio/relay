// 11 §K5 / §17.1 "Path traversal / symlink escape" (@m3): `..` inputs are rejected by the schema, the link-outside
// symlink resolves outside the root (PERMISSION_DENIED outside_root), a diff touching .env is refused, and a patch
// touching a file outside the approved scope is rejected by patch validation. The outside target is never read.
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeScenario } from '@relay/providers';
import { checkDiffPaths, parseImportedDiff } from '@relay/tools';
import { DEFAULT_REL_PATHS, createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { dumpAllValues } from '../helpers/sqlite-inspect.js';
import { FIXTURES_DIR, OUTSIDE_SECRET_CONTENT, cleanupTempDirs, makeSymlinkEscape } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

const settledStatus = (r: { status: string }) => !['queued', 'running'].includes(r.status);

describe('path confinement @m3', () => {
  it('runs.start with ../outside/secret.txt → VALIDATION_FAILED (schema), nothing written @m3', async () => {
    h = await createHarness({ start: false });

    const res = await h.startRunRaw({ relPaths: ['../outside/secret.txt'] });
    const abs = await h.startRunRaw({ relPaths: ['/etc/passwd'] });

    expect(res.ok ? null : [res.error.code, res.error.details?.['issues']]).toEqual(['VALIDATION_FAILED', [expect.objectContaining({ path: 'input.relPaths[0]' })]]);
    expect(abs.ok ? null : abs.error.code).toBe('VALIDATION_FAILED');
    const page = h.db.repos.runs.list({ projectId: h.projectId, limit: 10 });
    expect(page.ok && page.value.items).toEqual([]);
  });

  it('link-outside (symlink escape) → PERMISSION_DENIED outside_root; the outside target is never read @m3', async () => {
    h = await createHarness();
    const { linkRelPath, targetAbs } = await makeSymlinkEscape(h.projectRoot);
    const opened: string[] = [];
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(p));
      return (realOpen as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(p, ...rest);
    }));

    // Direct confined read (the engine's ProjectFsPort over @relay/tools).
    const root = await h.projectFs.openRoot(h.projectRoot);
    if (!root.ok) throw new Error(root.error.code);
    const read = await h.projectFs.readSelected(root.value, [linkRelPath]);
    expect(read.ok ? null : [read.error.code, read.error.details]).toEqual(['PERMISSION_DENIED',
      expect.objectContaining({ denied: [expect.objectContaining({ relPath: linkRelPath, reason: 'outside_root' })] })]);

    // Through the runner: the run is refused (at start or at intake), never reads the target.
    const started = await h.startRunRaw({ relPaths: [...DEFAULT_REL_PATHS, linkRelPath] });
    if (started.ok) {
      const run = await h.waitFor(started.data.runId, settledStatus);
      expect(run.status).not.toBe('awaiting_approval');
      expect(run.statusDetail?.code).toBe('PERMISSION_DENIED');
      expect(JSON.stringify(run.statusDetail?.details)).toContain('outside_root');
      expect(h.calls({ runId: started.data.runId })).toEqual([]);
    } else {
      expect(started.error.code).toBe('PERMISSION_DENIED');
    }
    expect(opened.filter((p) => p === targetAbs || p.endsWith('/outside-target/secret.txt'))).toEqual([]);
    expect(dumpAllValues(h.dbPath).filter((v) => v.value.includes(OUTSIDE_SECRET_CONTENT.trim()))).toEqual([]);
  });

  it('selecting .env directly never reads it: PERMISSION_DENIED (secret) @m3', async () => {
    h = await createHarness();
    const root = await h.projectFs.openRoot(h.projectRoot);
    if (!root.ok) throw new Error(root.error.code);

    const read = await h.projectFs.readSelected(root.value, ['.env']);
    const started = await h.startRunRaw({ relPaths: ['src/handlers/user.ts', '.env'] });

    expect(read.ok ? null : [read.error.code, JSON.stringify(read.error.details)]).toEqual(['PERMISSION_DENIED', expect.stringContaining('secret')]);
    if (started.ok) {
      const run = await h.waitFor(started.data.runId, settledStatus);
      expect(run.status).not.toBe('awaiting_approval');
      expect(run.statusDetail?.code).toBe('PERMISSION_DENIED');
      expect(h.calls({ runId: started.data.runId })).toEqual([]);
    } else {
      expect(started.error.code).toBe('PERMISSION_DENIED');
    }
  });

  it('a diff touching .env is refused (PERMISSION_DENIED) by the confined diff intake @m3', async () => {
    h = await createHarness({ start: false });
    const root = await h.projectFs.openRoot(h.projectRoot);
    if (!root.ok) throw new Error(root.error.code);
    const diff = parseImportedDiff([
      '--- a/.env', '+++ b/.env', '@@ -1 +1 @@', '-SAMPLE_API_TOKEN=sk-fixture-DO-NOT-READ-1234567890', '+SAMPLE_API_TOKEN=changed', '',
    ].join('\n'));
    if (!diff.ok) throw new Error(diff.error.code);

    const checked = await checkDiffPaths(root.value, diff.value);

    expect(checked.ok ? null : [checked.error.code, checked.error.details]).toEqual(['PERMISSION_DENIED', { reason: 'excluded', denied: [{ relPath: '.env', reason: 'secret' }] }]);
  });

  it.todo('artifacts.importDiffText touching .env → PERMISSION_DENIED end to end (the runner op is not_implemented yet; Wave 3 G/F work)');

  it('patch.outside-scope → rejected by patch validation (never applied) → paused(output_invalid) @m3', async () => {
    const outside = JSON.parse(readFileSync(`${FIXTURES_DIR}provider-responses/patch.outside-scope.json`, 'utf8')) as unknown;
    const scenario: FakeScenario = { name: 'patch-outside-scope', steps: [{ match: { stepKey: 'implement' }, times: Infinity, result: { kind: 'success', fixture: 'patch.outside-scope' } }] };
    h = await createHarness({ scenario, extraFixtures: { 'patch.outside-scope': outside } });
    const runId = await h.startRun({ relPaths: [...DEFAULT_REL_PATHS, 'src/config.ts'] });
    await h.waitFor(runId, 'awaiting_approval');
    expect(h.db.repos.approvals.pendingForRun(runId)?.fileScope).not.toContain('src/config.ts');
    await h.approve(runId);

    const run = await h.waitFor(runId, settledStatus);

    expect([run.status, run.pauseReason]).toEqual(['paused', 'output_invalid']);
    const [first] = h.attempts(runId, 'implement');
    expect(first?.error?.code).toBe('OUTPUT_INVALID');
    expect(JSON.stringify(first?.error?.details)).toContain('src/config.ts');
    expect(h.db.repos.artifacts.listForRun(runId, ['patch'])).toEqual([]); // no validated patch artifact
  });
});
