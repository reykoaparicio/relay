import { afterEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { errors, RUN_ACTIONS, runEventSchema } from '@relay/contracts';
import type { RunAction, RunDetail } from '@relay/contracts';
import { createFakeBridge, FAKE_PROJECT_ID } from '../api/fake-bridge';
import type { FakeBridge, FakeScenarioName } from '../api/fake-bridge';
import { RUN_ACTION_LABELS } from '../lib/format';
import { axe, describeViolations } from '../components/ui/test-utils';
import { renderApp } from '../features/testing/render-app';

const P = `/p/${FAKE_PROJECT_ID}`;

function focusRun(bridge: FakeBridge): RunDetail {
  const run = bridge.world.runs[0];
  if (run === undefined) throw new Error('scenario has no run');
  return run;
}

function open(scenario: FakeScenarioName, query = '') {
  const bridge = createFakeBridge(scenario);
  const run = focusRun(bridge);
  const result = renderApp(`${P}/runs/${run.id}${query}`, { bridge });
  return { ...result, run };
}

async function ready() {
  await screen.findByRole('heading', { level: 1, name: 'Run inspection' });
  await screen.findByRole('tablist', { name: 'Step details' });
}

function setWidth(px: number) {
  act(() => {
    window.innerWidth = px;
    window.dispatchEvent(new Event('resize'));
  });
}

afterEach(() => {
  setWidth(1024);
});

/** The control each action renders as (ApprovalCard uses its own labels). */
const CONTROL_NAME: Readonly<Record<RunAction, string>> = {
  ...RUN_ACTION_LABELS,
  approve: 'Approve plan',
  request_revision: 'Request revision',
};

function controls(name: string): HTMLElement[] {
  return [...screen.queryAllByRole('button', { name }), ...screen.queryAllByRole('link', { name })];
}

interface StateCase {
  readonly state: string;
  readonly scenario: FakeScenarioName;
  /** Banner title (null = no banner for this state). */
  readonly banner: RegExp | string | null;
  /** Other text proving the state rendered. */
  readonly proof?: RegExp | string;
}

const STATES: readonly StateCase[] = [
  { state: 'awaiting-approval', scenario: 'awaiting-approval', banner: null, proof: 'Proposed plan' },
  { state: 'running-streaming', scenario: 'running-streaming', banner: null, proof: /Receiving response/ },
  { state: 'budget-paused', scenario: 'budget-paused', banner: /Paused before dispatch: the next request needs \$0\.54, only \$0\.38 remains/ },
  { state: 'budget-paused (project)', scenario: 'budget-paused-project', banner: /Paused before dispatch: the next request needs \$0\.54, only \$0\.30 remains this month/ },
  { state: 'budget-overrun', scenario: 'budget-overrun', banner: /The last call cost \$0\.71, more than the \$0\.62 reserved/ },
  { state: 'unknown-outcome', scenario: 'unknown-outcome', banner: 'The request may have been sent; its charge is unknown', proof: 'Recovery' },
  { state: 'schema-invalid', scenario: 'schema-invalid', banner: null, proof: 'The output did not match patch.v1' },
  { state: 'output-invalid', scenario: 'output-invalid', banner: 'The output did not match patch.v1', proof: /Repair attempts used: 1 of 1/ },
  { state: 'provider-unavailable', scenario: 'provider-unavailable', banner: 'The provider did not respond after a retry' },
  { state: 'provider-unavailable (setup)', scenario: 'setup-blocked', banner: 'A setup check failed before the step could start' },
  { state: 'refused', scenario: 'refused', banner: 'The model declined this step' },
  { state: 'rate-limited', scenario: 'rate-limited', banner: 'Provider rate limit: waits exhausted' },
  { state: 'paused-user', scenario: 'paused-user', banner: 'Paused by you' },
  { state: 'paused-limit (attempts)', scenario: 'paused-limit', banner: 'Attempt limit reached (10 of 10)' },
  { state: 'paused-limit (deadline)', scenario: 'paused-deadline', banner: /^Execution time limit reached \(4m 30s of 15m 0s\)$/ },
  { state: 'auth-failed', scenario: 'auth-failed', banner: 'OpenAI rejected the stored credential' },
  { state: 'approval-stale', scenario: 'approval-stale', banner: 'Project files changed after the plan was proposed', proof: 'The plan that was proposed' },
  { state: 'interrupted', scenario: 'interrupted', banner: 'Relay stopped while this run was in progress', proof: 'Recovery' },
  { state: 'cancelling', scenario: 'cancelling', banner: 'Cancellation requested; waiting for the in-flight request to stop (best effort)' },
  { state: 'cancelled', scenario: 'cancelled', banner: 'Run cancelled', proof: /the possible amount stays as unknown liability/ },
  { state: 'failed', scenario: 'failed', banner: 'Run failed because of an internal error', proof: 'Open diagnostics' },
  { state: 'completed', scenario: 'completed', banner: 'Accepted by the workflow reviewer', proof: /does not guarantee the code is correct/ },
  { state: 'incomplete', scenario: 'incomplete', banner: 'Revision limit reached (2 of 2)' },
];

describe('RunInspectorPage', () => {
  it.each(STATES)('$state: the right banner and only the availableActions controls', async ({ scenario, banner, proof }) => {
    const { run } = open(scenario);
    await ready();
    if (banner === null) {
      expect(screen.queryByTestId('status-banner')).not.toBeInTheDocument();
    } else {
      const el = await screen.findByTestId('status-banner');
      const titles = [...el.querySelectorAll('strong')].map((n) => n.textContent);
      expect(titles.some((t) => (typeof banner === 'string' ? t === banner : banner.test(t))), `titles: ${titles.join(' | ')}`).toBe(true);
    }
    if (proof !== undefined) expect((await screen.findAllByText(proof)).length).toBeGreaterThan(0);
    // Approval controls render once the plan is loaded.
    if (run.availableActions.includes('approve')) await screen.findByRole('button', { name: 'Approve plan' });
    for (const action of RUN_ACTIONS) {
      const found = controls(CONTROL_NAME[action]);
      if (run.availableActions.includes(action)) expect(found.length, `${action} should be shown`).toBeGreaterThan(0);
      else expect(found, `${action} must not be shown`).toHaveLength(0);
    }
  });

  it('approve sends the displayed plan and context hashes', async () => {
    const { bridge, run } = open('awaiting-approval');
    const approval = run.pendingApproval;
    expect(approval).not.toBeNull();
    const card = (await screen.findByRole('heading', { name: 'Proposed plan' })).closest('section') as HTMLElement;
    const shown = within(card).getAllByTitle(/^[0-9a-f]{64}$/).map((el) => el.getAttribute('title'));
    expect(shown).toEqual([approval?.planHash, approval?.contextHash]);
    await userEvent.click(within(card).getByRole('button', { name: 'Approve plan' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/approvals.decide')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/approvals.decide')[0]?.input).toMatchObject({
      approvalId: approval?.id,
      planHash: approval?.planHash,
      contextHash: approval?.contextHash,
      decision: 'approved',
    });
  });

  it('request revision requires a note and sends it', async () => {
    const { bridge } = open('awaiting-approval');
    await userEvent.click(await screen.findByRole('button', { name: 'Request revision' }));
    const send = screen.getByRole('button', { name: 'Send revision request' });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: /What should the planner change/ }), 'Keep the 422 status.');
    expect(send).toBeEnabled();
    await userEvent.click(send);
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/approvals.decide')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/approvals.decide')[0]?.input).toMatchObject({
      decision: 'revision_requested',
      note: 'Keep the 422 status.',
    });
  });

  it('a stale approval shows an inline alert and refetches the run', async () => {
    const { bridge } = open('awaiting-approval');
    const approve = await screen.findByRole('button', { name: 'Approve plan' });
    bridge.failNext('relay/v1/approvals.decide', errors.approvalStale('plan_changed'));
    const before = bridge.callsTo('relay/v1/runs.get').length;
    await userEvent.click(approve);
    expect(await screen.findByText('The plan or files changed since you opened this page')).toBeInTheDocument();
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.get').length).toBeGreaterThan(before);
    });
  });

  it('edit project allowance → projects.update with the monthly allowance', async () => {
    const { bridge } = open('budget-paused-project');
    await ready();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit project allowance' }));
    const input = await screen.findByRole('textbox', { name: /Monthly allowance/ });
    await userEvent.clear(input);
    await userEvent.type(input, '25.00');
    await userEvent.click(screen.getByRole('button', { name: 'Save project allowance' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/projects.update')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/projects.update')[0]?.input).toMatchObject({
      projectId: FAKE_PROJECT_ID,
      patch: { monthlyAllowanceMicrousd: 25_000_000 },
    });
  });

  it('increase allowance → runs.increaseAllowance', async () => {
    const { bridge, run } = open('budget-paused');
    await userEvent.click(await screen.findByRole('button', { name: 'Increase allowance' }));
    const input = await screen.findByRole('textbox', { name: /New run allowance/ });
    await userEvent.clear(input);
    await userEvent.type(input, '2.00');
    await userEvent.click(screen.getByRole('button', { name: 'Save allowance and continue' }));
    expect(await screen.findByText(/Enter more than the current 3\.00 USD/)).toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/runs.increaseAllowance')).toHaveLength(0);
    await userEvent.clear(input);
    await userEvent.type(input, '4.00');
    await userEvent.click(screen.getByRole('button', { name: 'Save allowance and continue' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.increaseAllowance')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/runs.increaseAllowance')[0]?.input).toMatchObject({ runId: run.id, newAllowanceMicrousd: 4_000_000 });
  });

  it('raise limits → runs.resume raise_limits; values above RUN_LIMIT_MAXIMUMS are rejected', async () => {
    const { bridge, run } = open('paused-limit');
    await userEvent.click(await screen.findByRole('button', { name: 'Raise limits' }));
    const attempts = await screen.findByRole('spinbutton', { name: /Max attempts/ });
    expect(describeViolations(await axe(document.body))).toEqual([]);
    await userEvent.type(attempts, '51');
    await userEvent.click(screen.getByRole('button', { name: 'Save limits and resume' }));
    expect(await screen.findByText(/Must be at most 50/)).toBeInTheDocument();
    const minutes = screen.getByRole('spinbutton', { name: /Execution timeout/ });
    await userEvent.type(minutes, '121');
    expect(await screen.findByText(/Must be at most 120/)).toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/runs.resume')).toHaveLength(0);
    await userEvent.clear(attempts);
    await userEvent.type(attempts, '20');
    await userEvent.clear(minutes);
    await userEvent.click(screen.getByRole('button', { name: 'Save limits and resume' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.resume')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/runs.resume')[0]?.input).toMatchObject({
      runId: run.id,
      decision: { kind: 'raise_limits', maxAttempts: 20 },
    });
  });

  it('acknowledge overrun → runs.resume acknowledge_overrun', async () => {
    const { bridge } = open('budget-overrun');
    await userEvent.click(await screen.findByRole('button', { name: 'Acknowledge overrun' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.resume')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/runs.resume')[0]?.input).toMatchObject({ decision: { kind: 'acknowledge_overrun' } });
  });

  it('retry step → runs.retryStep for the failed step', async () => {
    const { bridge, run } = open('output-invalid');
    const failed = run.steps.find((s) => s.state === 'failed');
    await userEvent.click(await screen.findByRole('button', { name: 'Retry step' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.retryStep')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/runs.retryStep')[0]?.input).toMatchObject({ runId: run.id, stepId: failed?.id });
  });

  it('choose profile on a failed step → runs.retryStep with the chosen permitted profile', async () => {
    const { bridge, run } = open('refused');
    await userEvent.click(await screen.findByRole('button', { name: 'Choose another profile' }));
    const select = await screen.findByRole('combobox', { name: 'Profile' });
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options.some((o) => o.startsWith('Capable'))).toBe(false); // the current profile is not offered
    await userEvent.click(screen.getByRole('button', { name: 'Retry step with this profile' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.retryStep')).toHaveLength(1);
    });
    const input = bridge.callsTo('relay/v1/runs.retryStep')[0]?.input as { profileId?: string; stepId: string };
    expect(input.stepId).toBe(run.steps.find((s) => s.state === 'failed')?.id);
    expect(input.profileId).toMatch(/^prf_/);
  });

  it('stop asks for confirmation, then calls runs.cancel', async () => {
    const { bridge, run } = open('paused-user');
    await userEvent.click(await screen.findByRole('button', { name: 'Stop run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop this run?' });
    expect(bridge.callsTo('relay/v1/runs.cancel')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop run' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.cancel')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/runs.cancel')[0]?.input).toEqual({ runId: run.id });
  });

  it('cancel explains best-effort in-flight cancellation (FR-11)', async () => {
    open('running-streaming');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this run?' });
    expect(within(dialog).getByText(/best effort/)).toBeInTheDocument();
    expect(within(dialog).getByText(/charge may stay unknown/)).toBeInTheDocument();
  });

  it('decide unknown → runs.decideUnknown with the chosen decision; the retry label warns about another charge', async () => {
    const { bridge, run } = open('unknown-outcome');
    await userEvent.click(await screen.findByRole('button', { name: 'Decide on unknown charge' }));
    const retry = await screen.findByRole('radio', { name: /Retry \(may incur another charge\)/ });
    expect(describeViolations(await axe(document.body))).toEqual([]);
    await userEvent.click(retry);
    await userEvent.click(screen.getByRole('button', { name: 'Continue with selected option' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.decideUnknown')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/runs.decideUnknown')[0]?.input).toMatchObject({
      runId: run.id,
      attemptId: run.unresolvedAttempts[0]?.id,
      decision: 'retry_acknowledging_charge',
    });
  });

  it('a runner channel that is not implemented yet shows the not-available notice', async () => {
    const bridge = createFakeBridge('paused-user');
    bridge.world.notImplemented.add('runs.resume');
    const run = focusRun(bridge);
    renderApp(`${P}/runs/${run.id}`, { bridge });
    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    expect(await screen.findByText('Not available yet in this build')).toBeInTheDocument();
  });

  it('?tab=ledger shows the run ledger and exports it as CSV via ledger.export({ runId })', async () => {
    const { bridge, run } = open('completed', '?tab=ledger');
    const table = await screen.findByRole('table', { name: /Ledger entries for Run/ });
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Created', 'Step', 'Attempt', 'Type', 'Bucket', 'Delta', 'Certainty', 'Price catalog']);
    expect(within(table).getAllByRole('row').length - 1).toBe(bridge.world.ledger.get(run.id)?.length);
    await userEvent.click(screen.getByRole('button', { name: 'Export ledger (CSV)' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/ledger.export')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/ledger.export')[0]?.input).toEqual({ runId: run.id });
    expect(await screen.findByText(/Ledger exported to/)).toBeInTheDocument();
  });

  it('?step selects the named step; the timeline changes the selection', async () => {
    const bridge = createFakeBridge('completed');
    const run = focusRun(bridge);
    const review = run.steps.find((s) => s.stepKey === 'review');
    renderApp(`${P}/runs/${run.id}?step=${review?.id ?? ''}`, { bridge });
    expect(await screen.findByRole('heading', { level: 2, name: 'Review input' })).toBeInTheDocument();
    expect(await screen.findByText('Create-user payload is not validated')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Plan a fix/ }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Plan a fix' })).toBeInTheDocument();
  });

  it('at 1100 px the Budget and Context summary panels are tabs; at 1440 px they are a bottom row', async () => {
    setWidth(1100);
    open('completed');
    await ready();
    expect(screen.getByRole('tab', { name: 'Budget' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Context summary' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Budget' }));
    expect(await screen.findByText(/tracked usage\. Tracked by Relay/)).toBeInTheDocument();
    setWidth(1440);
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: 'Budget' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('region', { name: 'Budget' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Context summary' })).toBeInTheDocument();
  });

  it('running-streaming: stream progress updates the token count without content, and provider vs app time', async () => {
    const { bridge, run } = open('running-streaming');
    await screen.findByText(/Receiving response/);
    expect(screen.getByText('Provider latency')).toBeInTheDocument();
    expect(screen.getByText('App processing')).toBeInTheDocument();
    expect(await screen.findByTestId('stream-tokens')).toHaveTextContent('1.4k tokens est.');
    expect(screen.getByText('46s')).toBeInTheDocument(); // provider latency
    expect(screen.getByText('400 ms')).toBeInTheDocument(); // app processing
    const last = bridge.world.events.get(run.id)?.at(-1)?.seq ?? 0;
    act(() => {
      bridge.emit({
        type: 'run.event',
        event: runEventSchema.parse({
          id: 'evt_00000000000000000000099999',
          runId: run.id,
          seq: last + 1,
          type: 'attempt.stream_progress',
          at: Date.now(),
          payload: { stepKey: 'review', outputTokensSoFar: 2_950, elapsedMs: 52_000 },
        }),
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('stream-tokens')).toHaveTextContent('3k tokens est.');
    });
  });

  it('schema-invalid: issues, repair attempts, and the redacted raw response on demand', async () => {
    open('schema-invalid');
    expect(await screen.findByText('$.files[0].unifiedDiff')).toBeInTheDocument();
    expect(screen.getByText(/Repair attempts used: 1 of 1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View raw response (redacted)' }));
    expect(await screen.findByText(/"_redacted"/)).toBeInTheDocument();
  });
});
