// Referee fixes for decision 3 (per-step output limits), ported from the bug hunt on f8c9f0f: L-1 a mid-run profile
// switch revisits the step's output limit (lowered to the new model's cap, recorded in the config revision, offered
// with a note, re-checked by the queued-run checks); L-3 a profile asking for more output than its model returns is
// clamped everywhere (never refused or hidden).
import { afterEach, describe, expect, it } from 'vitest';
import type { RunId, StepKey } from '@relay/contracts';
import { toModelProfile } from './profiles.js';
import { queuedRunIssues } from './runner.js';
import { resolveProfile } from './run-start.js';
import { effectiveStepSnapshot } from './snapshot.js';
import { drive } from './testing/drive.js';
import { SAMPLE_FILES, createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const REVIEW = 'review' as StepKey;
const HAIKU_CAP = 64_000;

/** A run whose review step asks for 100k output tokens on Opus, with an allowance too small for it (budget_run). */
async function capableRunBlockedOnBudget(x: Harness): Promise<RunId> {
  const capable = x.db.repos.profiles.getByName('Capable');
  if (capable === undefined) throw new Error('no Capable profile');
  const started = await x.engine.handle('relay/v1/runs.start', {
    idempotencyKey: 'limit-switch-key-001', projectId: x.projectId, workflowId: x.db.repos.workflows.listWorkflows()[0]?.id as never, workflowVersion: 1,
    goal: 'Fix the defects in the handlers.', input: { kind: 'files', relPaths: Object.keys(SAMPLE_FILES) },
    profileOverrides: { review: capable.id }, outputTokenOverrides: { review: 100_000 },
    limitOverrides: { budgetMicrousd: 1_000_000 }, // $1 < the minimum reservation of 100k Opus output tokens
  });
  if (!started.ok) throw new Error(started.error.code);
  const runId = started.data.runId;
  expect(await drive(x, runId, ['paused'])).toBe('paused');
  expect(x.db.repos.runs.get(runId).pauseReason).toBe('budget_run');
  return runId;
}

describe('L-1: a mid-run profile switch revisits the output limit', () => {
  it('switch_profile to a model with a lower cap lowers the step limit to that cap, records it, and the run proceeds', async () => {
    const x = await createHarness();
    h = x;
    const runId = await capableRunBlockedOnBudget(x);
    const economy = x.db.repos.profiles.getByName('Economy');
    if (economy === undefined) throw new Error('no Economy profile');
    const before = await x.engine.handle('relay/v1/runs.get', { runId });
    if (!before.ok) throw new Error(before.error.code);
    // Offered with a note instead of hidden.
    expect(before.data.profileOptions?.find((o) => o.profileId === economy.id)?.outputLimitLoweredTo).toBe(HAIKU_CAP);

    const sw = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'limit-switch-key-002', runId,
      decision: { kind: 'switch_profile', stepKey: REVIEW, profileId: economy.id } });

    expect(sw.ok).toBe(true);
    const eff = effectiveStepSnapshot(x.db.repos, x.db.repos.runs.get(runId), REVIEW);
    expect([eff.profile.modelId, eff.maxOutputTokens]).toEqual(['claude-haiku-4-5', HAIKU_CAP]);
    expect(x.db.repos.configRevisions.list(runId).at(-1)?.maxOutputTokens).toBe(HAIKU_CAP);
    const revised = x.db.repos.events.list(runId, 0, 1000).filter((e) => e.type === 'run.config_revised').at(-1);
    expect(revised?.payload['outputLimitLowered']).toEqual({ to: HAIKU_CAP, from: 100_000, modelId: 'claude-haiku-4-5' });
    const st = await drive(x, runId, ['paused', 'awaiting_approval', 'failed']);
    expect(st).toBe('awaiting_approval'); // dispatched with the lowered limit, never setup_blocked max_output_tokens
    const reviewAttempt = x.db.repos.attempts.listForRun(runId).find((a) => a.modelId === 'claude-haiku-4-5');
    expect(reviewAttempt).toBeDefined();
  });

  it('switching back to the larger model restores the limit the run started with', async () => {
    const x = await createHarness();
    h = x;
    const runId = await capableRunBlockedOnBudget(x);
    const economy = x.db.repos.profiles.getByName('Economy');
    const capable = x.db.repos.profiles.getByName('Capable');
    if (economy === undefined || capable === undefined) throw new Error('no profiles');
    const run = x.db.repos.runs.get(runId);
    const project = x.db.repos.projects.get(run.projectId);
    const toEconomy = await resolveProfile(x.ctx, project, REVIEW, toModelProfile(economy));
    const toCapable = await resolveProfile(x.ctx, project, REVIEW, toModelProfile(capable));
    if (!toEconomy.ok || !toCapable.ok) throw new Error('profile');
    // The same revision path as switch_profile / retryStep, applied twice.
    for (const [key, id] of [['limit-switch-key-003', economy.id], ['limit-switch-key-004', capable.id]] as const) {
      const cur = x.db.repos.runs.get(runId);
      if (cur.status !== 'paused') {
        x.db.tx('immediate', (r) => r.runs.updateStatus(runId, [cur.status], 'paused', { pauseReason: 'budget_run', statusDetail: null }));
      }
      const res = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: key, runId, decision: { kind: 'switch_profile', stepKey: REVIEW, profileId: id } });
      expect(res.ok).toBe(true);
    }
    expect(effectiveStepSnapshot(x.db.repos, x.db.repos.runs.get(runId), REVIEW).maxOutputTokens).toBe(100_000);
  });

  it('the queued-run checks pause setup_blocked when a step limit is above its model cap (before any reservation)', async () => {
    const x = await createHarness();
    h = x;
    const runId = await capableRunBlockedOnBudget(x);
    const economy = x.db.repos.profiles.getByName('Economy');
    if (economy === undefined) throw new Error('no Economy profile');
    const run = x.db.repos.runs.get(runId);
    const snap = await resolveProfile(x.ctx, x.db.repos.projects.get(run.projectId), REVIEW, toModelProfile(economy));
    if (!snap.ok) throw new Error(snap.error.code);
    // A revision recorded before migration 0006 (no output limit): the snapshot's 100k limit meets Haiku's cap.
    x.db.tx('immediate', (r) => r.configRevisions.append(runId, REVIEW, effectiveStepSnapshot(r, run, REVIEW).profile, snap.value, 'user_switch', null));

    const issues = queuedRunIssues(x.db.repos, x.db.repos.runs.get(runId), x.clock.now());

    const issue = issues.find((i) => i.stepKey === REVIEW && i.code === 'output_budget_low');
    expect(issue?.reason).toBe('setup_blocked');
    expect(issue?.error.details).toMatchObject({ reason: 'max_output_tokens', maxOutputTokens: 100_000, modelMaxOutputTokens: HAIKU_CAP });
  });
});

describe('L-3: a profile asking for more output than its model returns is clamped, not refused or hidden', () => {
  it('saves (informational warning), starts a run with the clamped limit, and is offered in choose-profile', async () => {
    const x = await createHarness();
    h = x;
    const saved = await x.engine.handle('relay/v1/profiles.upsert', { profile: { name: 'Haiku long', providerId: 'anthropic', modelId: 'claude-haiku-4-5',
      params: { maxOutputTokens: 100_000, refusalFallback: 'off' } } });
    if (!saved.ok) throw new Error(saved.error.code);
    expect(saved.data.warnings.map((w) => w.code)).toEqual(['output_budget_low']);
    const listed = await x.engine.handle('relay/v1/profiles.list', {});
    expect(listed.ok && listed.data.find((p) => p.profile.name === 'Haiku long')?.warnings.map((w) => w.code)).toEqual(['output_budget_low']);

    const runId = await capableRunBlockedOnBudget(x);
    const d = await x.engine.handle('relay/v1/runs.get', { runId });
    if (!d.ok) throw new Error(d.error.code);
    expect(d.data.profileOptions?.some((o) => o.profileId === saved.data.profile.id)).toBe(true);
  });
});
