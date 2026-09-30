// Fake scenarios (10 J3): one per mock state, selected with `?fake=<name>` in `pnpm dev:renderer`.
import { appError } from '@relay/contracts';
import type { PauseReason, RunStatus } from '@relay/contracts';
import { buildWorld, DAY, HOUR, MINUTE } from './world';
import type { FakeWorld, RunSpec, StepKeyName, WorldOptions } from './world';

export const FAKE_SCENARIOS = [
  'empty',
  'awaiting-approval',
  'active-run',
  'running-streaming',
  'interrupted',
  'provider-disconnected',
  'budget-blocked',
  'budget-paused',
  'budget-paused-project',
  'budget-overrun',
  'unknown-outcome',
  'schema-invalid',
  'output-invalid',
  'provider-unavailable',
  'setup-blocked',
  'refused',
  'rate-limited',
  'paused-user',
  'paused-limit',
  'paused-deadline',
  'auth-failed',
  'approval-stale',
  'cancelling',
  'failed',
  'cancelled',
  'completed',
  'incomplete',
  'incomplete-report',
  'memory-conflict',
  'no-secure-storage',
  'first-launch',
  'backend-stubs',
  'validation-errors',
] as const;
export type FakeScenarioName = (typeof FAKE_SCENARIOS)[number];

export const DEFAULT_FAKE_SCENARIO: FakeScenarioName = 'awaiting-approval';

export function isFakeScenarioName(value: unknown): value is FakeScenarioName {
  return typeof value === 'string' && (FAKE_SCENARIOS as readonly string[]).includes(value);
}

// History shared by every non-empty scenario (older than the scenario's focus run).
const HISTORY: readonly RunSpec[] = [
  {
    n: 23,
    goal: 'Explain module boundaries',
    status: 'completed',
    agoMs: DAY,
    durationMs: 6 * MINUTE + 40_000,
    steps: { intake: 'succeeded', review: 'succeeded', plan: 'succeeded', approve: 'succeeded', implement: 'succeeded', verify: 'succeeded' },
    cost: { reported: 310_000 },
  },
  {
    n: 22,
    goal: 'Check error handling',
    status: 'cancelled',
    agoMs: 3 * DAY,
    durationMs: 2 * MINUTE + 10_000,
    steps: { intake: 'succeeded', review: 'succeeded', plan: 'succeeded', approve: 'skipped' },
    cost: { reported: 120_000, estimated: 70_000 },
  },
];

/** Runner channels still stubbed in the M1 build (engine services.ts `todo(...)`), used by `backend-stubs`. */
export const BACKEND_STUBS: readonly string[] = [
  'providers.test',
  'profiles.upsert',
  'profiles.delete',
  'projects.update',
  'artifacts.importDiff',
  'memory.list',
  'memory.get',
  'memory.create',
  'memory.update',
];

/** Preflight problems of the new-run `validation-errors` state (paths point at form fields). */
const PREFLIGHT_ISSUES = [
  { path: 'profileOverrides.plan', message: 'Planner: no working credential for OpenAI.', code: 'AUTH_REQUIRED' },
  { path: 'profileOverrides.implement', message: 'Implementer: max output exceeds the model limit.', code: 'MODEL_UNSUPPORTED' },
  { path: 'input', message: 'The selected context is too large for the Reviewer profile.', code: 'CONTEXT_TOO_LARGE' },
];

const DONE_TO_APPROVAL = { intake: 'succeeded', review: 'succeeded', plan: 'succeeded' } as const;
const DONE_TO_IMPLEMENT = { ...DONE_TO_APPROVAL, approve: 'succeeded' } as const;
const ALL_DONE = { ...DONE_TO_IMPLEMENT, implement: 'succeeded', verify: 'succeeded' } as const;

function focus(
  status: RunStatus,
  pauseReason: PauseReason | null,
  extra: Partial<RunSpec> = {},
): RunSpec {
  return {
    n: 24,
    goal: 'Review input validation',
    status,
    pauseReason,
    agoMs: 2 * HOUR,
    durationMs: 4 * MINUTE + 30_000,
    steps: DONE_TO_IMPLEMENT,
    cost: { reported: 480_000 },
    ...extra,
  };
}

