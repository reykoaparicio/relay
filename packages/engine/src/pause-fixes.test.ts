// Referee fixes for decision 2 (pause / export in progress), ported from the bug hunt on f8c9f0f: P-1 a run paused
// while awaiting approval never gets stranded running; P-2 a pause requested while the approval opens is applied in
// the same commit; P-3 an interim export never writes a superseded/rejected patch; P-4 exported Markdown is redacted.
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunId, StepKey } from '@relay/contracts';
import { FAKE_FIXTURES } from '@relay/providers';
import { buildReport, renderReportMarkdown } from './report.js';
import { tick } from './runner.js';
import { approvePending, drive, driveThroughApproval } from './testing/drive.js';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const detail = async (x: Harness, runId: RunId) => {
  const d = await x.engine.handle('relay/v1/runs.get', { runId });
  if (!d.ok) throw new Error(d.error.code);
  return d.data;
};

const resume = (x: Harness, runId: RunId, key: string) =>
  x.engine.handle('relay/v1/runs.resume', { idempotencyKey: key, runId, decision: { kind: 'continue' } });

const CHANGED_FILE = join('src', 'handlers', 'user.ts');

describe('P-1: a run paused while awaiting approval', () => {
  it('refuses approvals.decide (CONFLICT run_not_awaiting_approval) without invalidating the approval; resume returns to it', async () => {
    const x = await createHarness();
    h = x;
    const runId = await x.startRun();
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    const a = (await detail(x, runId)).pendingApproval;
    if (a === null) throw new Error('no approval');
    await x.engine.handle('relay/v1/runs.pause', { runId });
    await writeFile(join(x.projectRoot, CHANGED_FILE), 'changed while paused\n');

    const dec = await x.engine.handle('relay/v1/approvals.decide', { idempotencyKey: 'paused-approve-0001', approvalId: a.id, planHash: a.planHash,
      contextHash: a.contextHash, decision: 'approved' });

    expect(dec.ok ? null : [dec.error.code, dec.error.details?.['reason']]).toEqual(['CONFLICT', 'run_not_awaiting_approval']);
    expect(x.db.repos.approvals.get(a.id)?.invalidatedAt).toBeNull();
    const res = await resume(x, runId, 'paused-resume-00001');
    expect(res.ok && res.data.status).toBe('awaiting_approval');
    expect((await detail(x, runId)).pendingApproval?.id).toBe(a.id);
  });

  it('a decide whose input check races a pause: the stale approval pauses the run approval_stale (never stranded running)', async () => {
    const x = await createHarness();
    h = x;
    const runId = await x.startRun();
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    const a = (await detail(x, runId)).pendingApproval;
    if (a === null) throw new Error('no approval');
    await writeFile(join(x.projectRoot, CHANGED_FILE), 'changed before the decision\n');
    // The user pauses while approvals.decide hashes the project's files (outside any tx).
    const fs = x.ctx.projectFs as { hashFiles: (...args: unknown[]) => Promise<unknown> };
    const hashFiles = fs.hashFiles.bind(fs);
    let paused = false;
    fs.hashFiles = async (...args: unknown[]) => {
      if (!paused) {
        paused = true;
        expect((await x.engine.handle('relay/v1/runs.pause', { runId })).ok).toBe(true);
      }
      return hashFiles(...args);
    };

    const dec = await x.engine.handle('relay/v1/approvals.decide', { idempotencyKey: 'raced-approve-0001', approvalId: a.id, planHash: a.planHash,
      contextHash: a.contextHash, decision: 'approved' });
    fs.hashFiles = hashFiles;

    expect(paused).toBe(true);
    expect(dec.ok ? null : dec.error.code).toBe('PROJECT_CHANGED');
    const run = x.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason, run.statusDetail?.code]).toEqual(['paused', 'approval_stale', 'PROJECT_CHANGED']);
    expect((await detail(x, runId)).availableActions).toContain('resnapshot_and_replan');
  });

  it('safety net: resume of a paused run whose approval step waits with nothing pending takes the approval_stale pause', async () => {
    const x = await createHarness();
    h = x;
    const runId = await x.startRun();
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    const a = (await detail(x, runId)).pendingApproval;
    if (a === null) throw new Error('no approval');
    await x.engine.handle('relay/v1/runs.pause', { runId });
    // An approval invalidated while the run was paused (an earlier build, or any other path).
    x.db.tx('immediate', (r) => r.approvals.invalidate(a.id, 'project_changed', x.clock.now()));

    const res = await resume(x, runId, 'stranded-resume-001');
    for (let i = 0; i < 4; i += 1) await tick(x.ctx);

    expect(res.ok && res.data.status).toBe('paused');
    const run = x.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason, run.statusDetail?.code]).toEqual(['paused', 'approval_stale', 'PROJECT_CHANGED']);
  });
});

