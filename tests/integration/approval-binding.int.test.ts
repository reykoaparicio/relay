// 11 §K5 / §17.1 "Plan or context changes after approval" + "Original project changes mid-run" (@m3). The approval
// binds plan hash, context hash, file scope, and the providers receiving context (F6/F10).
import { writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FakeScenario, ModelRequest } from '@relay/providers';
import { DEFAULT_REL_PATHS, createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { computeFixtureManifest } from '../helpers/fixture-hash.js';
import { FIXTURES_DIR, cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

const settled = (r: { status: string }) => !['queued', 'running'].includes(r.status);
const USER_TS = 'src/handlers/user.ts';

async function pending(x: Harness, runId: Parameters<Harness['approve']>[0]) {
  const d = await x.call('relay/v1/runs.get', { runId });
  if (!d.ok || d.data.pendingApproval === null) throw new Error('no pending approval');
  return d.data.pendingApproval;
}

describe('approval binding @m3', () => {
  it('(a) deciding with an old planHash → APPROVAL_STALE @m3', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    await h.waitFor(runId, 'awaiting_approval');
    const a = await pending(h, runId);

    const res = await h.call('relay/v1/approvals.decide', { idempotencyKey: 'stale-plan-hash-01', approvalId: a.id, planHash: 'f'.repeat(64), contextHash: a.contextHash, decision: 'approved' });

    expect(res.ok ? null : [res.error.code, res.error.details?.['reason']]).toEqual(['APPROVAL_STALE', 'plan_changed']);
    expect(h.db.repos.runs.get(runId).status).toBe('awaiting_approval');
    expect(h.calls({ runId, stepKey: 'implement' })).toEqual([]);
  });

  it('(b) a selected file modified after the plan → PROJECT_CHANGED and the approval is invalidated @m3', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    await h.waitFor(runId, 'awaiting_approval');
    const a = await pending(h, runId);
    await writeFile(join(h.projectRoot, USER_TS), '// edited by the user after the plan\n', 'utf8');

    const res = await h.call('relay/v1/approvals.decide', { idempotencyKey: 'project-changed-01', approvalId: a.id, planHash: a.planHash, contextHash: a.contextHash, decision: 'approved' });

    expect(res.ok ? null : [res.error.code, res.error.details?.['changedPaths']]).toEqual(['PROJECT_CHANGED', [USER_TS]]);
    expect(h.db.repos.approvals.get(a.id)?.invalidatedReason).toBe('project_changed');
    expect(h.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'approval_stale' }));
    expect(h.calls({ runId, stepKey: 'implement' })).toEqual([]);
  });

  it('(c) a revise cycle inside the approved scope needs no new approval @m3', async () => {
    h = await createHarness({ scenario: 'revise-then-accept' });
    const runId = await h.startRun();
    await h.waitFor(runId, 'awaiting_approval');
    await h.approve(runId);

    expect((await h.waitFor(runId, settled)).status).toBe('completed');
    expect(h.steps(runId, 'approve')).toHaveLength(1);
    expect(h.calls({ runId, stepKey: 'implement' })).toHaveLength(2);
  });

  it('(d) a replan whose plan widens fileScope (plan.scope-expanded) → a new approval is required @m3', async () => {
    const expanded = JSON.parse(readFileSync(`${FIXTURES_DIR}provider-responses/plan.scope-expanded.json`, 'utf8')) as { fileScope: string[] };
    const scenario: FakeScenario = { name: 'replan-scope-expanded', steps: [
      { match: { stepKey: 'plan' }, result: { kind: 'success' } },
      { match: { stepKey: 'plan' }, result: { kind: 'success', fixture: 'plan.scope-expanded' } },
    ] };
    h = await createHarness({ scenario, extraFixtures: { 'plan.scope-expanded': expanded } });
    // Every file the expanded scope names is a run input (F8: scope ⊆ inputs).
    const runId = await h.startRun({ relPaths: [...DEFAULT_REL_PATHS, 'src/router.ts', 'src/config.ts', 'test/user.test.ts', 'test/orders.test.ts', 'docs/api.md'] });
    await h.waitFor(runId, 'awaiting_approval');
    const first = await pending(h, runId);

    const replan = await h.call('relay/v1/approvals.decide', { idempotencyKey: 'replan-request-01', approvalId: first.id, planHash: first.planHash, contextHash: first.contextHash,
      decision: 'revision_requested', note: 'Also cover the router error handling.' });
    expect(replan.ok).toBe(true);
    await h.waitFor(runId, (r) => r.status === 'awaiting_approval' && h!.db.repos.approvals.pendingForRun(runId)?.id !== first.id);

    const second = await pending(h, runId);
    expect(second.id).not.toBe(first.id);
    expect(second.planHash).not.toBe(first.planHash);
    expect([...second.fileScope].sort()).toEqual([...expanded.fileScope].sort());
    expect(second.fileScope.some((f) => !first.fileScope.includes(f))).toBe(true);
    expect(h.calls({ runId, stepKey: 'plan' })).toHaveLength(2);
    expect(h.calls({ runId, stepKey: 'implement' })).toEqual([]);
  });

  it('(e) retryStep switching implement to another provider after approval → APPROVAL_STALE (provider_changed), no implement call on the new provider @m3', async () => {
    const scenario: FakeScenario = { name: 'implement-malformed-twice', steps: [
      { match: { stepKey: 'implement', purpose: 'initial' }, result: { kind: 'malformed', text: 'not json' } },
      { match: { stepKey: 'implement', purpose: 'schema_repair' }, result: { kind: 'malformed', text: '{"summary": ""}' } },
    ] };
    h = await createHarness({ scenario });
    const runId = await h.startRun();
    await h.waitFor(runId, 'awaiting_approval');
    const approval = await pending(h, runId);
    await h.approve(runId);
    const paused = await h.waitFor(runId, settled);
    expect([paused.status, paused.pauseReason]).toEqual(['paused', 'output_invalid']);
    const openai = h.db.repos.profiles.getByName('Balanced · OpenAI')!;

    const res = await h.retryStep(runId, 'implement', { profileId: openai.id });
    const after = res.ok ? await h.waitFor(runId, settled) : h.db.repos.runs.get(runId);

    const code = res.ok ? after.statusDetail?.code : res.error.code;
    expect(code).toBe('APPROVAL_STALE');
    expect(h.db.repos.approvals.get(approval.id)?.invalidatedReason).toBe('provider_changed');
    expect(h.calls({ runId, stepKey: 'implement', providerId: 'openai' })).toEqual([]);
    if (res.ok) expect([after.status, after.pauseReason]).toEqual(['paused', 'approval_stale']);
  });

  it('#midrun: a file changed between review and implement → PROJECT_CHANGED → use_preserved_snapshot continues on the input_file snapshot; the project is never written @m3', async () => {
    let projectRoot = '';
    const edited = '// changed on disk mid-run\nexport {};\n';
    h = await createHarness({ hooks: { afterStepCommit: (c) => {
      if (c.stepKey === 'review') writeFileSync(join(projectRoot, USER_TS), edited, 'utf8');
    } } });
    projectRoot = h.projectRoot;
    const original = await readFile(join(h.projectRoot, USER_TS), 'utf8');
    const requests: ModelRequest[] = [];
    const adapter = h.providers.get('anthropic');
    const generate = adapter.generate.bind(adapter);
    vi.spyOn(adapter, 'generate').mockImplementation((req, ctx) => {
      requests.push(req);
      return generate(req, ctx);
    });
    const runId = await h.startRun();

    const first = await h.waitFor(runId, settled);
    // The drift is detected before implement (at the plan/approval checks): a PROJECT_CHANGED stop, never a silent use.
    expect(first.status === 'paused' || first.status === 'awaiting_approval').toBe(true);
    let snapshotHash = '';
    if (first.status === 'awaiting_approval') {
      const a = await pending(h, runId);
      const decided = await h.call('relay/v1/approvals.decide', { idempotencyKey: 'midrun-approve-01', approvalId: a.id, planHash: a.planHash, contextHash: a.contextHash, decision: 'approved' });
      expect(decided.ok ? null : decided.error.code).toBe('PROJECT_CHANGED');
    } else {
      expect(first.statusDetail?.code).toBe('PROJECT_CHANGED');
    }
    snapshotHash = (await computeFixtureManifest(h.projectRoot)).treeHash;
    const detail = await h.call('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.availableActions).toContain('use_preserved_snapshot');

    const resumed = await h.resume(runId, { kind: 'use_preserved_snapshot' });
    expect(resumed.ok).toBe(true);
    const next = await h.waitFor(runId, settled);
    if (next.status === 'awaiting_approval') await h.approve(runId);
    expect((await h.waitFor(runId, settled)).status).toBe('completed');

    const implementReq = requests.filter((q) => q.metadata.stepKey === 'implement').at(-1);
    const content = implementReq?.messages[0]?.content ?? '';
    expect(content).toContain(original.split('\n').find((l) => l.includes('body[\'age\']')) ?? 'age');
    expect(content).not.toContain('changed on disk mid-run');
    expect(await readFile(join(h.projectRoot, USER_TS), 'utf8')).toBe(edited); // Relay never writes the project
    expect((await computeFixtureManifest(h.projectRoot)).treeHash).toBe(snapshotHash);
  });
});
