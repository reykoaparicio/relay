// 06 F13 runChecks + F14 preflight readiness: missing credential ref, provider/model not permitted, model missing from
// the catalog, and an allowance that cannot cover the first reservation are reported by `runs.preflight` and pause a
// queued run (queued → paused(auth_required | setup_blocked | budget_*)) BEFORE any reservation or provider call.
import { afterEach, describe, expect, it } from 'vitest';
import { errors, microusd, upperBound } from '@relay/contracts';
import type { ModelCapabilities, RunStartInput, StepKey } from '@relay/contracts';
import { admit } from './budget.js';
import { budgetReadiness, checkStepReadiness, minimumReservation, toPreflightIssue } from './policy.js';
import type { ModelStepSnapshot } from './ports.js';
import { queuedRunIssues, tick } from './runner.js';
import { createHarness } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const MODEL_KEYS = ['review', 'plan', 'implement', 'verify'];
const caps: ModelCapabilities = { structuredOutput: true, streaming: true, tools: false, maxInputTokens: 100_000, maxOutputTokens: 8_000,
  supportsRequestLookup: false, supportsTokenCounting: false, effortLevels: ['low'], thinkingAlwaysOn: false };
const prices = { input: microusd(1), output: microusd(5), cacheRead: microusd(1), cacheWrite: microusd(2) };
const entry = { providerId: 'anthropic' as const, modelId: 'm', catalogVersion: 'v', prices, capabilities: caps } as never;

async function setup(o: HarnessOptions = {}): Promise<{ x: Harness; input: Omit<RunStartInput, 'idempotencyKey'> }> {
  const x = await createHarness(o);
  h = x;
  const wf = x.db.repos.workflows.listWorkflows()[0];
  return { x, input: { projectId: x.projectId, workflowId: wf?.id ?? ('' as never), workflowVersion: 1, goal: 'Fix it',
    input: { kind: 'files', relPaths: ['src/lib/format.ts' as never] } } };
}

describe('readiness checks (pure, F6 order)', () => {
  const step = { stepKey: 'review' as StepKey, profile: { providerId: 'anthropic' as const, modelId: 'm', params: { maxOutputTokens: 1_000, refusalFallback: 'off' as const } },
    capabilities: caps, catalogEntry: entry, hasCredential: true };

  it('passes a permitted, connected, catalogued profile', () => {
    expect(checkStepReadiness(['anthropic'], step)).toEqual([]);
  });

  it('reports provider, credential, then model problems, each with its pause reason', () => {
    const all = checkStepReadiness([], { ...step, catalogEntry: undefined, hasCredential: false });

    expect(all.map((i) => [i.code, i.reason, i.error.code])).toEqual([
      ['provider_not_allowed', 'setup_blocked', 'PERMISSION_DENIED'],
      ['missing_credential', 'auth_required', 'AUTH_REQUIRED'],
      ['model_unknown', 'setup_blocked', 'MODEL_UNSUPPORTED'],
    ]);
    expect(all.every((i) => i.stepKey === 'review' && i.error.details?.['stepKey'] === 'review')).toBe(true);
    expect(checkStepReadiness(['anthropic'], { ...step, profile: { ...step.profile, params: { ...step.profile.params, effort: 'max' } } }).map((i) => i.code))
      .toEqual(['effort_unsupported']);
  });

  it('minimumReservation is the output allowance with no input; budgetReadiness maps the admission scope', () => {
    const snap = { maxOutputTokens: 1_000, profile: { prices } } as unknown as ModelStepSnapshot;
    const N = minimumReservation(snap);
    const run = { L: microusd(N - 1), C: microusd(0), R: microusd(0), U: microusd(0) };

    expect(N).toBe(upperBound(0, 1_000, prices));
    expect(budgetReadiness(admit({ run: { ...run, L: microusd(N) }, project: null, N }))).toBeNull(); // inclusive
    expect(budgetReadiness(admit({ run, project: null, N }))?.reason).toBe('budget_run');
    expect(budgetReadiness(admit({ run: { ...run, L: microusd(N) }, project: { L: microusd(0), C: microusd(0), R: microusd(0), U: microusd(0) }, N }))?.reason).toBe('budget_project');
  });

  it('maps issues to preflight form paths (profile select per step, the allowance otherwise)', () => {
    const [cred] = checkStepReadiness(['anthropic'], { ...step, hasCredential: false });
    const budget = budgetReadiness(admit({ run: { L: microusd(0), C: microusd(0), R: microusd(0), U: microusd(0) }, project: null, N: microusd(1) }));

    expect(cred === undefined ? null : toPreflightIssue(cred)).toEqual({ path: 'profileOverrides.review', code: 'missing_credential', message: expect.any(String) as string });
    expect(budget === null ? null : toPreflightIssue(budget)).toEqual({ path: 'limitOverrides.budgetMicrousd', code: 'budget_run', message: expect.any(String) as string });
    expect(toPreflightIssue({ stepKey: null, reason: 'budget_project', code: 'budget_project', error: errors.internal('x' as never) }).path).toBe('project.monthlyAllowanceMicrousd');
  });
});