function failedStep(step: StepKeyName, code: Parameters<typeof appError>[0], details?: Record<string, unknown>) {
  return { step, error: appError(code, details === undefined ? {} : { details }) };
}

function pausedAtImplement(reason: PauseReason, code: Parameters<typeof appError>[0], details?: Record<string, unknown>) {
  const err = appError(code, details === undefined ? {} : { details });
  return focus('paused', reason, {
    steps: { ...DONE_TO_IMPLEMENT, implement: 'failed' },
    stepError: { step: 'implement', error: err },
    statusDetail: err,
  });
}

function options(name: FakeScenarioName): Omit<WorldOptions, 'now' | 'scenario'> {
  const withFocus = (run: RunSpec, extra: Partial<WorldOptions> = {}) => ({ runs: [run, ...HISTORY], memory: 'full' as const, ...extra });
  switch (name) {
    case 'empty':
      return { runs: [], memory: 'setup-only' };
    case 'awaiting-approval':
      return withFocus(focus('awaiting_approval', null, { steps: { ...DONE_TO_APPROVAL, approve: 'awaiting_approval' } }));
    case 'memory-conflict':
      return withFocus(focus('awaiting_approval', null, { steps: { ...DONE_TO_APPROVAL, approve: 'awaiting_approval' } }), {
        memoryConflict: true,
      });
    case 'provider-disconnected':
      return withFocus(focus('awaiting_approval', null, { steps: { ...DONE_TO_APPROVAL, approve: 'awaiting_approval' } }), {
        authFailed: ['openai'],
      });
    case 'active-run':
    case 'running-streaming':
      return withFocus(
        focus('running', null, {
          n: 25,
          goal: 'Tighten pagination limits',
          agoMs: 20 * MINUTE,
          steps: { intake: 'succeeded', review: 'executing' },
          cost: { reported: 210_000, reserved: 360_000 },
          streaming: true,
        }),
      );
    case 'schema-invalid':
      return withFocus(
        focus('running', null, {
          steps: { ...DONE_TO_IMPLEMENT, implement: 'validating' },
          stepError: failedStep('implement', 'OUTPUT_INVALID', {
            issues: [{ path: 'files[0].unifiedDiff', message: 'must be a unified diff' }],
          }),
          cost: { reported: 480_000, reserved: 540_000 },
        }),
      );
    case 'interrupted':
      return withFocus(
        focus('interrupted', null, {
          steps: { ...DONE_TO_IMPLEMENT, implement: 'unknown' },
          unknownAttempt: { step: 'implement', liability: 620_000 },
          cost: { reported: 480_000, unknown: 620_000 },
        }),
      );
    case 'unknown-outcome':
      return withFocus(
        focus('paused', 'unknown_outcome', {
          steps: { ...DONE_TO_IMPLEMENT, implement: 'unknown' },
          unknownAttempt: { step: 'implement', liability: 620_000 },
          cost: { reported: 480_000, unknown: 620_000 },
          statusDetail: appError('REQUEST_OUTCOME_UNKNOWN'),
        }),
      );
    case 'budget-blocked':
      return { runs: [...HISTORY], memory: 'full', preflightBlocked: true };
    case 'budget-paused':
      return withFocus(
        focus('paused', 'budget_run', {
          n: 24,
          goal: 'Check error handling',
          cost: { reported: 2_620_000 },
          statusDetail: appError('BUDGET_BLOCKED', {
            details: { L: 3_000_000, C: 2_620_000, R: 0, U: 0, N: 540_000, scope: 'run', total: 3_160_000, allowed: false },
          }),
        }),
      );
    case 'budget-paused-project':
      return withFocus(
        focus('paused', 'budget_project', {
          statusDetail: appError('BUDGET_BLOCKED', {
            details: { L: 20_000_000, C: 19_700_000, R: 0, U: 0, N: 540_000, scope: 'project', total: 20_240_000, allowed: false },
          }),
        }),
      );
    case 'budget-overrun':
      return withFocus(
        focus('paused', 'budget_overrun', {
          steps: { ...DONE_TO_IMPLEMENT, implement: 'succeeded' },
          cost: { reported: 3_120_000 },
        }),
      );
    case 'output-invalid':
      return withFocus(
        pausedAtImplement('output_invalid', 'OUTPUT_INVALID', {
          issues: [{ path: 'files[0].unifiedDiff', message: 'must be a unified diff' }],
        }),
      );
    case 'provider-unavailable':
      return withFocus(pausedAtImplement('provider_unavailable', 'PROVIDER_UNAVAILABLE', { providerId: 'anthropic' }));
    case 'refused':
      return withFocus(pausedAtImplement('model_refused', 'MODEL_REFUSED', { providerId: 'anthropic' }));
    case 'setup-blocked':
      return withFocus(
        focus('paused', 'setup_blocked', {
          statusDetail: appError('MODEL_UNSUPPORTED', {
            details: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5', reason: 'model no longer supported' },
          }),
        }),
      );
    case 'rate-limited':
      return withFocus(focus('paused', 'rate_limited', { statusDetail: appError('RATE_LIMITED', { details: { retryAfterMs: null } }) }));
    case 'paused-user':
      return withFocus(focus('paused', 'user'));
    case 'paused-limit':
      return withFocus(
        focus('paused', 'limit_attempts', {
          limits: { maxAttempts: 10 },
          statusDetail: appError('LIMIT_REACHED', { details: { limit: 'attempts' } }),
        }),
      );
    case 'paused-deadline':
      return withFocus(
        focus('paused', 'deadline', { statusDetail: appError('LIMIT_REACHED', { details: { limit: 'deadline' } }) }),
      );
    case 'auth-failed':
      return withFocus(
        focus('paused', 'auth_required', {
          steps: { ...DONE_TO_APPROVAL },
          statusDetail: appError('AUTH_REQUIRED', { details: { providerId: 'openai' } }),
        }),
        { authFailed: ['openai'] },
      );
    case 'approval-stale':
      return withFocus(
        focus('paused', 'approval_stale', {
          steps: { ...DONE_TO_APPROVAL, approve: 'succeeded' },
          statusDetail: appError('PROJECT_CHANGED', {
            details: { changedPaths: ['src/routes/users.ts'], before: 'a1'.repeat(32), after: 'b2'.repeat(32) },
          }),
        }),
      );
    case 'cancelling':
      return withFocus(focus('cancelling', null, { steps: { ...DONE_TO_IMPLEMENT, implement: 'executing' }, cost: { reported: 480_000, reserved: 540_000 } }));
    case 'failed':
      return withFocus(
        focus('failed', null, {
          steps: { intake: 'succeeded', review: 'failed' },
          statusDetail: appError('INTERNAL'),
          cost: { estimated: 60_000 },
        }),
      );
    case 'cancelled':
      return withFocus(focus('cancelled', null, { steps: { ...DONE_TO_APPROVAL, approve: 'skipped' } }));
    case 'completed':
      return withFocus(focus('completed', null, { steps: ALL_DONE, cost: { reported: 930_000 } }));
    case 'incomplete':
    case 'incomplete-report':
      return withFocus(focus('incomplete', null, { steps: ALL_DONE, revisionCycle: 2, cost: { reported: 1_370_000 } }));
    case 'no-secure-storage':
      return withFocus(focus('completed', null, { steps: ALL_DONE, cost: { reported: 930_000 } }), { secureStorage: false });
    case 'first-launch':
      return { runs: [], memory: 'setup-only', fresh: true };
    case 'backend-stubs':
      // A fresh install against the M1 runner: these channels still answer INTERNAL `not_implemented`.
      return { runs: [], memory: 'setup-only', fresh: true, notImplemented: BACKEND_STUBS };
    case 'validation-errors':
      return { runs: [...HISTORY], memory: 'full', preflightIssues: PREFLIGHT_ISSUES };
  }
}

/** Builds the in-memory world of a scenario. */
export function buildScenario(name: FakeScenarioName, now: number): FakeWorld {
  return buildWorld({ now, scenario: name, ...options(name) });
}