describe('P-2: a pause requested while the approval opens', () => {
  it('is applied in the same commit: paused(user) with the approval pending, no leftover flag; resume → awaiting_approval', async () => {
    const x = await createHarness();
    h = x;
    const runId = await x.startRun();
    for (let i = 0; i < 20 && x.db.repos.steps.latestFor(runId, 'plan' as StepKey)?.state !== 'succeeded'; i += 1) await tick(x.ctx);
    expect(x.db.repos.runs.get(runId).status).toBe('running');
    const store = x.ctx.artifacts as { read: (...args: unknown[]) => Promise<unknown> };
    const read = store.read.bind(store);
    let fired = false;
    store.read = async (...args: unknown[]) => {
      if (!fired) {
        fired = true;
        await x.engine.handle('relay/v1/runs.pause', { runId });
      }
      return read(...args);
    };
    await tick(x.ctx); // openApproval reads the plan artifact: the pause lands there
    store.read = read;

    expect(fired).toBe(true);
    const run = x.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason, run.pauseRequested]).toEqual(['paused', 'user', false]);
    const d = await detail(x, runId);
    expect(d.pendingApproval).not.toBeNull();
    expect(d.pauseRequested).toBe(false);
    const res = await resume(x, runId, 'opened-resume-00001');
    expect(res.ok && res.data.status).toBe('awaiting_approval');
    await approvePending(x, runId);
    for (let i = 0; i < 3; i += 1) await tick(x.ctx);
    expect(x.db.repos.runs.get(runId).status).not.toBe('paused'); // the approval is never followed by a stray pause
  });
});

async function exportOf(x: Harness, runId: RunId, what: 'report' | 'patch' | 'both') {
  const dir = await mkdtemp(join(x.userDataDir, 'export-'));
  const res = await x.engine.handle('relay/v1/artifacts.exportTo', { runId, what, destinationRealpath: dir });
  const files = await readdir(dir);
  const text = async (suffix: string) => {
    const f = files.find((n) => n.endsWith(suffix));
    return f === undefined ? null : readFile(join(dir, f), 'utf8');
  };
  return { res, md: await text('.md'), patch: await text('.patch') };
}

const SECRET = `sk-ant-api03-${'Zx9Yw8Vu7T'.repeat(5)}`;

describe('P-3 / P-4: interim exports', () => {
  it('P-3: during a revision cycle the superseded patch is neither offered nor exported; the Markdown agrees (patch: none)', async () => {
    const x = await createHarness({ scenario: 'revise-then-accept' });
    h = x;
    const runId = await x.startRun();
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    await approvePending(x, runId);
    for (let i = 0; i < 40; i += 1) {
      const impl = x.db.repos.steps.latestFor(runId, 'implement' as StepKey);
      if (impl !== undefined && impl.revisionIndex > 0) break;
      await tick(x.ctx);
    }
    expect(x.db.repos.artifacts.listForRun(runId, ['patch']).length).toBeGreaterThan(0); // the rejected patch exists
    await x.engine.handle('relay/v1/runs.pause', { runId });
    await tick(x.ctx);
    expect(x.db.repos.runs.get(runId).status).toBe('paused');

    expect((await detail(x, runId)).availableActions).not.toContain('export_patch');
    const both = await exportOf(x, runId, 'both');
    expect(both.patch).toBeNull();
    expect(both.md).toContain('- patch: none');
    expect(both.res.ok && both.res.data.failed?.map((f) => [f.what, f.code])).toEqual([['patch', 'NOT_FOUND']]);
    const only = await exportOf(x, runId, 'patch');
    expect(only.res.ok ? null : only.res.error.code).toBe('NOT_FOUND');
  });

  it('P-4: finished step outputs in an interim export are redacted', async () => {
    const base = FAKE_FIXTURES['findings.v1'] as { summary: string };
    const x = await createHarness({
      extraFixtures: { leaky: { ...base, summary: `${base.summary} The config hard-codes ANTHROPIC_API_KEY=${SECRET}.` } },
      scenario: { name: 'leaky', steps: [{ match: { stepKey: 'review' }, result: { kind: 'success', fixture: 'leaky' } }] },
    });
    h = x;
    const runId = await x.startRun();
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');

    const { md } = await exportOf(x, runId, 'report');

    expect(md).toContain('Finished step outputs');
    expect(md).toContain('hard-codes ANTHROPIC_API_KEY=');
    expect(md).not.toContain(SECRET);
  });

  it('P-4: the final report Markdown is redacted too (free text such as the goal)', async () => {
    const x = await createHarness();
    h = x;
    const runId = await x.startRun();
    expect(await driveThroughApproval(x, runId, ['completed', 'incomplete'])).toMatch(/completed|incomplete/);
    const report = buildReport(x.ctx, x.db.repos, x.db.repos.runs.get(runId));

    const md = renderReportMarkdown({ ...report, goal: `Rotate the key ${SECRET} in the config.` });

    expect(md).toContain('Rotate the key');
    expect(md).not.toContain(SECRET);
  });
});
