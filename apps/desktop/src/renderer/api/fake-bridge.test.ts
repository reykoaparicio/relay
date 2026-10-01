import { describe, expect, it } from 'vitest';
import { OPERATIONS, PAUSE_REASONS, runDetailSchema } from '@relay/contracts';
import type { OperationKey } from '@relay/contracts';
import { createFakeBridge, FAKE_HANDLED_OPERATIONS, FAKE_PROJECT_ID, FAKE_SCENARIOS, FAKE_WORKFLOW_ID, fakeScenarioFromUrl } from './fake-bridge';
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

  it('no scenario stubs a channel: every operation is implemented by the real runner', () => {
    for (const s of FAKE_SCENARIOS) expect([s, [...createFakeBridge(s).world.notImplemented]]).toEqual([s, []]);
  });

  it('the notImplemented test hook answers like a stubbed runner channel: INTERNAL with details.reason not_implemented', async () => {
    const bridge = createFakeBridge('first-launch');
    bridge.world.notImplemented.add('providers.test');
    const res = await bridge.invoke('relay/v1/providers.test', { providerId: 'anthropic' });
    expect(res.ok ? null : res.error).toMatchObject({ code: 'INTERNAL', details: { reason: 'not_implemented' } });
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

  it('memory.resolveConflict follows the 02 rules: rewrite creates a record, a suggestion input is rejected, two suggestions fail', async () => {
    const bridge = createFakeBridge('memory-conflict');
    const m = (n: number) => `mem_${String(n).padStart(26, '0')}`;
    const twoSuggestions = await bridge.invoke('relay/v1/memory.resolveConflict', {
      idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZA',
      recordIds: [m(9), m(10)],
      resolution: { keep: m(9) },
    });
    expect(twoSuggestions.ok ? null : twoSuggestions.error.code).toBe('VALIDATION_FAILED');
    const res = await bridge.invoke('relay/v1/memory.resolveConflict', {
      idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZB',
      recordIds: [m(10), m(2)],
      resolution: { rewrite: { title: 'Validation', content: 'Use zod.', scope: { roles: 'all' } } },
    });
    expect(res.ok).toBe(true);
    const created = res.ok ? res.data[0] : undefined;
    expect(created?.status).toBe('approved');
    expect(bridge.world.memory.find((r) => r.id === m(10))?.status).toBe('rejected');
    const archived = bridge.world.memory.find((r) => r.id === m(2));
    expect(archived?.status).toBe('archived');
    expect(archived?.supersededById).toBe(created?.id);
  });

  it('workflows.saveDraft applies the patch to a new draft revision and validate/publish follow the draft issues', async () => {
    const bridge = createFakeBridge('validation-errors');
    const invalid = await bridge.invoke('relay/v1/workflows.validate', { workflowId: FAKE_WORKFLOW_ID, version: 'draft' });
    expect(invalid.ok && invalid.data.valid).toBe(false);
    const blocked = await bridge.invoke('relay/v1/workflows.publish', { idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZC', workflowId: FAKE_WORKFLOW_ID });
    expect(blocked.ok ? null : blocked.error.code).toBe('VALIDATION_FAILED');
    const stale = await bridge.invoke('relay/v1/workflows.saveDraft', { workflowId: FAKE_WORKFLOW_ID, expectedDraftRevision: 0, patch: {} });
    expect(stale.ok ? null : stale.error.code).toBe('CONFLICT');
    const saved = await bridge.invoke('relay/v1/workflows.saveDraft', {
      workflowId: FAKE_WORKFLOW_ID,
      expectedDraftRevision: 1,
      patch: { limits: { maxAttempts: 12 }, steps: { implement: { maxOutputTokens: 8000 } } },
    });
    expect(saved.ok ? saved.data.draftRevision : null).toBe(2);
    const step = saved.ok ? saved.data.spec.steps.find((x) => x.id === 'implement') : undefined;
    expect(step?.kind === 'model' ? step.maxOutputTokens : null).toBe(8000);
    expect(saved.ok ? saved.data.spec.limits.maxAttempts : null).toBe(12);
    const valid = await bridge.invoke('relay/v1/workflows.validate', { workflowId: FAKE_WORKFLOW_ID, version: 'draft' });
    expect(valid.ok && valid.data.valid).toBe(true);
    const published = await bridge.invoke('relay/v1/workflows.publish', { idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZD', workflowId: FAKE_WORKFLOW_ID });
    expect(published.ok ? published.data.version : null).toBe(4);
  });

  it('projects.previewFiles applies saved and extra exclusions as user_pattern', async () => {
    const bridge = createFakeBridge('awaiting-approval');
    const res = await bridge.invoke('relay/v1/projects.previewFiles', { projectId: PROJECT, extraExclusions: ['tests/**', '*.md'] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const user = res.data.excluded.filter((e) => e.reason === 'user_pattern').map((e) => e.relPath);
    expect(user.sort()).toEqual(['README.md', 'tests/users.test.ts']);
    expect(res.data.included.some((f) => f.relPath === 'README.md')).toBe(false);
  });

  it('reads the scenario from ?fake= in the search or the hash query', () => {
    expect(fakeScenarioFromUrl({ search: '?fake=interrupted', hash: '' })).toBe('interrupted');
    expect(fakeScenarioFromUrl({ search: '', hash: '#/p/x?fake=empty' })).toBe('empty');
    expect(fakeScenarioFromUrl({ search: '?fake=nope', hash: '' })).toBe('awaiting-approval');
  });

  describe('06 F14 readiness parity (preflight issues, queued pauses)', () => {
    const base = {
      projectId: FAKE_PROJECT_ID,
      workflowId: FAKE_WORKFLOW_ID,
      workflowVersion: 3,
      goal: 'g',
      input: { kind: 'files' as const, relPaths: ['src/a.ts'] },
    };
    const preflight = async (bridge: ReturnType<typeof createFakeBridge>, extra: Record<string, unknown> = {}) => {
      const r = await bridge.invoke('relay/v1/runs.preflight', { ...base, ...extra });
      if (!r.ok) throw new Error(r.error.code);
      return r.data;
    };

    it('lists missing_credential per step whose provider has no key, at profileOverrides.<step>', async () => {
      const pf = await preflight(createFakeBridge('missing-credential'));
      expect(pf.issues).toEqual([
        { path: 'profileOverrides.plan', code: 'missing_credential', message: 'No API key is connected for this provider.' },
        { path: 'profileOverrides.verify', code: 'missing_credential', message: 'No API key is connected for this provider.' },
      ]);
      expect(pf.budget.allowed).toBe(true);
      // An override to a connected provider's profile clears the step's issue.
      const capable = 'prf_00000000000000000000000003';
      const fixed = await preflight(createFakeBridge('missing-credential'), { profileOverrides: { plan: capable, verify: capable } });
      expect(fixed.issues).toEqual([]);
    });

    it('lists provider_not_allowed as an issue (not a PERMISSION_DENIED error); runs.start stays strict', async () => {
      const bridge = createFakeBridge('awaiting-approval');
      const project = bridge.world.projects[0];
      if (project === undefined) throw new Error('no project');
      bridge.world.projects[0] = { ...project, providerPolicy: { ...project.providerPolicy, allowedProviderIds: ['anthropic'] } };
      const pf = await preflight(bridge);
      expect(pf.issues.map((i) => `${i.path}:${i.code}`)).toEqual([
        'profileOverrides.plan:provider_not_allowed',
        'profileOverrides.verify:provider_not_allowed',
      ]);
      const start = await bridge.invoke('relay/v1/runs.start', { ...base, idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZK' });
      expect(start.ok ? null : start.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { reason: 'provider_not_allowed' } });
    });

    it('lists budget_run at limitOverrides.budgetMicrousd when budget.allowed is false', async () => {
      const pf = await preflight(createFakeBridge('budget-blocked'));
      expect(pf.budget.allowed).toBe(false);
      expect(pf.issues).toContainEqual({
        path: 'limitOverrides.budgetMicrousd',
        code: 'budget_run',
        message: 'The run allowance cannot cover the first reservation.',
      });
    });

    it('runs.start accepts a missing credential: the run pauses auth_required with no attempt, then resumes once connected', async () => {
      const bridge = createFakeBridge('missing-credential');
      const res = await bridge.invoke('relay/v1/runs.start', { ...base, idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZJ' });
      if (!res.ok) throw new Error(res.error.code);
      expect(res.data.status).toBe('paused');
      const run = bridge.world.runs.find((r) => r.id === res.data.runId);
      expect(run).toMatchObject({ status: 'paused', pauseReason: 'auth_required', startedAt: null });
      expect(run?.statusDetail).toMatchObject({ code: 'AUTH_REQUIRED', details: { providerId: 'openai', stepKey: 'plan' } });
      expect(run?.availableActions).toEqual(['reconnect_provider', 'resume', 'stop']);
      expect(run?.steps.every((s) => s.state === 'pending')).toBe(true);
      for (const s of run?.steps ?? []) expect(bridge.world.steps.get(s.id)?.attempts).toEqual([]);
      const early = await bridge.invoke('relay/v1/runs.resume', { runId: res.data.runId, idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZH', decision: { kind: 'continue' } });
      expect(early.ok ? null : early.error.code).toBe('AUTH_REQUIRED');
      await bridge.invoke('relay/v1/providers.connect', { providerId: 'openai', apiKey: 'sk-test-0000000000000000', storage: 'session' });
      const resumed = await bridge.invoke('relay/v1/runs.resume', { runId: res.data.runId, idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZG', decision: { kind: 'continue' } });
      expect(resumed.ok ? resumed.data.status : null).toBe('running');
      expect(bridge.world.runs.find((r) => r.id === res.data.runId)?.startedAt).not.toBeNull();
    });

    it('queued pause scenarios have no attempts and no start time', () => {
      for (const s of ['queued-auth-required', 'queued-setup-blocked', 'queued-budget'] as const) {
        const bridge = createFakeBridge(s);
        const run = bridge.world.runs[0];
        expect(run?.status, s).toBe('paused');
        expect(run?.startedAt, s).toBeNull();
        for (const step of run?.steps ?? []) expect(bridge.world.steps.get(step.id)?.attempts, s).toEqual([]);
      }
    });

    it('paused(unknown_outcome) with every unknown decided and no failed step offers resume', () => {
      const run = createFakeBridge('unknown-outcome-decided').world.runs[0];
      expect(run?.availableActions).toEqual(['resume', 'stop']);
    });
  });

  it('memory.purgeProjectHistory reports purged and failed files (03 C8)', async () => {
    const bridge = createFakeBridge('completed');
    const ok = await bridge.invoke('relay/v1/memory.purgeProjectHistory', { projectId: PROJECT, confirmPhrase: 'purge' });
    expect(ok.ok ? ok.data : null).toMatchObject({ failed: 0 });
    bridge.world.purgeFailures = 2;
    const partial = await bridge.invoke('relay/v1/memory.purgeProjectHistory', { projectId: PROJECT, confirmPhrase: 'purge' });
    expect(partial.ok ? partial.data.failed : null).toBe(2);
    expect(partial.ok ? partial.data.purgedArtifacts : null).toBeGreaterThan(0);
  });

  it('runs.preflight memory: absent = every approved record, [] = pinned only, a list = pinned + those', async () => {
    const bridge = createFakeBridge('awaiting-approval');
    const approved = bridge.world.memory.filter((m) => m.status === 'approved');
    const pinned = approved.filter((m) => m.pinned).map((m) => m.id);
    const other = approved.find((m) => !m.pinned)!;
    const base = {
      projectId: FAKE_PROJECT_ID,
      workflowId: FAKE_WORKFLOW_ID,
      workflowVersion: 3,
      goal: 'g',
      input: { kind: 'files' as const, relPaths: ['src/a.ts'] },
    };
    const ids = async (memoryRecordIds?: string[]) => {
      const r = await bridge.invoke('relay/v1/runs.preflight', { ...base, ...(memoryRecordIds === undefined ? {} : { memoryRecordIds }) });
      if (!r.ok) throw new Error(r.error.code);
      return (r.data as { inputSummary: { memoryRecords: { id: string }[] } }).inputSummary.memoryRecords.map((m) => m.id).sort();
    };
    expect(await ids()).toEqual(approved.map((m) => m.id).sort());
    expect(await ids([])).toEqual([...pinned].sort());
    expect(await ids([other.id])).toEqual([...pinned, other.id].sort());
  });
});
