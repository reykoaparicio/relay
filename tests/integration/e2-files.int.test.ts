// E2 file / project fixes over the real runtime: a moved project folder is PROJECT_ROOT_MISSING everywhere and can be
// re-pointed with verification (#7); one unreadable file is PERMISSION_DENIED `unreadable` naming it (#8); export
// reports per part and retries only the failed one (#10); content-suspected secrets are flagged in the preview and
// refused at intake (#11); hard links are excluded (#13).
import { chmod, link, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_REL_PATHS, createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { cleanupTempDirs, makeTempDir } from '../helpers/temp-dirs.js';

let h: Harness | undefined;

/** `runs.preflight` with the harness defaults (the New-run form's check before Start). */
function preflight(x: Harness) {
  return x.call('relay/v1/runs.preflight', { projectId: x.projectId, workflowId: x.workflowId, workflowVersion: 1, goal: 'Fix the defects in the handlers.',
    input: { kind: 'files', relPaths: [...DEFAULT_REL_PATHS] } });
}
const locked: string[] = [];
afterEach(async () => {
  for (const p of locked.splice(0)) await chmod(p, 0o644).catch(() => undefined);
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

// Built at runtime so the source never holds a credential-shaped literal.
const GH = `ghp_${'Q7w8E9r0T1'.repeat(4)}`;

describe('E2 project folder moved (#7)', () => {
  it('preview, preflight and intake say PROJECT_ROOT_MISSING; relocateRoot verifies the moved folder and the project works again', async () => {
    const x = await createHarness();
    h = x;
    const runId = await x.startRun();
    await x.waitFor(runId, 'awaiting_approval');
    const moved = join(await makeTempDir('relay-e2-moved-'), 'sample-api');
    await rename(x.projectRoot, moved);

    const preview = await x.call('relay/v1/projects.previewRoot', { projectId: x.projectId, extraExclusions: [] });
    const start = await preflight(x);

    expect(preview.ok ? null : preview.error.code).toBe('PROJECT_ROOT_MISSING');
    expect(start.ok ? null : start.error.code).toBe('PROJECT_ROOT_MISSING');

    const relocated = await x.call('relay/v1/projects.relocateRoot', { projectId: x.projectId, rootRealpath: moved, rootDisplayPath: '~/moved/sample-api' });

    expect(relocated.ok).toBe(true);
    if (!relocated.ok) return;
    expect(relocated.data.project.rootDisplayPath).toBe('~/moved/sample-api');
    expect(relocated.data.verification.checkedFiles).toBeGreaterThan(0);
    expect(relocated.data.verification.matchedFiles).toBe(relocated.data.verification.checkedFiles);
    const again = await x.call('relay/v1/projects.previewRoot', { projectId: x.projectId, extraExclusions: [] });
    expect(again.ok && again.data.included.length).toBeGreaterThan(0);
  });

  it('a different folder is CONFLICT root_unverified (with the verification) until confirmed', async () => {
    const x = await createHarness();
    h = x;
    const runId = await x.startRun();
    await x.waitFor(runId, 'awaiting_approval');
    const other = await makeTempDir('relay-e2-other-');
    await writeFile(join(other, 'README.md'), '# something else\n');

    const refused = await x.call('relay/v1/projects.relocateRoot', { projectId: x.projectId, rootRealpath: other, rootDisplayPath: '~/other' });
    const confirmed = await x.call('relay/v1/projects.relocateRoot', { projectId: x.projectId, rootRealpath: other, rootDisplayPath: '~/other', confirm: true });

    expect(refused.ok ? null : [refused.error.code, refused.error.details?.['reason']]).toEqual(['CONFLICT', 'root_unverified']);
    expect(refused.ok ? null : refused.error.details?.['verification']).toMatchObject({ matchedFiles: 0 });
    expect(confirmed.ok && confirmed.data.verification.matchedFiles).toBe(0);
  });

  it('intake of a queued run whose folder vanished pauses setup_blocked with PROJECT_ROOT_MISSING (not "file missing")', async () => {
    const x = await createHarness({ start: false });
    h = x;
    const runId = await x.startRun();
    const moved = join(await makeTempDir('relay-e2-moved-'), 'gone');
    await rename(x.projectRoot, moved);

    await x.engine.start();
    const run = await x.waitFor(runId, 'paused');

    expect(run.pauseReason).toBe('setup_blocked');
    expect(JSON.stringify(run.statusDetail)).toContain('PROJECT_ROOT_MISSING');
  });
});

describe('E2 unreadable file (#8)', () => {
  it('New run (preflight) with one unreadable selected file → PERMISSION_DENIED unreadable naming the relPath; the preview lists it', async () => {
    const x = await createHarness();
    h = x;
    const file = join(x.projectRoot, 'src', 'errors.ts');
    await chmod(file, 0o000);
    locked.push(file);

    const start = await preflight(x);
    const preview = await x.call('relay/v1/projects.previewRoot', { projectId: x.projectId, extraExclusions: [] });

    expect(start.ok).toBe(false);
    if (start.ok) return;
    expect(start.error.code).toBe('PERMISSION_DENIED');
    expect(start.error.details).toMatchObject({ reason: 'unreadable', relPath: 'src/errors.ts' });
    expect(start.error.userMessage).toContain('src/errors.ts');
    expect(preview.ok && preview.data.unreadable).toEqual(['src/errors.ts']);
  });
});

describe('E2 suspected secrets (#11) and hard links (#13)', () => {
  it('the preview flags a credential-shaped file (label + line, never the value) and excludes a hard link', async () => {
    const x = await createHarness();
    h = x;
    await writeFile(join(x.projectRoot, 'src', 'deploy.ts'), `// deploy\nexport const token = '${GH}';\n`);
    const outside = await makeTempDir('relay-e2-outside-');
    await writeFile(join(outside, 'creds.txt'), 'aws_secret=OUTSIDE\n');
    await link(join(outside, 'creds.txt'), join(x.projectRoot, 'notes.txt'));

    const preview = await x.call('relay/v1/projects.previewRoot', { projectId: x.projectId, extraExclusions: [] });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.included.find((f) => f.relPath === 'src/deploy.ts')).toMatchObject({ suspectedSecret: true, secretLabel: 'github_token', secretLine: 2 });
    expect(preview.data.included.filter((f) => f.suspectedSecret === true).map((f) => f.relPath)).toEqual(['src/deploy.ts']);
    expect(preview.data.excluded).toContainEqual({ relPath: 'notes.txt', reason: 'hard_link' });
    expect(JSON.stringify(preview.data)).not.toContain(GH);
  });

  it('intake refuses an unacknowledged suspected secret: setup_blocked PERMISSION_DENIED suspected_secret, nothing sent to a provider', async () => {
    const x = await createHarness({ start: false });
    h = x;
    await writeFile(join(x.projectRoot, 'src', 'deploy.ts'), `export const token = '${GH}';\n`);
    const runId = await x.startRun({ relPaths: ['src/errors.ts', 'src/deploy.ts'] });

    await x.engine.start();
    const run = await x.waitFor(runId, 'paused');

    expect(run.pauseReason).toBe('setup_blocked');
    expect(JSON.stringify(run.statusDetail)).toContain('suspected_secret');
    expect(JSON.stringify(run.statusDetail)).not.toContain(GH);
    expect(x.calls({ runId })).toEqual([]);
    expect(x.db.repos.runs.inputFiles(runId)).toEqual([]);
  });
});

describe('E2 suspected secrets: preflight and intake agree (#11)', () => {
  // Each case: one file's content and whether it is acknowledged. `api_key = '<24 lowercase>'` matches a raw redaction
  // candidate but is NOT a confirmed secret (the case preflight and intake used to disagree on).
  const cases: readonly { name: string; content: string; ack: boolean; flagged: boolean }[] = [
    { name: 'clean file', content: 'export const ok = 1;\n', ack: false, flagged: false },
    { name: 'token, unacknowledged', content: `export const token = '${GH}';\n`, ack: false, flagged: true },
    { name: 'token, acknowledged', content: `export const token = '${GH}';\n`, ack: true, flagged: false },
    { name: 'candidate that is not a confirmed secret', content: "export const api_key = 'abcdefghijklmnopqrstuvwx';\n", ack: false, flagged: false },
  ];

  for (const c of cases) {
    it(`same files → same verdict: ${c.name}`, async () => {
      const x = await createHarness({ start: false });
      h = x;
      await writeFile(join(x.projectRoot, 'src', 'deploy.ts'), c.content);
      const input = { kind: 'files' as const, relPaths: ['src/errors.ts', 'src/deploy.ts'], ...(c.ack ? { acknowledgedSuspectedSecrets: ['src/deploy.ts'] } : {}) };
      const base = { projectId: x.projectId, workflowId: x.workflowId, workflowVersion: 1, goal: 'Fix the defects in the handlers.', input };

      const pre = await x.call('relay/v1/runs.preflight', base);
      if (!pre.ok) throw new Error(pre.error.code);
      const preflightFlags = pre.data.issues.filter((i) => i.code === 'suspected_secret').map((i) => i.path);
      const started = await x.call('relay/v1/runs.start', { ...base, idempotencyKey: `agree-${c.name.replace(/\W+/g, '-')}` });
      if (!started.ok) throw new Error(started.error.code);
      await x.engine.start();
      const run = await x.waitFor(started.data.runId, ['paused', 'awaiting_approval']);
      const intakeRefused = run.pauseReason === 'setup_blocked' && JSON.stringify(run.statusDetail).includes('suspected_secret');

      expect(preflightFlags).toEqual(c.flagged ? ['input.relPaths.1'] : []);
      expect(intakeRefused).toBe(c.flagged); // intake agrees with preflight
      // Intake accepted the file iff it snapshotted it (later steps of the fake script are irrelevant here).
      expect(x.db.repos.runs.inputFiles(run.id).map((f) => f.relPath).sort()).toEqual(c.flagged ? [] : ['src/deploy.ts', 'src/errors.ts']);
      expect(JSON.stringify(pre.data)).not.toContain(GH);
    });
  }

  it('a diff-input run cannot acknowledge: a suspected secret in a file the diff references blocks it in preflight AND intake (fail closed)', async () => {
    const x = await createHarness({ start: false });
    h = x;
    const diff = ['--- a/src/errors.ts', '+++ b/src/errors.ts', '@@ -1 +1,2 @@', '+// reviewed', ' x', ''].join('\n');
    const imported = await x.call('relay/v1/artifacts.importDiffText', { projectId: x.projectId, text: diff, fileName: 'r.diff' });
    if (!imported.ok) throw new Error(imported.error.code);
    await writeFile(join(x.projectRoot, 'src', 'errors.ts'), `export const token = '${GH}';\n`);
    const base = { projectId: x.projectId, workflowId: x.workflowId, workflowVersion: 1, goal: 'Review.', input: { kind: 'diff' as const, diffArtifactId: imported.data.artifactId } };

    const pre = await x.call('relay/v1/runs.preflight', base);
    if (!pre.ok) throw new Error(pre.error.code);
    const started = await x.call('relay/v1/runs.start', { ...base, idempotencyKey: 'agree-diff-input-0001' });
    if (!started.ok) throw new Error(started.error.code);
    await x.engine.start();
    const run = await x.waitFor(started.data.runId, ['paused', 'awaiting_approval']);

    expect(pre.data.issues.filter((i) => i.code === 'suspected_secret').map((i) => i.path)).toEqual(['input']);
    expect([run.status, run.pauseReason]).toEqual(['paused', 'setup_blocked']);
    expect(JSON.stringify(run.statusDetail)).toContain('suspected_secret');
    expect(x.calls({ runId: started.data.runId })).toEqual([]);
  });
});

describe('E2 export per part (#10)', () => {
  it('a purged report fails on its own: the patch is written and `failed` names the report; the report alone is a plain error', async () => {
    const x = await createHarness();
    h = x;
    const runId = await x.startRun();
    await x.waitFor(runId, 'awaiting_approval');
    await x.approve(runId);
    await x.waitFor(runId, 'completed');
    await x.waitUntil(() => x.db.repos.artifacts.listForRun(runId, ['report']).length === 1, 10_000, 'report');
    const dest = await makeTempDir('relay-e2-export-');
    const [report] = x.db.repos.artifacts.listForRun(runId, ['report']);
    x.db.tx('immediate', (r) => r.artifacts.markPurged(report!.id, x.clock.now()));

    const partial = await x.call('relay/v1/artifacts.exportTo', { runId, what: 'both', destinationRealpath: dest });

    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.data.written?.map((w) => w.what)).toEqual(['patch']);
    expect(partial.data.writtenRealpaths).toEqual([join(dest, `relay-patch-${runId}.patch`)]);
    expect(partial.data.failed).toEqual([expect.objectContaining({ what: 'report', code: 'NOT_FOUND' })]);
    expect(await readdir(dest)).toEqual([`relay-patch-${runId}.patch`]);

    const onlyReport = await x.call('relay/v1/artifacts.exportTo', { runId, what: 'report', destinationRealpath: dest });
    expect(onlyReport.ok ? null : [onlyReport.error.code, onlyReport.error.details?.['failed']]).toEqual(['NOT_FOUND', [expect.objectContaining({ what: 'report' })]]);
    expect(await readdir(dest)).toEqual([`relay-patch-${runId}.patch`]); // never a 0-byte file
  });
});
