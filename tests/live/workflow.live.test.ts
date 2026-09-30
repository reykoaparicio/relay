// 04 §D9b: the full template once per live adapter, through createRuntime({ providerMode: 'live' }), against a temp copy
// of tests/fixtures/sample-api. Runs only with RELAY_LIVE_TESTS=1; spends real money under
// RELAY_LIVE_WORKFLOW_CAP_MICROUSD (default 1 500 000 = $1.50) for the whole file. Run manually:
//   RELAY_LIVE_TESTS=1 pnpm test:live
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ok } from '@relay/contracts';
import type { ProviderId, RunId } from '@relay/contracts';
import { createRuntime } from '@relay/engine';
import type { Runtime } from '@relay/engine';
import { cheapestCatalogModel } from '@relay/providers';
import { LIVE, capFromEnv, liveKey, skipNotice, usd } from './live-env.js';

const DEFAULT_CAP_MICROUSD = 1_500_000;
const RUN_TIMEOUT_MS = 20 * 60_000;
const MODEL_STEPS = ['review', 'plan', 'implement', 'verify'] as const;
const SAMPLE_API = fileURLToPath(new URL('../fixtures/sample-api', import.meta.url));
const INPUT_FILES = ['src/handlers/user.ts', 'src/handlers/orders.ts', 'src/lib/format.ts', 'src/lib/validate.ts'];
const STOP_STATUSES = new Set(['awaiting_approval', 'paused', 'completed', 'incomplete', 'cancelled', 'failed']);

const cap = LIVE ? capFromEnv('RELAY_LIVE_WORKFLOW_CAP_MICROUSD', DEFAULT_CAP_MICROUSD) : DEFAULT_CAP_MICROUSD;
let spent = 0;

afterAll(() => {
  if (LIVE) process.stdout.write(`[live] workflow total: ${usd(spent)} (cap ${usd(cap)})\n`);
});

