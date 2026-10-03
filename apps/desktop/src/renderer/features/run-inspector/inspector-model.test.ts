import { describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../api/fake-bridge';
import type { FakeScenarioName } from '../../api/fake-bridge';
import { appError, runEventSchema, stepMetaSchema, stepViewSchema } from '@relay/contracts';
import type { RunEvent, StepView } from '@relay/contracts';
import { sid } from '../../api/fake-scenarios/world';
import {
  attemptSeqsOf,
  instructionVersionOf,
  stepTitle,
  bannerActions,
  defaultStep,
  incompleteCauseOf,
  incompleteTitle,
  inspectorStateName,
  latestRowOf,
  overrunStep,
  pauseBlockedStep,
  signInResumeBlockedReason,
  stepEventsOf,
  stepPresentation,
} from './inspector-model';

/** Every run-inspector mock state (plans/mocks/run-inspector.html) and the `?fake=` scenario that reaches it. */
const MOCK_STATES: ReadonlyArray<readonly [string, FakeScenarioName]> = [
  ['awaiting-approval', 'awaiting-approval'],
  ['running-streaming', 'running-streaming'],
  ['budget-paused', 'budget-paused'],
  ['budget-paused', 'budget-paused-project'],
  ['unknown-outcome', 'unknown-outcome'],
  ['schema-invalid', 'schema-invalid'],
  ['auth-failed', 'auth-failed'],
  ['cancelling', 'cancelling'],
  ['approval-stale', 'approval-stale'],
  ['completed', 'completed'],
  ['incomplete', 'incomplete'],
  ['interrupted', 'interrupted'],
  ['paused-user', 'paused-user'],
  ['paused-limit', 'paused-limit'],
  ['paused-limit', 'paused-deadline'],
  ['rate-limited', 'rate-limited'],
  ['refused', 'refused'],
  ['output-invalid', 'output-invalid'],
  ['provider-unavailable', 'provider-unavailable'],
  ['provider-unavailable', 'setup-blocked'],
  ['budget-overrun', 'budget-overrun'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
];

describe('inspector model', () => {
  it.each(MOCK_STATES)('mock state %s is reachable with ?fake=%s', (state, scenario) => {
    const run = createFakeBridge(scenario).world.runs[0];
    if (run === undefined) throw new Error('no run');
    expect(inspectorStateName(run, defaultStep(run))).toBe(state);
  });

  it('the default step is the exact pending approval step (§5.2)', () => {
    const run = createFakeBridge('awaiting-approval').world.runs[0];
    expect(defaultStep(run as never)?.state).toBe('awaiting_approval');
  });

  it('a finished run opens on its last step with an output, never the decided approval gate (J8)', () => {
    const run = createFakeBridge('completed').world.runs[0];
    if (run === undefined) throw new Error('no run');
    const step = defaultStep(run);
    expect(step?.stepKey).not.toBe('approve');
    expect(step?.outputArtifactId).not.toBeNull();
    expect(step?.id).toBe([...run.steps].reverse().find((s) => s.outputArtifactId !== null)?.id);

    // Without a stored Finalize output, the last model step with output is shown instead.
    const lastWithOutput = [...run.steps].reverse().find((s) => s.outputArtifactId !== null);
    const stripped = {
      ...run,
      steps: run.steps.map((s) => (s.id === lastWithOutput?.id ? { ...s, outputArtifactId: null } : s)),
    };
    const fallback = defaultStep(stripped);
    expect(fallback?.outputArtifactId).not.toBeNull();
    expect(fallback?.stepKey).not.toBe('approve');
  });

  it('banner actions never include header or approval actions', () => {
    for (const scenario of ['awaiting-approval', 'running-streaming', 'completed', 'paused-user'] as const) {
      const run = createFakeBridge(scenario).world.runs[0];
      if (run === undefined) throw new Error('no run');
      for (const a of bannerActions(run)) {
        expect(['pause', 'cancel', 'export_report', 'export_patch', 'approve', 'request_revision', 'reject']).not.toContain(a);
      }
    }
  });
});

describe('stepEventsOf (B2)', () => {
  const row = (n: number, retryIndex: number): StepView => stepViewSchema.parse({
    id: sid('stepRun', n),
    stepKey: 'implement',
    revisionIndex: 0,
    retryIndex,
    state: 'failed',
    profileName: 'Capable',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    outcome: null,
    outputArtifactId: null,
    error: null,
  });
  const ev = (seq: number, payload: Record<string, unknown>): RunEvent =>
    runEventSchema.parse({ id: sid('event', seq), runId: sid('run', 1), seq, type: 'step.state_changed', at: seq, payload });
  const a = row(1, 0);
  const b = row(2, 1);
  const events = [
    ev(1, { stepKey: 'implement', stepRunId: a.id }),
    ev(2, { stepKey: 'implement', stepRunId: b.id }),
    ev(3, { stepKey: 'implement', stepRunIds: [a.id, b.id] }),
    ev(4, { stepKey: 'implement' }),
    ev(5, { stepKey: 'verify' }),
  ];

  it('matches rows by stepRunId / stepRunIds only; step-key-only events are run-level, never mixed', () => {
    expect(stepEventsOf([events], a).events.map((e) => e.seq)).toEqual([1, 3]);
    expect(stepEventsOf([events], b).events.map((e) => e.seq)).toEqual([2, 3]);
    expect(stepEventsOf([events], a).runLevel.map((e) => e.seq)).toEqual([4]);
  });

  it('merges sources without duplicates, oldest first', () => {
    expect(stepEventsOf([[events[2] as RunEvent], events], a).events.map((e) => e.seq)).toEqual([1, 3]);
  });

  it('latestRowOf picks the highest (revision, retry) row', () => {
    expect(latestRowOf([b, a], 'implement')?.id).toBe(b.id);
    expect(latestRowOf([a, stepViewSchema.parse({ ...row(3, 0), revisionIndex: 1 }), b], 'implement')?.id).toBe(sid('stepRun', 3));
  });
});

describe('incomplete cause (B4)', () => {
  const base = { revisionCycle: 2, limits: createFakeBridge('incomplete').world.runs[0]!.limits };
  it('maps the cause to the copy, and never claims a revision limit without the engine saying so', () => {
    const withDetails = (details: Record<string, unknown> | undefined) => ({ ...base, statusDetail: details === undefined ? null : { ...appError('LIMIT_REACHED'), details } });
    expect(incompleteTitle(withDetails({ incompleteCause: 'revision_limit', revisionCycle: 1, maxRevisionCycles: 3 }))).toBe('Revision limit reached (1 of 3)');
    expect(incompleteTitle(withDetails({ incompleteCause: 'revision_limit' }))).toBe('Revision limit reached (2 of 2)');
    expect(incompleteTitle(withDetails({ incompleteCause: 'verifier_incomplete' }))).toBe('The workflow reviewer marked the result incomplete');
    expect(incompleteTitle(withDetails({ incompleteCause: 'something_else' }))).toBe('Incomplete');
    expect(incompleteTitle(withDetails(undefined))).toBe('Incomplete');
  });

  it('accepts a top-level statusDetail.incompleteCause too', () => {
    const detail = { ...appError('LIMIT_REACHED'), incompleteCause: 'verifier_incomplete' };
    expect(incompleteCauseOf({ statusDetail: detail })).toBe('verifier_incomplete');
  });
});


describe('paused step (audit #14, #19)', () => {
  it('the step a budget pause holds back reads "Blocked: run budget", never "Ready" / "Not started"', () => {
    const run = createFakeBridge('budget-paused').world.runs[0];
    if (run === undefined) throw new Error('no run');
    const blocked = pauseBlockedStep(run);
    expect(blocked).toBeDefined();
    if (blocked === undefined) return;
    expect(stepPresentation(run, blocked).label).toBe('Blocked: run budget');
    expect(defaultStep(run)?.id).toBe(blocked.id);
    const other = run.steps.find((s) => s.id !== blocked.id && s.state === 'pending');
    if (other !== undefined) expect(stepPresentation(run, other).label).toBe('Not started');
  });

  it('a cost overrun selects the step whose request overran (the latest ledger.overrun)', () => {
    const bridge = createFakeBridge('budget-overrun');
    const run = bridge.world.runs[0];
    if (run === undefined) throw new Error('no run');
    const events = bridge.world.events.get(run.id) ?? [];
    const overran = overrunStep(run, events);
    expect(overran?.stepKey).toBe('implement');
    expect(defaultStep(run, events)?.id).toBe(overran?.id);
  });

  it('a user pause blocks no step', () => {
    const run = createFakeBridge('paused-user').world.runs[0];
    if (run === undefined) throw new Error('no run');
    expect(pauseBlockedStep(run)).toBeUndefined();
  });
});

describe('attemptSeqsOf (audit #8)', () => {
  const ev = (seq: number, payload: Record<string, unknown>): RunEvent =>
    runEventSchema.parse({ id: sid('event', 70_000 + seq), runId: sid('run', 1), seq, type: 'attempt.created', at: seq, payload });
  it('numbers attempts per step row: the payload seq when present, else creation order', () => {
    const seqs = attemptSeqsOf([
      ev(1, { attemptId: 'a1', stepRunId: 'r1' }),
      ev(2, { attemptId: 'a2', stepRunId: 'r1' }),
      ev(3, { attemptId: 'b1', stepRunId: 'r2', seq: 7 }),
    ]);
    expect([seqs.get('a1'), seqs.get('a2'), seqs.get('b1')]).toEqual([1, 2, 7]);
  });
});

describe('signInResumeBlockedReason (audit #12)', () => {
  it('blocks Resume of a queued sign-in pause until the provider has a key', () => {
    const bridge = createFakeBridge('queued-auth-required');
    const run = bridge.world.runs[0];
    if (run === undefined) throw new Error('no run');
    const providers = bridge.world.providers;
    expect(signInResumeBlockedReason(run, providers, [])).toMatch(/^connect OpenAI in Settings → Providers first/);
    const connected = providers.map((p) => (p.providerId === 'openai' ? { ...p, connected: true } : p));
    expect(signInResumeBlockedReason(run, connected, [])).toBeNull();
  });
});

describe('E1 step meta and finished-run decisions', () => {
  const meta = stepMetaSchema.array().parse([
    { stepKey: 'review', name: 'Code review', instructionVersion: 'reviewer.v2' },
    { stepKey: 'approve', name: null, instructionVersion: null },
  ]);

  it('stepTitle uses the display name, else the key label', () => {
    expect(stepTitle({ stepKey: 'review' }, meta)).toBe('Code review');
    expect(stepTitle({ stepKey: 'approve' }, meta)).toBe('Approve plan');
    expect(stepTitle({ stepKey: 'review' })).toBe('Review input');
  });

  it('instructionVersionOf reads stepMeta (null when absent)', () => {
    expect(instructionVersionOf({ stepMeta: meta }, 'review')).toBe('reviewer.v2');
    expect(instructionVersionOf({ stepMeta: meta }, 'approve')).toBeNull();
    expect(instructionVersionOf({}, 'review')).toBeNull();
  });

});
