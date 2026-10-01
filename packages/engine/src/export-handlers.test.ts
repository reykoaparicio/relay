// 02 *.exportTo / artifacts.importDiffText handlers (05 E5/E7, 06 F17, FR-10) over the real tools + artifact store:
// report Markdown / .patch export, refusal inside or containing a project root, never overwriting, the secret-scanned
// project bundle, the exact ledger CSV, and a diff-input run end to end on the fake provider.
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { afterEach, describe, expect, it } from 'vitest';
import type { EpochMs, LedgerEntryId, RunId } from '@relay/contracts';
import type { ModelRequest } from '@relay/providers';
import type { LedgerEntryRow } from '@relay/storage';
import { LEDGER_CSV_HEADER, findSecrets, ledgerCsv } from './export-handlers.js';
import { REPORT_UNTOUCHED_NOTE, usd6 } from './report.js';
import { SAMPLE_FILES, createHarness } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';
import { driveThroughApproval, wrapAdapters } from './testing/drive.js';

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function harness(o: HarnessOptions = {}): Promise<Harness> {
  h = await createHarness(o);
  return h;
}

async function tempDir(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), 'relay-export-test-')));
  dirs.push(d);
  return d;
}

async function completedRun(x: Harness): Promise<RunId> {
  const runId = await x.startRun();
  expect(await driveThroughApproval(x, runId, ['completed'])).toBe('completed');
  await x.waitFor(() => x.db.repos.artifacts.listForRun(runId, ['report']).length === 1);
  return runId;
}

const errOf = (res: { ok: boolean; error?: { code: string; details?: Record<string, unknown> | undefined } }) =>
  res.ok ? null : [res.error?.code, res.error?.details?.['reason']];