describe('runs.preflight issues (F14)', () => {
  it('a clean setup has no issues', async () => {
    const { x, input } = await setup();
    const res = await x.engine.handle('relay/v1/runs.preflight', input);

    expect(res.ok && res.data.issues).toEqual([]);
  });

  it('lists a missing credential per model step (from the credential-ref repo; the resolver is never asked)', async () => {
    let asked = 0;
    const { x, input } = await setup({ credentialRefs: [], credentials: { resolve: () => { asked += 1; return Promise.reject(new Error('never')); } } });

    const res = await x.engine.handle('relay/v1/runs.preflight', input);

    if (!res.ok) throw new Error(res.error.code);
    expect(res.data.issues.map((i) => [i.path, i.code])).toEqual(MODEL_KEYS.map((k) => [`profileOverrides.${k}`, 'missing_credential']));
    expect(asked).toBe(0);
    expect(res.data.firstReservation.N).toBeGreaterThan(0); // the summary is still computed
  });

  it('lists a provider the project policy does not permit (instead of failing), and still estimates the other steps', async () => {
    const { x, input } = await setup({ allowedProviderIds: ['anthropic', 'fake'] });
    const openai = x.db.repos.profiles.getByName('Balanced · OpenAI')?.id ?? ('' as never);

    const res = await x.engine.handle('relay/v1/runs.preflight', { ...input, profileOverrides: { plan: openai } });

    if (!res.ok) throw new Error(res.error.code);
    expect(res.data.issues.map((i) => [i.path, i.code])).toEqual([['profileOverrides.plan', 'provider_not_allowed']]);
    expect(res.data.firstReservation.N).toBeGreaterThan(0);
    expect(res.data.inputSummary.providersReceivingContext).toEqual(['anthropic']);
  });

  it('lists a model missing from the catalog and an unknown profile', async () => {
    const { x, input } = await setup();
    const id = x.ids.next('profile');
    x.db.tx('immediate', (r) => {
      const saved = r.profiles.upsert({ id, name: 'Ghost', providerId: 'anthropic', modelId: 'claude-ghost', params: { maxOutputTokens: 1_000, refusalFallback: 'off' },
        capabilitiesSnapshot: caps, catalogVersion: 'x' });
      if (!saved.ok) throw new Error('upsert');
    });

    const ghost = await x.engine.handle('relay/v1/runs.preflight', { ...input, profileOverrides: { review: id } });
    const unknown = await x.engine.handle('relay/v1/runs.preflight', { ...input, profileOverrides: { verify: x.ids.next('profile') } });

    expect(ghost.ok && ghost.data.issues.map((i) => [i.path, i.code])).toEqual([['profileOverrides.review', 'model_unknown']]);
    expect(ghost.ok && ghost.data.firstReservation.N).toBe(0); // no resolvable first step → no reservation estimate
    expect(unknown.ok && unknown.data.issues.map((i) => [i.path, i.code])).toEqual([['profileOverrides.verify', 'unknown_profile']]);
  });

  it('lists an allowance (run or project month) that cannot cover the first reservation', async () => {
    const { x, input } = await setup({ monthlyAllowanceMicrousd: 1 });

    const project = await x.engine.handle('relay/v1/runs.preflight', input);
    const run = await x.engine.handle('relay/v1/runs.preflight', { ...input, limitOverrides: { budgetMicrousd: microusd(1) } });

    expect(project.ok && project.data.issues.map((i) => [i.path, i.code])).toEqual([['project.monthlyAllowanceMicrousd', 'budget_project']]);
    expect(project.ok && project.data.budget.allowed).toBe(false);
    expect(run.ok && run.data.issues.map((i) => [i.path, i.code])).toEqual([['limitOverrides.budgetMicrousd', 'budget_run']]); // run first (§9.3)
  });
});

