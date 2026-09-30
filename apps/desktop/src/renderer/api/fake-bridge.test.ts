import { describe, expect, it } from 'vitest';
import { OPERATIONS, PAUSE_REASONS, runDetailSchema } from '@relay/contracts';
import type { OperationKey } from '@relay/contracts';
import { createFakeBridge, FAKE_HANDLED_OPERATIONS, FAKE_SCENARIOS, FAKE_WORKFLOW_ID, fakeScenarioFromUrl } from './fake-bridge';
import { allowedRunActions } from './fake-scenarios/allowed-actions';

const PROJECT = 'prj_00000000000000000000000001';

describe('fake bridge', () => {
  it('has a handler for every channel in OPERATIONS (and nothing else)', () => {
    const keys = Object.keys(OPERATIONS) as OperationKey[];
    expect([...FAKE_HANDLED_OPERATIONS].sort()).toEqual([...keys].sort());
    for (const key of keys) expect(OPERATIONS[key].channel).toBe(`relay/v1/${key}`);
  });

  it('rejects invalid input on every channel with VALIDATION_FAILED (inputs are validated with the contracts schemas)', async () => {
    const bridge = createFakeBridge('awaiting-approval');
    for (const op of Object.values(OPERATIONS)) {
      const res = await bridge.invoke(op.channel, { definitelyNot: 'valid', projectId: 42 } as never);
      // Channels with an empty input schema accept unknown keys (zod strips them); every other one must reject.
      if (res.ok) {
        expect(op.input.safeParse({}).success, `${op.channel} accepted invalid input`).toBe(true);
      } else {
        expect(res.error.code, op.channel).toBe('VALIDATION_FAILED');
      }
    }
  });

  it.each(FAKE_SCENARIOS)('scenario %s serves schema-valid query outputs', async (scenario) => {
    const bridge = createFakeBridge(scenario);
    const hasProject = bridge.world.projects.some((p) => p.id === PROJECT);
    const queries = [
      bridge.invoke('relay/v1/app.getInfo', {}),
      bridge.invoke('relay/v1/app.getSettings', {}),
      bridge.invoke('relay/v1/app.getDiagnostics', {}),
      bridge.invoke('relay/v1/projects.list', {}),
      bridge.invoke('relay/v1/providers.list', {}),
      bridge.invoke('relay/v1/providers.catalog', {}),
      bridge.invoke('relay/v1/profiles.list', {}),
      bridge.invoke('relay/v1/workflows.list', {}),
      ...(hasProject
        ? [
            bridge.invoke('relay/v1/projects.get', { projectId: PROJECT }),
            bridge.invoke('relay/v1/ledger.projectSummary', { projectId: PROJECT }),
            bridge.invoke('relay/v1/runs.list', { projectId: PROJECT }),
          ]
        : []),
      ...(bridge.world.notImplemented.has('memory.list') ? [] : [bridge.invoke('relay/v1/memory.list', { projectId: PROJECT })]),
    ];
    for (const res of await Promise.all(queries)) expect(res.ok).toBe(true);
    for (const run of bridge.world.runs) {
      for (const res of await Promise.all([
        bridge.invoke('relay/v1/runs.get', { runId: run.id }),
        bridge.invoke('relay/v1/runs.events', { runId: run.id, afterSeq: 0 }),
        bridge.invoke('relay/v1/ledger.runSummary', { runId: run.id }),
        bridge.invoke('relay/v1/ledger.entries', { runId: run.id }),
        ...run.steps.map((s) => bridge.invoke('relay/v1/runs.getStep', { runId: run.id, stepId: s.id })),
      ])) {
        expect(res.ok).toBe(true);
      }
    }
  });

  it('every run exposes the 06 allowedRunActions for its status and pause reason', () => {
    for (const scenario of FAKE_SCENARIOS) {
      for (const run of createFakeBridge(scenario).world.runs) {
        expect(runDetailSchema.safeParse(run).success).toBe(true);
        const expected = allowedRunActions(run.status, run.pauseReason, {
          unknownAttempts: run.unresolvedAttempts.length,
          hasFailedStep: run.steps.some((s) => s.state === 'failed'),
          hasPatchArtifact: run.steps.some((s) => s.stepKey === 'implement' && s.outputArtifactId !== null),
        });
        expect(run.availableActions, `${scenario} ${run.id}`).toEqual(expected);
      }
    }
  });

  it('covers every pause reason with a scenario', () => {
    const reasons = new Set(FAKE_SCENARIOS.flatMap((s) => createFakeBridge(s).world.runs.map((r) => r.pauseReason)));
    for (const reason of PAUSE_REASONS) expect(reasons.has(reason), reason).toBe(true);
  });

  it('replays an idempotent command with the same key instead of executing it twice', async () => {
    const bridge = createFakeBridge('empty');
    const first = await bridge.invoke('relay/v1/projects.createSample', { idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZZ' });
    const again = await bridge.invoke('relay/v1/projects.createSample', { idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZZ' });
    expect(first).toEqual(again);
    expect(bridge.world.projects.filter((p) => p.isDemo)).toHaveLength(1);
  });

  it('pushes run.status and a gapless run.event when a run changes status', async () => {
    const bridge = createFakeBridge('active-run');
    const pushes: string[] = [];
    bridge.subscribe((e) => pushes.push(e.type));
    const run = bridge.world.runs[0];
    const before = bridge.world.events.get(run?.id ?? '')?.at(-1)?.seq ?? 0;
    const res = await bridge.invoke('relay/v1/runs.pause', { runId: run?.id ?? '' });
    expect(res).toEqual({ ok: true, data: { status: 'paused', inFlight: 'none' } });
    expect(pushes).toEqual(['run.event', 'run.status']);
    expect(bridge.world.events.get(run?.id ?? '')?.at(-1)?.seq).toBe(before + 1);
  });

  it('answers approvals.decide with APPROVAL_STALE when the echoed hashes differ', async () => {
    const bridge = createFakeBridge('awaiting-approval');
    const approval = bridge.world.runs.find((r) => r.pendingApproval !== null)?.pendingApproval;
    const res = await bridge.invoke('relay/v1/approvals.decide', {
      idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZY',
      approvalId: approval?.id ?? '',
      planHash: 'f'.repeat(64),
      contextHash: approval?.contextHash ?? '',
      decision: 'approved',
    });
    expect(res.ok ? null : res.error.code).toBe('APPROVAL_STALE');
  });

  it('answers stubbed channels like the M1 runner: INTERNAL with details.reason not_implemented', async () => {
    const bridge = createFakeBridge('backend-stubs');
    const res = await bridge.invoke('relay/v1/providers.test', { providerId: 'anthropic' });
    expect(res.ok ? null : res.error).toMatchObject({ code: 'INTERNAL', details: { reason: 'not_implemented' } });
    expect(bridge.world.projects).toEqual([]);
  });

  it('runs.start fails with the preflight issues (validation-errors) and with BUDGET_BLOCKED until the allowance admits N', async () => {
    const invalid = createFakeBridge('validation-errors');
    const input = {
      projectId: PROJECT,
      workflowId: FAKE_WORKFLOW_ID,
      workflowVersion: 3,
      goal: 'x',
      input: { kind: 'files' as const, relPaths: ['src/app.ts'] },
    };
    const a = await invalid.invoke('relay/v1/runs.start', { ...input, idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZX' });
    expect(a.ok ? null : a.error.code).toBe('VALIDATION_FAILED');
    const blocked = createFakeBridge('budget-blocked');
    const b = await blocked.invoke('relay/v1/runs.start', { ...input, idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZW' });
    expect(b.ok ? null : b.error.code).toBe('BUDGET_BLOCKED');
    const c = await blocked.invoke('relay/v1/runs.start', {
      ...input,
      idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZV',
      limitOverrides: { budgetMicrousd: 3_200_000 },
    });
    expect(c.ok).toBe(true);
  });

  it('reads the scenario from ?fake= in the search or the hash query', () => {
    expect(fakeScenarioFromUrl({ search: '?fake=interrupted', hash: '' })).toBe('interrupted');
    expect(fakeScenarioFromUrl({ search: '', hash: '#/p/x?fake=empty' })).toBe('empty');
    expect(fakeScenarioFromUrl({ search: '?fake=nope', hash: '' })).toBe('awaiting-approval');
  });
});