async function waitForStop(rt: Runtime, runId: RunId): Promise<string> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  for (;;) {
    const status = rt.db.repos.runs.get(runId).status;
    if (STOP_STATUSES.has(status)) return status;
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${status} after ${String(RUN_TIMEOUT_MS)} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function approve(rt: Runtime, runId: RunId): Promise<void> {
  const detail = await rt.engine.handle('relay/v1/runs.get', { runId });
  if (!detail.ok || detail.data.pendingApproval === null) throw new Error('no pending approval');
  const a = detail.data.pendingApproval;
  const decided = await rt.engine.handle('relay/v1/approvals.decide', {
    idempotencyKey: `live-approve-${runId}`.slice(0, 64),
    approvalId: a.id,
    planHash: a.planHash,
    contextHash: a.contextHash,
    decision: 'approved',
  });
  expect(decided.ok, JSON.stringify(decided)).toBe(true);
}

function defineWorkflow(providerId: ProviderId): void {
  const key = liveKey(providerId);
  skipNotice(providerId);

  it.skipIf(!LIVE || key === undefined)(`${providerId}: full template on the catalog model`, async () => {
    if (key === undefined) return;
    const model = cheapestCatalogModel(providerId);
    expect(model).toBeDefined();
    if (model === undefined) return;
    const remaining = cap - spent;
    expect(remaining, 'workflow cap already exhausted').toBeGreaterThan(0);

    const userDataDir = mkdtempSync(join(tmpdir(), `relay-live-ud-${providerId}-`));
    const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), `relay-live-prj-${providerId}-`)));
    cpSync(SAMPLE_API, projectRoot, { recursive: true, filter: (src) => !src.includes('node_modules') });
    const rt = await createRuntime({
      userDataDir,
      providerMode: 'live',
      // Keys only from the test env; the resolver never sees another provider's key.
      credentials: { resolve: (req) => Promise.resolve(ok(req.providerId === providerId ? key : '')) },
      idleMs: 250,
    });
    try {
      await rt.engine.start();
      const project = await rt.engine.handle('relay/v1/projects.createFromRoot', {
        idempotencyKey: `live-project-${providerId}-0001`,
        rootRealpath: projectRoot,
        rootDisplayPath: '~/sample-api',
        name: `Live ${providerId}`,
        exclusions: [],
        allowedProviderIds: [providerId],
        monthlyAllowanceMicrousd: null,
        isDemo: false,
      });
      if (!project.ok) throw new Error(`projects.createFromRoot: ${project.error.code}`);
      const profile = await rt.engine.handle('relay/v1/profiles.upsert', {
        profile: {
          name: `Live ${providerId}`.slice(0, 40),
          providerId,
          modelId: model.modelId,
          params: {
            maxOutputTokens: 16_000,
            ...(model.capabilities.effortLevels.includes('low') ? { effort: 'low' as const } : {}),
            refusalFallback: 'off',
          },
        },
      });
      if (!profile.ok) throw new Error(`profiles.upsert: ${profile.error.code}`);
      const workflow = rt.db.repos.workflows.listWorkflows()[0];
      if (workflow === undefined) throw new Error('no seeded workflow');

      const started = await rt.engine.handle('relay/v1/runs.start', {
        idempotencyKey: `live-run-${providerId}-0001`,
        projectId: project.data.id,
        workflowId: workflow.id,
        workflowVersion: 1,
        goal: 'Fix the defects in the handlers with minimal changes.',
        input: { kind: 'files', relPaths: INPUT_FILES },
        // The run budget is the remaining file cap, so admission blocks any dispatch that would exceed it.
        limitOverrides: { budgetMicrousd: remaining },
        profileOverrides: Object.fromEntries(MODEL_STEPS.map((s) => [s, profile.data.profile.id])),
      });
      if (!started.ok) throw new Error(`runs.start: ${started.error.code} ${JSON.stringify(started.error.details)}`);
      const runId = started.data.runId;

      let status = await waitForStop(rt, runId);
      if (status === 'awaiting_approval') {
        await approve(rt, runId);
        status = await waitForStop(rt, runId);
      }

      const r = rt.db.repos;
      const balances = r.ledger.runBalances(runId);
      spent += balances.C + balances.U;
      process.stdout.write(`[live] ${providerId} run ${runId}: ${status}, settled ${usd(balances.C)}, unknown ${usd(balances.U)}\n`);
      expect(spent, `cumulative live workflow spend ${usd(spent)} exceeds cap ${usd(cap)}`).toBeLessThanOrEqual(cap);

      const run = r.runs.get(runId);
      if (status === 'paused' && run.pauseReason === 'budget_run') {
        process.stdout.write(`[live] ${providerId}: paused(budget_run) — raise RELAY_LIVE_WORKFLOW_CAP_MICROUSD to complete the template\n`);
        return;
      }
      expect(status, JSON.stringify(run.statusDetail)).toBe('completed');
      const attempts = r.attempts.listForRun(runId);
      expect(attempts.length).toBeGreaterThanOrEqual(MODEL_STEPS.length);
      for (const a of attempts) expect(a.providerResponseId, `attempt ${a.id}`).toBeTruthy();
      const certainty = r.ledger.settledByCertainty(runId);
      expect(certainty.calculated).toBe(balances.C);
      expect(balances.U).toBe(0);
      // The engine accepts a patch only when every diff parses and applies cleanly to the snapshot (06 F8).
      expect(r.steps.latestPerStepKey(runId).find((s) => s.stepKey === 'implement')?.state).toBe('succeeded');
      expect(r.artifacts.listForRun(runId, ['patch']).length).toBeGreaterThan(0);
    } finally {
      await rt.dispose();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, RUN_TIMEOUT_MS + 60_000);
}

describe('live workflow (D9b)', () => {
  defineWorkflow('anthropic');
  defineWorkflow('openai');
});