describe('runChecks: a queued run pauses before any reservation (F13, F2 clarification 9)', () => {
  const nothingDispatched = (x: Harness, runId: Parameters<Harness['db']['repos']['attempts']['listForRun']>[0]) => {
    const ledger = x.db.repos.ledger.list(runId, { limit: 50, sort: 'created_asc' });
    return [x.db.repos.attempts.listForRun(runId).length, x.callLog.entries().length,
      ledger.ok ? ledger.value.items.filter((e) => e.type === 'reserve').length : -1];
  };

  it('no credential ref → paused(auth_required) with an actionable reason; reconnect + resume runs it', async () => {
    const { x } = await setup({ credentialRefs: [] });
    const runId = await x.startRun();

    await tick(x.ctx);

    const run = x.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason, run.statusDetail?.code, run.statusDetail?.details?.['providerId']]).toEqual(['paused', 'auth_required', 'AUTH_REQUIRED', 'anthropic']);
    expect(nothingDispatched(x, runId)).toEqual([0, 0, 0]);
    const detail = await x.engine.handle('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.availableActions).toEqual(['reconnect_provider', 'stop', 'export_report']); // E1 #8: no resume without a ref
    const early = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'ready-resume-0001', runId, decision: { kind: 'continue' } });
    expect(early.ok ? null : early.error.code).toBe('AUTH_REQUIRED'); // still no ref

    await x.engine.handle('relay/v1/providers.recordCredentialRef', { providerId: 'anthropic', storageMode: 'session', vaultFile: null, redactedLabel: 'sk-…' });
    const resumed = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'ready-resume-0002', runId, decision: { kind: 'continue' } });
    await tick(x.ctx);

    expect(resumed.ok && resumed.data.status).toBe('queued');
    expect(x.db.repos.runs.get(runId).status).toBe('running');
  });

  it('a provider removed from the project policy after start → paused(setup_blocked) PERMISSION_DENIED', async () => {
    const { x } = await setup();
    const runId = await x.startRun();
    const p = x.db.repos.projects.get(x.projectId);
    x.db.repos.projects.update(x.projectId, { providerPolicy: { ...p.providerPolicy, allowedProviderIds: ['openai'] } }, p.updatedAt);

    await tick(x.ctx);

    const run = x.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason, run.statusDetail?.code]).toEqual(['paused', 'setup_blocked', 'PERMISSION_DENIED']);
    expect(nothingDispatched(x, runId)).toEqual([0, 0, 0]);
  });

  it('a run allowance below the first step minimum → paused(budget_run) at queued; increase_allowance resumes it', async () => {
    const { x } = await setup();
    const runId = await x.startRun({ budgetMicrousd: 1 });

    await tick(x.ctx);

    const run = x.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason, run.statusDetail?.code]).toEqual(['paused', 'budget_run', 'BUDGET_BLOCKED']);
    expect(nothingDispatched(x, runId)).toEqual([0, 0, 0]);
    expect(x.db.repos.events.list(runId, 0, 50).some((e) => e.type === 'ledger.blocked')).toBe(true);
    const raised = await x.engine.handle('relay/v1/runs.increaseAllowance', { idempotencyKey: 'ready-raise-00001', runId, newAllowanceMicrousd: 3_000_000 });
    await tick(x.ctx);

    expect(raised.ok && raised.data.status).toBe('queued');
    expect(x.db.repos.runs.get(runId).status).toBe('running');
  });

  it('checks only the model steps still to run (a succeeded step whose provider lost its ref does not block)', async () => {
    const { x } = await setup();
    const runId = await x.startRun();
    x.db.tx('immediate', (r) => {
      const review = r.steps.latestFor(runId, 'review' as StepKey);
      if (review !== undefined) r.steps.transition(review.id, ['pending'], 'succeeded', {});
    });

    expect(queuedRunIssues(x.db.repos, x.db.repos.runs.get(runId), x.clock.now())).toEqual([]);
    x.db.repos.credentials.delete('anthropic');
    expect(queuedRunIssues(x.db.repos, x.db.repos.runs.get(runId), x.clock.now()).map((i) => i.stepKey)).toEqual(['plan', 'implement', 'verify']);
  });
});
