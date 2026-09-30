// 11 §K6 multi-provider (@m2): reviewer on the fake anthropic adapter, planner on the fake openai adapter (the seeded
// "Balanced · OpenAI" profile) → attempts and call log record both provider ids; a project policy that disallows
// openai → preflight PERMISSION_DENIED.
import { afterEach, describe, expect, it } from 'vitest';
import type { StepKey } from '@relay/contracts';
import { DEFAULT_REL_PATHS, createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

describe('multi-provider @m2', () => {
  it('reviewer → anthropic, planner → openai ("Balanced · OpenAI"): attempts and call log record both provider ids @m2', async () => {
    h = await createHarness();
    const openai = h.db.repos.profiles.getByName('Balanced · OpenAI');
    expect(openai?.providerId).toBe('openai');

    const runId = await h.startRun({ profileOverrides: { plan: openai!.id } });
    await h.waitFor(runId, 'awaiting_approval');
    await h.approve(runId);
    await h.waitFor(runId, 'completed');

    expect(h.attempts(runId, 'review').map((a) => a.providerId)).toEqual(['anthropic']);
    expect(h.attempts(runId, 'plan').map((a) => [a.providerId, a.modelId])).toEqual([['openai', openai!.modelId]]);
    expect(h.calls({ runId, stepKey: 'review' }).map((c) => c.providerId)).toEqual(['anthropic']);
    expect(h.calls({ runId, stepKey: 'plan' }).map((c) => c.providerId)).toEqual(['openai']);
    expect(new Set(h.calls({ runId }).map((c) => c.providerId))).toEqual(new Set(['anthropic', 'openai']));
    const detail = await h.call('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.steps.find((s) => s.stepKey === ('plan' as StepKey))).toBeDefined();
  });

  it('the project policy disallows openai → preflight (and start) PERMISSION_DENIED @m2', async () => {
    h = await createHarness({ allowedProviderIds: ['anthropic', 'fake'], start: false });
    const openai = h.db.repos.profiles.getByName('Balanced · OpenAI')!.id;

    const pre = await h.call('relay/v1/runs.preflight', { projectId: h.projectId, workflowId: h.workflowId, workflowVersion: 1,
      goal: 'Fix the defects in the handlers.', input: { kind: 'files', relPaths: [...DEFAULT_REL_PATHS] }, profileOverrides: { plan: openai } });
    const start = await h.startRunRaw({ profileOverrides: { plan: openai } });

    expect(pre.ok ? null : [pre.error.code, pre.error.details]).toEqual(['PERMISSION_DENIED', expect.objectContaining({ stepKey: 'plan', providerId: 'openai', reason: 'provider_not_allowed' })]);
    expect(start.ok ? null : start.error.code).toBe('PERMISSION_DENIED');
  });
});
