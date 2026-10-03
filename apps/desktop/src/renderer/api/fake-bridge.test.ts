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
      const invalid = { definitelyNot: 'valid', projectId: 42 };
      const res = await bridge.invoke(op.channel, invalid as never);
      // Channels with an empty input schema accept unknown keys (zod strips them); every other one must reject.
      if (res.ok) {
        expect(op.input.safeParse({}).success, `${op.channel} accepted invalid input`).toBe(true);
      } else if (!op.input.safeParse(invalid).success) {
        expect(res.error.code, op.channel).toBe('VALIDATION_FAILED');
      }
    }
  });

  it.each(FAKE_SCENARIOS)('scenario %s serves schema-valid query outputs', async (scenario) => {
    const bridge = createFakeBridge(scenario);
    // Recovery scenarios: the runner is down / the database is busy; check the outputs of the world behind them.
    bridge.world.runnerState = 'ready';
    bridge.world.busyFailures = 0;
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
          uncertainAttempts: run.uncertainAttempts.length,
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
    const bridge = createFakeBridge('awaiting-approval');
    const pushes: string[] = [];
    bridge.subscribe((e) => pushes.push(e.type));
    const run = bridge.world.runs.find((r) => r.status === 'awaiting_approval');
    const before = bridge.world.events.get(run?.id ?? '')?.at(-1)?.seq ?? 0;
    const res = await bridge.invoke('relay/v1/runs.pause', { runId: run?.id ?? '' });
    expect(res).toEqual({ ok: true, data: { status: 'paused', inFlight: 'none' } });
    expect(pushes).toEqual(['run.event', 'run.status']);
    expect(bridge.world.events.get(run?.id ?? '')?.at(-1)?.seq).toBe(before + 1);
  });

  describe('decision 2: pause and export while running', () => {
    it('a pause during an in-flight request takes effect after it; resume continues where it stopped', async () => {
      const bridge = createFakeBridge('active-run');
      const run = bridge.world.runs[0];
      const runId = run?.id ?? '';
      expect(run?.availableActions).toContain('pause');
      const res = await bridge.invoke('relay/v1/runs.pause', { runId });
      expect(res).toEqual({ ok: true, data: { status: 'running', inFlight: 'waiting' } });
      expect(bridge.world.runs.find((r) => r.id === runId)?.status).toBe('running');
      bridge.finishInFlight(runId);
      expect(bridge.world.runs.find((r) => r.id === runId)).toMatchObject({ status: 'paused', pauseReason: 'user' });
      expect(bridge.world.runs.find((r) => r.id === runId)?.availableActions).toEqual(['resume', 'stop', 'export_report']);
      const resumed = await bridge.invoke('relay/v1/runs.resume', { runId, idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZR', decision: { kind: 'continue' } });
      expect(resumed.ok ? resumed.data.status : null).toBe('running');
    });

    it('a pause while awaiting approval resumes back to the approval', async () => {
      const bridge = createFakeBridge('awaiting-approval');
      const runId = bridge.world.runs.find((r) => r.status === 'awaiting_approval')?.id ?? '';
      await bridge.invoke('relay/v1/runs.pause', { runId });
      const resumed = await bridge.invoke('relay/v1/runs.resume', { runId, idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZS', decision: { kind: 'continue' } });
      expect(resumed.ok ? resumed.data.status : null).toBe('awaiting_approval');
    });

    it('U-1: a run paused while awaiting approval keeps its pending approval (like the engine); resume returns to it, decidable', async () => {
      const bridge = createFakeBridge('awaiting-approval');
      const run = bridge.world.runs.find((r) => r.status === 'awaiting_approval');
      const runId = run?.id ?? '';
      const approval = run?.pendingApproval;
      expect(approval).not.toBeNull();
      await bridge.invoke('relay/v1/runs.pause', { runId });
      const paused = await bridge.invoke('relay/v1/runs.get', { runId });
      expect(paused.ok && [paused.data.status, paused.data.pendingApproval?.id]).toEqual(['paused', approval?.id]);
      await bridge.invoke('relay/v1/runs.resume', { runId, idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZT', decision: { kind: 'continue' } });
      const back = await bridge.invoke('relay/v1/runs.get', { runId });
      expect(back.ok && [back.data.status, back.data.pendingApproval?.id]).toEqual(['awaiting_approval', approval?.id]);
    });

    it('U-3: pauseRequested is true while an in-flight pause is pending and false once it applies', async () => {
      const bridge = createFakeBridge('active-run');
      const runId = bridge.world.runs[0]?.id ?? '';
      expect(bridge.world.runs[0]?.pauseRequested).toBe(false);
      await bridge.invoke('relay/v1/runs.pause', { runId });
      const pending = await bridge.invoke('relay/v1/runs.get', { runId });
      expect(pending.ok && [pending.data.status, pending.data.pauseRequested]).toEqual(['running', true]);
      bridge.finishInFlight(runId);
      const paused = await bridge.invoke('relay/v1/runs.get', { runId });
      expect(paused.ok && [paused.data.status, paused.data.pauseRequested]).toEqual(['paused', false]);
    });

    it('U-4: a pause taken while queued resumes to queued, like the engine (RESUME_RESOLVED → queued)', async () => {
      const bridge = createFakeBridge('active-run');
      const run = bridge.world.runs[0];
      if (run === undefined) throw new Error('no run');
      bridge.world.runs = [{ ...run, status: 'queued', availableActions: allowedRunActions('queued', null, { uncertainAttempts: 0, hasFailedStep: false, hasPatchArtifact: false }) }, ...bridge.world.runs.slice(1)];
      await bridge.invoke('relay/v1/runs.pause', { runId: run.id });
      expect(bridge.world.runs[0]?.status).toBe('paused');
      const resumed = await bridge.invoke('relay/v1/runs.resume', { runId: run.id, idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZU', decision: { kind: 'continue' } });
      expect(resumed.ok ? resumed.data.status : null).toBe('queued');
    });

    it('offers pause in queued, running and awaiting_approval, and export_report in every non-terminal state', () => {
      for (const scenario of FAKE_SCENARIOS) {
        for (const run of createFakeBridge(scenario).world.runs) {
          if (['queued', 'running', 'awaiting_approval'].includes(run.status)) expect(run.availableActions, scenario).toContain('pause');
          expect(run.availableActions, `${scenario} ${run.status}`).toContain('export_report');
        }
      }
    });

    it('exports a run that is still in progress (an interim report)', async () => {
      const bridge = createFakeBridge('awaiting-approval');
      const runId = bridge.world.runs.find((r) => r.status === 'awaiting_approval')?.id ?? '';
      const res = await bridge.invoke('relay/v1/artifacts.export', { runId, what: 'report' });
      expect(res.ok ? res.data.exported : null).toBe(true);
    });
  });

  describe('decision 1: uncertain requests are settled as estimates', () => {
    it('unknown-outcome: the attempt is an estimated charge that may not have been charged; Retry step and Stop only', () => {
      const run = createFakeBridge('unknown-outcome').world.runs[0];
      expect(run?.unresolvedAttempts).toEqual([]);
      expect(run?.uncertainAttempts).toHaveLength(1);
      expect(run?.uncertainAttempts[0]).toMatchObject({ cost: { microusd: 620_000, certainty: 'estimated' }, mayNotHaveBeenCharged: true });
      expect(run?.cost).toMatchObject({ settledEstimated: 620_000, unknown: 0, hasEstimates: true });
      expect(run?.availableActions.filter((a) => a !== 'export_report')).toEqual(['retry_step', 'stop']);
      expect(run?.availableActions).not.toContain('decide_unknown');
    });

    it('no scenario offers decide_unknown, and runs.decideUnknown is refused', async () => {
      for (const scenario of FAKE_SCENARIOS) {
        for (const run of createFakeBridge(scenario).world.runs) expect(run.availableActions, scenario).not.toContain('decide_unknown');
      }
      const bridge = createFakeBridge('unknown-outcome');
      const run = bridge.world.runs[0];
      const res = await bridge.invoke('relay/v1/runs.decideUnknown', {
        runId: run?.id ?? '',
        attemptId: run?.uncertainAttempts[0]?.id ?? '',
        decision: 'accept_estimated_charge',
        idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZT',
      });
      expect(res.ok ? null : res.error.code).toBe('CONFLICT');
    });
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

  describe('U-4: output-limit errors match the engine (runs.preflight and runs.start)', () => {
    const base = (outputTokenOverrides: Record<string, number>) => ({
      projectId: FAKE_PROJECT_ID, workflowId: FAKE_WORKFLOW_ID, workflowVersion: 3, goal: 'Fix validation',
      input: { kind: 'files' as const, relPaths: ['src/a.ts'] }, outputTokenOverrides,
    });
    const expectBoth = async (overrides: Record<string, number>, code: string, path: string) => {
      const bridge = createFakeBridge('awaiting-approval');
      const pre = await bridge.invoke('relay/v1/runs.preflight', base(overrides));
      const start = await bridge.invoke('relay/v1/runs.start', { ...base(overrides), idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZV' });
      for (const res of [pre, start]) {
        expect(res.ok ? null : [res.error.code, res.error.details?.['issues']]).toEqual(['VALIDATION_FAILED', [expect.objectContaining({ path, code })]]);
      }
    };
    it('an override above the step model maximum → VALIDATION_FAILED above_model_max', async () => {
      const limits = await createFakeBridge('awaiting-approval').invoke('relay/v1/runs.preflight', base({}));
      if (!limits.ok) throw new Error(limits.error.code);
      const capped = limits.data.stepLimits.find((l) => l.modelMaxOutputTokens < 128_000);
      if (capped === undefined) throw new Error('no capped step');
      await expectBoth({ [capped.stepKey]: capped.modelMaxOutputTokens + 1 }, 'above_model_max', `outputTokenOverrides.${capped.stepKey}`);
    });
    it('an override for a key that is not a model step → VALIDATION_FAILED unknown_step', async () => {
      await expectBoth({ nope: 1_000 }, 'unknown_step', 'outputTokenOverrides.nope');
    });
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

    it('providersReceivingContext follows the chosen profiles, like the engine (run-start.ts)', async () => {
      const bridge = createFakeBridge('awaiting-approval');
      expect((await preflight(bridge)).inputSummary.providersReceivingContext).toEqual(['anthropic', 'openai']);
      // Every step on an Anthropic profile: only Anthropic receives the context.
      const capable = 'prf_00000000000000000000000003';
      const allAnthropic = await preflight(bridge, { profileOverrides: { plan: capable, verify: capable } });
      expect(allAnthropic.inputSummary.providersReceivingContext).toEqual(['anthropic']);
    });

    it('a diff input touching a suspected secret: a preflight issue at `input`, and runs.start is refused (engine fails closed)', async () => {
      const bridge = createFakeBridge('suspected-secret');
      bridge.world.importDiffFiles = ['src/app.ts', 'src/config/keys.ts'];
      const imported = await bridge.invoke('relay/v1/artifacts.importDiff', { projectId: FAKE_PROJECT_ID });
      if (!imported.ok || imported.data === null) throw new Error('import failed');
      const input = { kind: 'diff' as const, diffArtifactId: imported.data.artifactId };
      const pf = await preflight(bridge, { input });
      expect(pf.issues).toContainEqual({ path: 'input', code: 'suspected_secret', message: '"src/config/keys.ts" looks like it contains a secret. Remove it or confirm sending it.' });
      const start = await bridge.invoke('relay/v1/runs.start', { ...base, input, idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZM' });
      expect(start.ok ? null : start.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { reason: 'suspected_secret' } });
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
      expect(run?.availableActions).toEqual(['reconnect_provider', 'resume', 'stop', 'export_report']);
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

  describe('E1/E2 recovery parity (R2)', () => {
    it('runner-unavailable: runner ops fail, the state is pushed, a restart fails again, a restore brings it back', async () => {
      const bridge = createFakeBridge('runner-unavailable');
      const pushed: unknown[] = [];
      bridge.subscribe((e) => pushed.push(e));
      await Promise.resolve();
      expect(pushed).toContainEqual({ type: 'runner.state', state: 'unavailable' });
      const list = await bridge.invoke('relay/v1/runs.list', { projectId: PROJECT });
      expect(!list.ok && list.error.code).toBe('RUNNER_UNAVAILABLE');
      const diag = await bridge.invoke('relay/v1/app.getDiagnostics', {});
      expect(diag.ok && diag.data.runner.lastFatal?.reason).toBe('db_corrupt');
      const restart = await bridge.invoke('relay/v1/app.restartRunner', {});
      expect(!restart.ok && restart.error.details?.['reason']).toBe('db_corrupt');
      const restore = await bridge.invoke('relay/v1/app.restoreLatestBackup', {});
      expect(restore.ok && restore.data.restored).toBe(true);
      expect(pushed).toContainEqual({ type: 'runner.state', state: 'ready' });
      expect((await bridge.invoke('relay/v1/runs.list', { projectId: PROJECT })).ok).toBe(true);
      const again = await bridge.invoke('relay/v1/app.restoreLatestBackup', {});
      expect(!again.ok && again.error.code).toBe('CONFLICT');
    });

    it('runner-crashed: a restart brings the runner back; with no backup a restore reports restored: false', async () => {
      const bridge = createFakeBridge('runner-crashed');
      bridge.world.backupAvailable = false;
      const restore = await bridge.invoke('relay/v1/app.restoreLatestBackup', {});
      expect(restore.ok && restore.data).toMatchObject({ restored: false, runnerState: 'unavailable' });
      const restart = await bridge.invoke('relay/v1/app.restartRunner', {});
      expect(restart.ok && restart.data).toEqual({ restarted: true, state: 'ready' });
    });

    it('database-busy: runner queries fail with retryable database_busy (next action wait), then succeed', async () => {
      const bridge = createFakeBridge('database-busy');
      const first = await bridge.invoke('relay/v1/projects.list', {});
      expect(!first.ok && first.error).toMatchObject({ code: 'DATABASE_UNAVAILABLE', retryable: true, nextAction: 'wait', details: { reason: 'database_busy' } });
      await bridge.invoke('relay/v1/projects.list', {});
      expect((await bridge.invoke('relay/v1/projects.list', {})).ok).toBe(true);
    });

    it('project-root-missing: preview fails until relocate; an unverified folder needs confirm: true', async () => {
      const bridge = createFakeBridge('project-root-missing');
      const preview = await bridge.invoke('relay/v1/projects.previewFiles', { projectId: PROJECT });
      expect(!preview.ok && preview.error.code).toBe('PROJECT_ROOT_MISSING');
      const pick = await bridge.invoke('relay/v1/projects.pickDirectory', {});
      const selectionId = pick.ok ? (pick.data.selection?.selectionId ?? '') : '';
      const first = await bridge.invoke('relay/v1/projects.relocate', { projectId: PROJECT, selectionId });
      expect(!first.ok && first.error.details).toMatchObject({ reason: 'root_unverified', verification: { checkedFiles: 9, matchedFiles: 0 } });
      const confirmed = await bridge.invoke('relay/v1/projects.relocate', { projectId: PROJECT, selectionId, confirm: true });
      expect(confirmed.ok && confirmed.data.project.rootDisplayPath).toBe('~/code/my-api');
      expect((await bridge.invoke('relay/v1/projects.previewFiles', { projectId: PROJECT })).ok).toBe(true);
      const all = await bridge.invoke('relay/v1/projects.list', { includeArchived: true });
      expect(all.ok && all.data.filter((p) => p.archivedAt !== null)).toHaveLength(1);
    });

    it('suspected-secret: preview flags the file; preflight issues and start denial until it is acknowledged', async () => {
      const bridge = createFakeBridge('suspected-secret');
      const preview = await bridge.invoke('relay/v1/projects.previewFiles', { projectId: PROJECT });
      const flagged = preview.ok ? preview.data.included.find((f) => f.suspectedSecret === true) : undefined;
      expect(flagged).toMatchObject({ relPath: 'src/config/keys.ts', secretLabel: 'anthropic_key', secretLine: 4 });
      const base = { projectId: PROJECT, workflowId: FAKE_WORKFLOW_ID, workflowVersion: 3, goal: 'Check keys' } as const;
      const relPaths = ['README.md', 'src/config/keys.ts'];
      const pf = await bridge.invoke('relay/v1/runs.preflight', { ...base, input: { kind: 'files', relPaths } });
      expect(pf.ok && pf.data.issues.filter((i) => i.code === 'suspected_secret')).toEqual([expect.objectContaining({ path: 'input.relPaths.1' })]);
      const start = await bridge.invoke('relay/v1/runs.start', { ...base, idempotencyKey: '01JABCDEFGHJKMNPQRSTVWXYZ0', input: { kind: 'files', relPaths } });
      expect(!start.ok && start.error.details).toMatchObject({ reason: 'suspected_secret', denied: [{ relPath: 'src/config/keys.ts', secretLabel: 'anthropic_key', secretLine: 4 }] });
      const acked = { kind: 'files' as const, relPaths, acknowledgedSuspectedSecrets: [{ relPath: 'src/config/keys.ts', sha256: flagged?.sha256 ?? '' }] };
      const pf2 = await bridge.invoke('relay/v1/runs.preflight', { ...base, input: acked });
      expect(pf2.ok && pf2.data.issues.some((i) => i.code === 'suspected_secret')).toBe(false);
      // Round-3 M4: an acknowledgement of other content (a different hash) is flagged again.
      const stale = { ...acked, acknowledgedSuspectedSecrets: [{ relPath: 'src/config/keys.ts', sha256: 'f'.repeat(64) }] };
      const pf3 = await bridge.invoke('relay/v1/runs.preflight', { ...base, input: stale });
      expect(pf3.ok && pf3.data.issues.filter((i) => i.code === 'suspected_secret')).toEqual([expect.objectContaining({ path: 'input.relPaths.1' })]);
    });

    it('unreadable-file: preview lists unreadable entries; preflight denies a selected unreadable file', async () => {
      const bridge = createFakeBridge('unreadable-file');
      const preview = await bridge.invoke('relay/v1/projects.previewFiles', { projectId: PROJECT });
      expect(preview.ok && preview.data.unreadable).toEqual(['config/local.json']);
      const pf = await bridge.invoke('relay/v1/runs.preflight', {
        projectId: PROJECT, workflowId: FAKE_WORKFLOW_ID, workflowVersion: 3, goal: 'x', input: { kind: 'files', relPaths: ['src/db/client.ts'] },
      });
      expect(!pf.ok && pf.error.details).toMatchObject({ reason: 'unreadable', relPath: 'src/db/client.ts' });
    });

    it('export-partial: per-part results, and a retry of the failed part writes it', async () => {
      const bridge = createFakeBridge('export-partial');
      const runId = bridge.world.runs[0]?.id ?? '';
      const res = await bridge.invoke('relay/v1/artifacts.export', { runId, what: 'both' });
      expect(res.ok && res.data).toMatchObject({ exported: true, written: [{ what: 'report' }], failed: [{ what: 'patch', code: 'ARTIFACT_WRITE_FAILED' }] });
      const retry = await bridge.invoke('relay/v1/artifacts.export', { runId, what: 'patch' });
      expect(retry.ok && retry.data).toMatchObject({ written: [{ what: 'patch', displayPath: '~/Downloads/patch.diff' }], failed: [] });
    });

    it('memory confirmCurrent: clears stale, writes a reviewed event and a refreshed revision, keeps reviewAt', async () => {
      const bridge = createFakeBridge('memory-stale');
      const rec = bridge.world.memory.find((m) => m.stale);
      expect(rec?.reviewDue).toBe(true);
      const res = await bridge.invoke('relay/v1/memory.update', { recordId: rec?.id ?? '', expectedRevision: rec?.currentRevision ?? 1, confirmCurrent: true });
      expect(res.ok && res.data).toMatchObject({ stale: false, reviewDue: false, reviewAt: rec?.reviewAt, currentRevision: (rec?.currentRevision ?? 0) + 1 });
      expect(res.ok && res.data.events.at(-1)).toMatchObject({ event: 'reviewed', detail: { fileRefs: 1, refreshed: 1 } });
    });

    it('run details carry attempts, latestManifest, stepMeta, and profileOptions only while choose_profile is offered', async () => {
      const paused = createFakeBridge('budget-paused').world.runs[0];
      expect(paused?.profileOptions?.length).toBe(3);
      expect(paused?.profileOptions?.every((o) => o.basis === 'step_estimate')).toBe(true);
      const minimum = createFakeBridge('choose-profile-minimum').world.runs[0];
      expect(minimum?.profileOptions?.every((o) => o.basis === 'minimum')).toBe(true);
      const done = createFakeBridge('completed');
      const run = done.world.runs[0];
      expect(run?.profileOptions).toEqual([]);
      expect(run?.stepMeta?.find((m) => m.stepKey === 'review')?.instructionVersion).toBe('reviewer.v1');
      expect(run?.attempts?.length).toBeGreaterThan(0);
      const manifest = await done.invoke('relay/v1/artifacts.get', { artifactId: run?.latestManifest?.artifactId ?? '' });
      expect(manifest.ok && manifest.data.meta.kind).toBe('context_manifest');
    });

    it('workflows.saveDraft renames an edited published prompt to the next instruction version and applies step names', async () => {
      const bridge = createFakeBridge('completed');
      const res = await bridge.invoke('relay/v1/workflows.saveDraft', {
        workflowId: FAKE_WORKFLOW_ID,
        expectedDraftRevision: 0,
        patch: { prompts: { 'reviewer.v1': 'New reviewer text' }, steps: { approve: { name: 'Approve the plan' } } },
      });
      const step = res.ok ? res.data.spec.steps.find((s) => s.id === 'review') : undefined;
      expect(step?.kind === 'model' && step.instructionVersion).toBe('reviewer.v2');
      expect(res.ok && res.data.prompts['reviewer.v2']?.text).toBe('New reviewer text');
      expect(res.ok && res.data.prompts['reviewer.v1']).toBeUndefined();
      expect(res.ok && res.data.spec.steps.find((s) => s.id === 'approve')?.name).toBe('Approve the plan');
    });

    it('providers report where the last test came from', async () => {
      const bridge = createFakeBridge('auth-failed');
      const list = await bridge.invoke('relay/v1/providers.list', {});
      expect(list.ok && list.data.find((p) => p.providerId === 'openai')?.lastTest?.source).toBe('run');
      await bridge.invoke('relay/v1/providers.test', { providerId: 'openai' });
      expect(bridge.world.providers.find((p) => p.providerId === 'openai')?.lastTest?.source).toBe('connection_test');
    });

    it('interrupted vs interrupted-quit: lastShutdown tells a crash from a clean quit during a run', () => {
      expect(createFakeBridge('interrupted').world.info.lastShutdown).toMatchObject({ clean: false, runActive: true });
      expect(createFakeBridge('interrupted-quit').world.info.lastShutdown).toMatchObject({ clean: true, runActive: true });
    });
  });
});