describe('artifacts.exportTo', () => {
  it('writes the report as Markdown and the patch as a .patch; a second export never overwrites (name suffixing)', async () => {
    const x = await harness();
    const runId = await completedRun(x);
    const dest = await tempDir();

    const res = await x.engine.handle('relay/v1/artifacts.exportTo', { runId, what: 'both', destinationRealpath: dest });

    expect(res.ok && res.data.writtenRealpaths).toEqual([join(dest, `relay-report-${runId}.md`), join(dest, `relay-patch-${runId}.patch`)]);
    const md = await readFile(join(dest, `relay-report-${runId}.md`), 'utf8');
    expect(md).toContain(`# Relay run report — ${runId}`);
    expect(md).toContain('Status: completed');
    expect(md).toContain('## Limitations');
    expect(md).toContain(REPORT_UNTOUCHED_NOTE);
    expect(md).toMatch(/Settled, calculated from usage: \$\d+\.\d{6}/);
    expect(md).toContain('## Unknown charges');
    for (const limitation of x.ctx.templates.reportLimitations().patch_not_applied.split('\n')) expect(md).toContain(limitation);
    const patch = await readFile(join(dest, `relay-patch-${runId}.patch`), 'utf8');
    expect(patch).toMatch(/^(Index: |=+\n)?[\s\S]*--- a\/src\//);
    expect(patch).toContain('+++ b/src/');

    const again = await x.engine.handle('relay/v1/artifacts.exportTo', { runId, what: 'report', destinationRealpath: dest });

    expect(again.ok && again.data.writtenRealpaths).toEqual([join(dest, `relay-report-${runId} (2).md`)]);
    expect(await readFile(join(dest, `relay-report-${runId}.md`), 'utf8')).toBe(md);
    expect((await readdir(dest)).sort()).toEqual([`relay-patch-${runId}.patch`, `relay-report-${runId} (2).md`, `relay-report-${runId}.md`]);
  });

  it('refuses a destination inside, or containing, a project root (PERMISSION_DENIED; nothing written)', async () => {
    const x = await harness();
    const runId = await completedRun(x);
    const inside = join(x.projectRoot, 'exports');
    await mkdir(inside);

    const insideRes = await x.engine.handle('relay/v1/artifacts.exportTo', { runId, what: 'both', destinationRealpath: inside });
    const rootRes = await x.engine.handle('relay/v1/artifacts.exportTo', { runId, what: 'report', destinationRealpath: x.projectRoot });
    const containing = await x.engine.handle('relay/v1/artifacts.exportTo', { runId, what: 'report', destinationRealpath: dirname(x.projectRoot) });

    expect(errOf(insideRes)).toEqual(['PERMISSION_DENIED', 'inside_project']);
    expect(errOf(rootRes)).toEqual(['PERMISSION_DENIED', 'inside_project']);
    expect(errOf(containing)).toEqual(['PERMISSION_DENIED', 'contains_project']);
    expect(await readdir(inside)).toEqual([]);
  });

  it('a run that has not ended has no report (NOT_FOUND); an unknown run is NOT_FOUND', async () => {
    const x = await harness();
    const runId = await x.startRun();
    const dest = await tempDir();

    const res = await x.engine.handle('relay/v1/artifacts.exportTo', { runId, what: 'report', destinationRealpath: dest });
    const patch = await x.engine.handle('relay/v1/artifacts.exportTo', { runId, what: 'patch', destinationRealpath: dest });

    expect(res.ok ? null : res.error.code).toBe('NOT_FOUND');
    expect(patch.ok ? null : patch.error.code).toBe('NOT_FOUND');
    expect(await readdir(dest)).toEqual([]);
  });
});

describe('projects.exportTo', () => {
  it('writes a JSON bundle (project without realpath, memory, workflows, runs with report + ledger); a save-dialog path is never overwritten', async () => {
    const x = await harness();
    const runId = await completedRun(x);
    const dest = await tempDir();

    const res = await x.engine.handle('relay/v1/projects.exportTo', { projectId: x.projectId, destinationRealpath: dest });

    expect(res.ok && res.data.writtenRealpath).toBe(join(dest, `relay-project-${x.projectId}.json`));
    const text = await readFile(join(dest, `relay-project-${x.projectId}.json`), 'utf8');
    expect(text).not.toContain(x.projectRoot);
    expect(text).not.toContain(x.userDataDir);
    expect(text).not.toContain('test-key-0000000000000000');
    const bundle = JSON.parse(text) as { project: Record<string, unknown>; memory: unknown[]; workflows: unknown[]; runs: { summary: { id: string }; report: { runId: string } | null; patch: string | null; ledger: unknown[] }[] };
    expect(bundle.project['id']).toBe(x.projectId);
    expect(Object.keys(bundle.project)).not.toContain('rootRealpath');
    expect(bundle.workflows.length).toBeGreaterThan(0);
    expect(Array.isArray(bundle.memory)).toBe(true);
    expect(bundle.runs.map((r) => [r.summary.id, r.report?.runId, r.patch !== null, r.ledger.length > 0])).toEqual([[runId, runId, true, true]]);

    const file = join(dest, 'mine.json');
    const first = await x.engine.handle('relay/v1/projects.exportTo', { projectId: x.projectId, runIds: [runId], destinationRealpath: file });
    const second = await x.engine.handle('relay/v1/projects.exportTo', { projectId: x.projectId, runIds: [runId], destinationRealpath: file });
    expect([first.ok && first.data.writtenRealpath, second.ok && second.data.writtenRealpath]).toEqual([file, join(dest, 'mine (2).json')]);
  });

  it('refuses (VALIDATION_FAILED) a bundle with a string that looks like a credential, writing nothing', async () => {
    const x = await harness();
    const dest = await tempDir();
    const now = x.clock.now();
    x.db.tx('immediate', (r) => r.memory.insertRecord(
      { id: x.ids.next('memory'), projectId: x.projectId, type: 'project_decision', status: 'approved', scope: { roles: 'all' }, createdAt: now },
      { id: x.ids.next('memoryRevision'), title: 'Deploy key', content: 'use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA to deploy', sourceRefs: [], author: 'user', createdAt: now },
    ));

    const res = await x.engine.handle('relay/v1/projects.exportTo', { projectId: x.projectId, destinationRealpath: dest });

    expect(res.ok ? null : [res.error.code, JSON.stringify(res.error.details)]).toEqual(['VALIDATION_FAILED', expect.stringContaining('secret_detected')]);
    expect(JSON.stringify(res)).not.toContain('sk-ant-api03');
    expect(await readdir(dest)).toEqual([]);
  });

  it('refuses a destination inside the project root, and a run of another project (NOT_FOUND)', async () => {
    const x = await harness();
    const inside = await x.engine.handle('relay/v1/projects.exportTo', { projectId: x.projectId, destinationRealpath: join(x.projectRoot, 'src') });
    const foreign = await x.engine.handle('relay/v1/projects.exportTo', { projectId: x.projectId, runIds: ['run_01J9ZZZZZZZZZZZZZZZZZZZZZ0'], destinationRealpath: await tempDir() });

    expect(errOf(inside)).toEqual(['PERMISSION_DENIED', 'inside_project']);
    expect(foreign.ok ? null : foreign.error.code).toBe('NOT_FOUND');
  });

  it('findSecrets walks keys and values with their JSON paths', () => {
    expect(findSecrets({ a: ['fine', { b: 'Bearer abcdefghijklmnop1234' }], 'sk-proj-ABCDEFGHIJKLMNOPQRST': 1 }).map((i) => i.path))
      .toEqual(['a[1].b', 'sk-proj-ABCDEFGHIJKLMNOPQRST']);
  });
});

describe('ledger.exportTo', () => {
  const entry = (o: Partial<LedgerEntryRow>): LedgerEntryRow => ({
    id: 'led_1' as LedgerEntryId, scope: 'run', runId: 'run_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as RunId, projectId: null, attemptId: null, type: 'reserve',
    bucket: 'reserved', deltaMicrousd: 0 as never, certainty: null, priceCatalogVersion: null, groupId: 'g', note: null, createdAt: 0 as EpochMs, ...o,
  });

  it('formats the exact CSV: header, ISO UTC times, 6-dp USD strings (no floats), RFC 4180 quoting, CRLF', () => {
    const csv = ledgerCsv([
      { entry: entry({ type: 'allowance_set', bucket: 'allowance', deltaMicrousd: 2_000_000 as never, createdAt: 1_700_000_000_000 as EpochMs }), stepKey: null },
      { entry: entry({ attemptId: 'att_1' as never, type: 'settle', bucket: 'settled', deltaMicrousd: 1 as never, certainty: 'calculated', priceCatalogVersion: '2026-09,x', createdAt: 1_700_000_000_001 as EpochMs }), stepKey: 'review' },
      { entry: entry({ attemptId: 'att_1' as never, type: 'release', deltaMicrousd: -123_456_789 as never, createdAt: 1_700_000_000_002 as EpochMs }), stepKey: 'review' },
    ]);

    expect(csv).toBe([
      'created_at,run,step,attempt,type,bucket,delta_usd,certainty,price_catalog_version',
      '2023-11-14T22:13:20.000Z,run_01J9ZZZZZZZZZZZZZZZZZZZZZ0,,,allowance_set,allowance,2.000000,,',
      '2023-11-14T22:13:20.001Z,run_01J9ZZZZZZZZZZZZZZZZZZZZZ0,review,att_1,settle,settled,0.000001,calculated,"2026-09,x"',
      '2023-11-14T22:13:20.002Z,run_01J9ZZZZZZZZZZZZZZZZZZZZZ0,review,att_1,release,reserved,-123.456789,,',
      '',
    ].join('\r\n'));
    expect(LEDGER_CSV_HEADER).toHaveLength(9);
    expect([usd6(0), usd6(-1), usd6(Number.MAX_SAFE_INTEGER)]).toEqual(['0.000000', '-0.000001', '9007199254.740991']);
  });

  it('exports one run, and a project month, with every ledger entry of the run', async () => {
    const x = await harness();
    const runId = await completedRun(x);
    const dest = await tempDir();
    const month = new Date(x.clock.now()).toISOString().slice(0, 7);

    const byRun = await x.engine.handle('relay/v1/ledger.exportTo', { runId, destinationRealpath: dest });
    const byMonth = await x.engine.handle('relay/v1/ledger.exportTo', { projectId: x.projectId, month, destinationRealpath: dest });
    const otherMonth = await x.engine.handle('relay/v1/ledger.exportTo', { projectId: x.projectId, month: '1999-01', destinationRealpath: dest });

    const runCsv = await readFile(byRun.ok ? byRun.data.writtenRealpath : '', 'utf8');
    const lines = runCsv.trimEnd().split('\r\n');
    const entries = x.db.repos.ledger.list(runId, { limit: 1000, sort: 'created_asc' });
    expect(lines).toHaveLength(1 + (entries.ok ? entries.value.items.length : -1));
    for (const line of lines.slice(1)) expect(line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z,run_\w+,[\w-]*,(att_\w+)?,\w+,\w+,-?\d+\.\d{6},\w*,[^,]*$/);
    expect(await readFile(byMonth.ok ? byMonth.data.writtenRealpath : '', 'utf8')).toBe(runCsv);
    expect(await readFile(otherMonth.ok ? otherMonth.data.writtenRealpath : '', 'utf8')).toBe(`${LEDGER_CSV_HEADER.join(',')}\r\n`);
    expect(errOf(await x.engine.handle('relay/v1/ledger.exportTo', { runId, destinationRealpath: x.projectRoot }))).toEqual(['PERMISSION_DENIED', 'inside_project']);
  });
});

describe('artifacts.importDiffText + diff-input runs', () => {
  const FILES = Object.keys(SAMPLE_FILES);
  /** A diff touching every sample file (first line edited), as a user would import it. */
  const sampleDiff = (): string => FILES.map((rel) => {
    const old = SAMPLE_FILES[rel] ?? '';
    return createTwoFilesPatch(`a/${rel}`, `b/${rel}`, old, `// reviewed\n${old}`);
  }).join('');

  it('refuses a diff touching .env (PERMISSION_DENIED) or escaping the root (VALIDATION_FAILED); stores nothing', async () => {
    const x = await harness({ files: { ...SAMPLE_FILES, '.env': 'TOKEN=sk-fixture-DO-NOT-READ-1234567890\n' } });
    const env = ['--- a/.env', '+++ b/.env', '@@ -1 +1 @@', '-TOKEN=x', '+TOKEN=y', ''].join('\n');
    const escape = ['--- a/../outside.txt', '+++ b/../outside.txt', '@@ -1 +1 @@', '-a', '+b', ''].join('\n');

    const denied = await x.engine.handle('relay/v1/artifacts.importDiffText', { projectId: x.projectId, text: env, fileName: 'env.diff' });
    const invalid = await x.engine.handle('relay/v1/artifacts.importDiffText', { projectId: x.projectId, text: escape, fileName: 'x.diff' });

    expect(denied.ok ? null : [denied.error.code, denied.error.details]).toEqual(['PERMISSION_DENIED', { reason: 'excluded', denied: [{ relPath: '.env', reason: 'secret' }] }]);
    expect(invalid.ok ? null : invalid.error.code).toBe('VALIDATION_FAILED');
    expect(x.db.repos.artifacts.listWhere({ kinds: ['input_diff'] })).toEqual([]);
  });

  it('stores the diff as a project-scoped input_diff and a diff-input run completes: referenced files snapshotted, <untrusted_diff> rendered', async () => {
    const requests: ModelRequest[] = [];
    const x = await harness({ providers: wrapAdapters({ generate: (base, req, gctx) => {
      requests.push(req);
      return base.get(req.providerId).generate(req, gctx);
    } }) });
    const text = sampleDiff();

    const imported = await x.engine.handle('relay/v1/artifacts.importDiffText', { projectId: x.projectId, text, fileName: 'review.diff' });

    if (!imported.ok) throw new Error(imported.error.code);
    expect([...imported.data.files].sort()).toEqual([...FILES].sort());
    expect(imported.data.parseWarnings).toEqual([]);
    const row = x.db.repos.artifacts.get(imported.data.artifactId);
    expect(row).toEqual(expect.objectContaining({ kind: 'input_diff', runId: null, projectId: x.projectId }));
    expect(row?.relPath.startsWith(`artifacts/${x.projectId}/`)).toBe(true);

    const workflow = x.db.repos.workflows.listWorkflows()[0];
    const started = await x.engine.handle('relay/v1/runs.start', { idempotencyKey: 'diff-input-run-0001', projectId: x.projectId,
      workflowId: workflow?.id ?? '', workflowVersion: 1, goal: 'Review the imported diff.', input: { kind: 'diff', diffArtifactId: imported.data.artifactId } });
    if (!started.ok) throw new Error(`${started.error.code} ${JSON.stringify(started.error.details)}`);
    const runId = started.data.runId;

    expect(await driveThroughApproval(x, runId, ['completed', 'paused', 'failed'])).toBe('completed');

    const inputs = x.db.repos.runs.inputFiles(runId);
    expect(inputs.map((f) => f.relPath).sort()).toEqual([...FILES].sort());
    expect(x.db.repos.artifacts.listForRun(runId, ['input_file']).length).toBeGreaterThan(0);
    const review = requests.find((r) => r.metadata.stepKey === 'review');
    const user = review?.messages[0]?.content ?? '';
    expect(user).toContain(`<untrusted_diff artifact="${imported.data.artifactId}">`);
    expect(user).toContain('// reviewed');
    expect(user).toContain('src/handlers/user.ts');
  });

  it('a diff-input run whose diff now touches a newly excluded path is blocked at intake (never read)', async () => {
    const x = await harness();
    const imported = await x.engine.handle('relay/v1/artifacts.importDiffText', { projectId: x.projectId, text: sampleDiff(), fileName: 'a.diff' });
    if (!imported.ok) throw new Error(imported.error.code);
    const p = x.db.repos.projects.get(x.projectId);
    await x.engine.handle('relay/v1/projects.update', { projectId: x.projectId, expectedUpdatedAt: p.updatedAt, patch: { exclusions: ['src/lib/**'] } });
    const workflow = x.db.repos.workflows.listWorkflows()[0];

    const started = await x.engine.handle('relay/v1/runs.start', { idempotencyKey: 'diff-input-run-0002', projectId: x.projectId,
      workflowId: workflow?.id ?? '', workflowVersion: 1, goal: 'Review.', input: { kind: 'diff', diffArtifactId: imported.data.artifactId } });
    if (!started.ok) throw new Error(started.error.code);
    const status = await driveThroughApproval(x, started.data.runId, ['paused', 'completed']);

    const run = x.db.repos.runs.get(started.data.runId);
    expect([status, run.pauseReason, run.statusDetail?.code]).toEqual(['paused', 'setup_blocked', 'PERMISSION_DENIED']);
    expect(x.callLog.entries()).toEqual([]);
  });
});
