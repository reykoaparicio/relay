import { describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../api/fake-bridge';
import type { FakeScenarioName } from '../../api/fake-bridge';
import { bannerActions, defaultStep, inspectorStateName } from './inspector-model';

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
