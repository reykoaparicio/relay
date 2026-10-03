import { afterEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { appError, errors, RUN_ACTIONS, runEventSchema, stepViewSchema } from '@relay/contracts';
import type { RunAction, RunDetail, RunEvent, StepView } from '@relay/contracts';
import { createFakeBridge, FAKE_PROJECT_ID } from '../api/fake-bridge';
import type { FakeBridge, FakeScenarioName } from '../api/fake-bridge';
import { RUN_ACTION_LABELS, UNKNOWN_OUTCOME_DECISION_LABELS } from '../lib/format';
import { axe, describeViolations } from '../components/ui/test-utils';
import { renderApp } from '../features/testing/render-app';
import { sid } from '../api/fake-scenarios/world';

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

/** Action controls named `name`, excluding the step timeline (a step may be titled like an action, e.g. "Approve plan"). */
function controls(name: string): HTMLElement[] {
  return [...screen.queryAllByRole('button', { name }), ...screen.queryAllByRole('link', { name })].filter(
    (el) => el.closest('.timeline') === null,
  );
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
  { state: 'output-invalid', scenario: 'output-invalid', banner: 'Produce patch returned output in the wrong format', proof: /repair attempts used: 1 of 1/ },
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
  // Queued → paused before any attempt (06 F13 runChecks): no step ran, nothing was reserved.
  { state: 'auth-failed (queued)', scenario: 'queued-auth-required', banner: 'No API key is connected for OpenAI', proof: /The run has not started: nothing was sent/ },
  { state: 'provider-unavailable (setup, queued)', scenario: 'queued-setup-blocked', banner: 'A setup check failed before the run started', proof: 'This provider is not allowed for the project.' },
  { state: 'budget-paused (queued)', scenario: 'queued-budget', banner: /^Paused before the first request: the next request needs \$0\.12, only \$0\.10 remains$/, proof: /The run has not started/ },
  { state: 'unknown-outcome (all decided)', scenario: 'unknown-outcome-decided', banner: 'Every request with an unknown outcome has been decided', proof: 'Recovery' },
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
    if (run.availableActions.includes('approve')) await within(await screen.findByRole('region', { name: 'Proposed plan' })).findByRole('button', { name: 'Approve plan' });
    for (const action of RUN_ACTIONS) {
      // With unresolved attempts, the RecoveryPanel offers decide_unknown per attempt (one button per decision).
      // A finished run settles a left-over unknown charge from the banner's single button (no per-attempt rows).
      const finished = ['completed', 'incomplete', 'cancelled', 'failed'].includes(run.status);
      const perAttempt = action === 'decide_unknown' && run.unresolvedAttempts.length > 0 && !finished;
      const found = controls(perAttempt ? UNKNOWN_OUTCOME_DECISION_LABELS.retry_acknowledging_charge : CONTROL_NAME[action]);
      if (run.availableActions.includes(action)) expect(found.length, `${action} should be shown`).toBeGreaterThan(0);
      else expect(found, `${action} must not be shown`).toHaveLength(0);
    }
  });

  it('queued auth_required: the step that needs the provider is selected, it has no attempts, and Reconnect provider links to Settings', async () => {
    const user = userEvent.setup();
    const { router } = open('queued-auth-required');
    await ready();
    expect(screen.getByRole('heading', { level: 2, name: 'Plan a fix' })).toBeInTheDocument();
    expect(screen.getByText('Needed by: Plan a fix')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Attempts' }));
    expect(await screen.findByText('No attempts yet. Nothing has been sent to a provider.')).toBeInTheDocument();
    await user.click(within(screen.getByTestId('status-banner')).getByRole('link', { name: 'Reconnect provider' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/providers');
    });
  });

  it('queued auth_required: Resume stays disabled while the key is still missing, with the reason shown', async () => {
    const { bridge } = open('queued-auth-required');
    await ready();
    const resume = within(screen.getByTestId('status-banner')).getByRole('button', { name: 'Resume' });
    await waitFor(() => {
      expect(resume).toBeDisabled();
    });
    expect(resume).toHaveAccessibleDescription(/Resume is unavailable: connect OpenAI in Settings → Providers first/);
    expect(bridge.callsTo('relay/v1/runs.resume')).toHaveLength(0);
  });

  it('queued setup_blocked: Choose profile targets the step named by the readiness issue', async () => {
    const user = userEvent.setup();
    const { bridge, run } = open('queued-setup-blocked');
    await ready();
    await user.click(within(screen.getByTestId('status-banner')).getByRole('button', { name: 'Choose another profile' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose another profile for Plan a fix' });
    await user.click(within(dialog).getByRole('button', { name: 'Switch profile and continue' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.resume')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/runs.resume')[0]?.input).toMatchObject({
      runId: run.id,
      decision: { kind: 'switch_profile', stepKey: 'plan' },
    });
  });

  it('paused(unknown_outcome) offering resume maps it to runs.resume { kind: continue }', async () => {
    const user = userEvent.setup();
    const { bridge, run } = open('unknown-outcome-decided');
    await ready();
    const panel = screen.getByRole('region', { name: 'Recovery' });
    await user.click(within(panel).getByRole('button', { name: 'Resume' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.resume')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/runs.resume')[0]?.input).toMatchObject({ runId: run.id, decision: { kind: 'continue' } });
    await waitFor(() => {
      expect(bridge.world.runs[0]?.status).toBe('running');
    });
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

  it('approving from ?step=<approval> confirms "Plan approved" and hands the selection back to the run', async () => {
    const approvalStep = createFakeBridge('awaiting-approval').world.runs.find((r) => r.status === 'awaiting_approval')?.steps.find((st) => st.state === 'awaiting_approval');
    const { router } = open('awaiting-approval', `?step=${approvalStep?.id ?? ''}`);
    const card = (await screen.findByRole('heading', { name: 'Proposed plan' })).closest('section') as HTMLElement;
    expect(stepParam(router)).toBe(approvalStep?.id);
    await userEvent.click(within(card).getByRole('button', { name: 'Approve plan' }));
    expect(await screen.findByText('Plan approved')).toBeInTheDocument();
    expect(screen.queryByText(/: done$/)).toBeNull();
    await waitFor(() => {
      expect(stepParam(router)).toBeNull();
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
    const approve = await within(await screen.findByRole('region', { name: 'Proposed plan' })).findByRole('button', { name: 'Approve plan' });
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
    // The current profile is listed for comparison, marked "(current)", and cannot be chosen again.
    const current = within(select).getAllByRole('option').filter((o) => o.textContent.startsWith('Capable'));
    expect(current).toHaveLength(1);
    expect(current[0]).toBeDisabled();
    expect(current[0]?.textContent).toMatch(/\(current\)$/);
    expect((select as HTMLSelectElement).value).not.toBe(current[0]?.getAttribute('value'));
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

  it('decide unknown: a RecoveryPanel row decision confirms (retry "may incur another charge") and decides that attempt', async () => {
    const { bridge, run } = open('unknown-outcome');
    const attempt = run.unresolvedAttempts[0];
    expect(screen.queryByRole('button', { name: 'Decide on unknown charge' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Retry (may incur another charge)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Retry this request?' });
    expect(within(dialog).getByText(/The retry may incur another charge/)).toBeInTheDocument();
    expect(describeViolations(await axe(document.body))).toEqual([]);
    expect(bridge.callsTo('relay/v1/runs.decideUnknown')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry (may incur another charge)' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.decideUnknown')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/runs.decideUnknown')[0]?.input).toMatchObject({
      runId: run.id,
      attemptId: attempt?.id,
      decision: 'retry_acknowledging_charge',
    });
  });

  it('decide unknown: "Not now" closes the confirmation without deciding', async () => {
    const { bridge } = open('unknown-outcome');
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as failed without retry' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark this request as failed?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Not now' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(bridge.callsTo('relay/v1/runs.decideUnknown')).toHaveLength(0);
  });

  it('a runner channel answering not_implemented shows the generic action error', async () => {
    const bridge = createFakeBridge('paused-user');
    bridge.world.notImplemented.add('runs.resume');
    const run = focusRun(bridge);
    renderApp(`${P}/runs/${run.id}`, { bridge });
    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    const alert = (await screen.findByText('This feature is not available in this build yet.')).closest('.banner') as HTMLElement;
    expect(alert).toHaveTextContent('Error code INTERNAL. The run is unchanged.');
  });

  it('?tab=ledger shows the run ledger and exports it as CSV via ledger.export({ runId })', async () => {
    const { bridge, run } = open('completed', '?tab=ledger');
    const table = await screen.findByRole('table', { name: /Ledger entries for Run/ });
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Created', 'Step', 'Attempt', 'Type', 'Bucket', 'Delta', 'Certainty', 'Price catalog']);
    expect(within(table).getAllByRole('row').length - 1).toBe(bridge.world.ledger.get(run.id)?.length);
    await userEvent.click(screen.getByRole('button', { name: 'Export ledger (CSV)…' }));
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

// ---------------------------------------------------------------------------------------------------------------
// Referee regressions (B1–B5)

/** Adds a newer retry row of `stepKey` (and its step detail) to the focus run; returns the old and new rows. */
function addNewerRow(bridge: FakeBridge, stepKey: string): { readonly old: StepView; readonly newer: StepView } {
  const run = focusRun(bridge);
  const old = run.steps.find((s) => s.stepKey === stepKey);
  if (old === undefined) throw new Error(`no ${stepKey} row`);
  const newer = stepViewSchema.parse({ ...old, id: sid('stepRun', 99_001), retryIndex: old.retryIndex + 1, state: 'ready', outputArtifactId: null, error: null });
  bridge.world.runs[0] = { ...run, steps: [...run.steps, newer] };
  const detail = bridge.world.steps.get(old.id);
  if (detail === undefined) throw new Error('no step detail');
  bridge.world.steps.set(newer.id, { ...detail, step: newer, output: null, attempts: [], events: [] });
  return { old, newer };
}

function pushEvent(bridge: FakeBridge, type: RunEvent['type'], payload: Record<string, unknown>): RunEvent {
  const run = focusRun(bridge);
  const list = bridge.world.events.get(run.id) ?? [];
  const seq = (list.at(-1)?.seq ?? 0) + 1;
  const event = runEventSchema.parse({ id: sid('event', 88_000 + seq), runId: run.id, seq, type, at: Date.now(), payload });
  bridge.world.events.set(run.id, [...list, event]);
  return event;
}

function stepParam(router: { readonly state: { readonly location: { readonly search: string } } }): string | null {
  return new URLSearchParams(router.state.location.search).get('step');
}

describe('RunInspectorPage regressions', () => {
  it('B1: only profiles whose provider is in the loaded project allowlist are offered', async () => {
    const bridge = createFakeBridge('refused');
    const project = bridge.world.projects[0];
    if (project === undefined) throw new Error('no project');
    bridge.world.projects[0] = { ...project, providerPolicy: { ...project.providerPolicy, allowedProviderIds: ['openai'] } };
    renderApp(`${P}/runs/${focusRun(bridge).id}`, { bridge });
    await userEvent.click(await screen.findByRole('button', { name: 'Choose another profile' }));
    const select = await screen.findByRole('combobox', { name: 'Profile' });
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatch(/^Balanced · OpenAI/); // Economy (Anthropic) is not permitted
  });

  it('B1: an empty allowlist permits no profile (not every profile)', async () => {
    const bridge = createFakeBridge('refused');
    const project = bridge.world.projects[0];
    if (project === undefined) throw new Error('no project');
    bridge.world.projects[0] = { ...project, providerPolicy: { ...project.providerPolicy, allowedProviderIds: [] } };
    renderApp(`${P}/runs/${focusRun(bridge).id}`, { bridge });
    await userEvent.click(await screen.findByRole('button', { name: 'Choose another profile' }));
    const dialog = await screen.findByRole('dialog', { name: /Choose another profile/ });
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/This project allows no provider/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Retry step with this profile' })).toBeDisabled();
  });

  it('B1: while the project is loading, Choose profile is disabled with a reason', async () => {
    const bridge = createFakeBridge('refused');
    const release = bridge.hold('relay/v1/projects.get');
    renderApp(`${P}/runs/${focusRun(bridge).id}`, { bridge });
    const button = await screen.findByRole('button', { name: 'Choose another profile' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/loading the project's allowed providers/);
    release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Choose another profile' })).toBeEnabled();
    });
  });

  it('B1: when the project fails to load, Choose profile stays disabled with a reason', async () => {
    const bridge = createFakeBridge('refused');
    bridge.failNext('relay/v1/projects.get', errors.notFound('project'));
    renderApp(`${P}/runs/${focusRun(bridge).id}`, { bridge });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Choose another profile' })).toHaveAccessibleDescription(/could not be loaded/);
    });
    expect(screen.getByRole('button', { name: 'Choose another profile' })).toBeDisabled();
  });

  it('B2: the Events tab lists only the selected row; legacy step-key-only events are a separate run-level group', async () => {
    const bridge = createFakeBridge('completed');
    const { old, newer } = addNewerRow(bridge, 'implement');
    pushEvent(bridge, 'attempt.dispatching', { stepKey: 'implement', stepRunId: newer.id });
    pushEvent(bridge, 'artifact.write_failed', { stepKey: 'implement', stepRunIds: [newer.id] });
    pushEvent(bridge, 'error.recorded', { stepKey: 'implement' }); // legacy: no row id
    const run = focusRun(bridge);
    const { router } = renderApp(`${P}/runs/${run.id}?step=${old.id}&tab=events`, { bridge });
    const own = await screen.findByRole('list', { name: 'Events for this step' });
    await waitFor(() => {
      expect(within(own).getAllByTitle(/^attempt\.settled · /).length).toBeGreaterThan(0);
    });
    expect(within(own).queryByTitle(/^attempt\.dispatching · /)).not.toBeInTheDocument();
    expect(within(own).queryByTitle(/^artifact\.write_failed · /)).not.toBeInTheDocument();
    expect(within(own).queryByTitle(/^error\.recorded · /)).not.toBeInTheDocument();
    const legacy = screen.getByRole('list', { name: 'Run-level events' });
    expect(within(legacy).getByTitle(/^error\.recorded · /)).toBeInTheDocument();

    await act(async () => {
      await router.navigate(`${P}/runs/${run.id}?step=${newer.id}&tab=events`);
    });
    const newerList = await screen.findByRole('list', { name: 'Events for this step' });
    await waitFor(() => {
      expect(within(newerList).getByTitle(/^attempt\.dispatching · /)).toBeInTheDocument();
    });
    expect(within(newerList).getByTitle(/^artifact\.write_failed · /)).toBeInTheDocument(); // stepRunIds[] (revision events)
    expect(within(newerList).queryByTitle(/^attempt\.settled · /)).not.toBeInTheDocument();
  });

  it('B3: after Retry step the selection (and ?step=) moves to the newer row of the step', async () => {
    const bridge = createFakeBridge('output-invalid');
    const run = focusRun(bridge);
    const failed = run.steps.find((s) => s.state === 'failed');
    const { router } = renderApp(`${P}/runs/${run.id}?step=${failed?.id ?? ''}`, { bridge });
    await userEvent.click(await screen.findByRole('button', { name: 'Retry step' }));
    await waitFor(() => {
      const latest = focusRun(bridge).steps.filter((s) => s.stepKey === 'implement').at(-1);
      expect(latest?.id).not.toBe(failed?.id);
      expect(stepParam(router)).toBe(latest?.id);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('newer-attempt-notice')).not.toBeInTheDocument();
    });
  });

  it('B3: after Choose profile the selection follows the newer row', async () => {
    const bridge = createFakeBridge('refused');
    const run = focusRun(bridge);
    const failed = run.steps.find((s) => s.state === 'failed');
    const { router } = renderApp(`${P}/runs/${run.id}?step=${failed?.id ?? ''}`, { bridge });
    await userEvent.click(await screen.findByRole('button', { name: 'Choose another profile' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Retry step with this profile' }));
    await waitFor(() => {
      const latest = focusRun(bridge).steps.filter((s) => s.stepKey === 'implement').at(-1);
      expect(latest?.id).not.toBe(failed?.id);
      expect(stepParam(router)).toBe(latest?.id);
    });
  });

  it('B3: a URL-selected superseded row shows "A newer attempt of this step exists" with a View latest link', async () => {
    const bridge = createFakeBridge('completed');
    const { old, newer } = addNewerRow(bridge, 'implement');
    const { router } = renderApp(`${P}/runs/${focusRun(bridge).id}?step=${old.id}`, { bridge });
    const notice = await screen.findByTestId('newer-attempt-notice');
    expect(notice).toHaveTextContent('A newer attempt of this step exists.');
    await userEvent.click(within(notice).getByRole('link', { name: 'View latest' }));
    await waitFor(() => {
      expect(stepParam(router)).toBe(newer.id);
    });
    expect(screen.queryByTestId('newer-attempt-notice')).not.toBeInTheDocument();
  });

  it('B4: incomplete copy follows statusDetail.incompleteCause', async () => {
    const cases = [
      [{ limit: 'revisions', incompleteCause: 'verifier_incomplete' }, 'The workflow reviewer marked the result incomplete'],
      [{ limit: 'revisions', incompleteCause: 'revision_limit', revisionCycle: 1, maxRevisionCycles: 3 }, 'Revision limit reached (1 of 3)'],
      [undefined, 'Incomplete'],
    ] as const;
    for (const [details, title] of cases) {
      const bridge = createFakeBridge('incomplete');
      const run = focusRun(bridge);
      bridge.world.runs[0] = {
        ...run,
        statusDetail: details === undefined ? null : { ...(run.statusDetail ?? appError('LIMIT_REACHED')), details },
      };
      const { unmount } = renderApp(`${P}/runs/${run.id}`, { bridge });
      const banner = await screen.findByTestId('status-banner');
      const titles = [...banner.querySelectorAll('strong')].map((n) => n.textContent);
      expect(titles, String(details?.incompleteCause)).toContain(title);
      if (details?.incompleteCause !== 'revision_limit') expect(banner).not.toHaveTextContent(/Revision limit reached/);
      unmount();
    }
  });

  it('B5: when a banner action removes its button, focus moves to the step heading (not <body>)', async () => {
    open('paused-user');
    const resume = await screen.findByRole('button', { name: 'Resume' });
    resume.focus();
    await userEvent.click(resume);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('inspector-step-heading');
    });
  });

  it('B5: a confirmed stop whose opener disappears returns focus to the step heading', async () => {
    open('paused-user');
    await userEvent.click(await screen.findByRole('button', { name: 'Stop run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop this run?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop run' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('inspector-step-heading');
    });
  });

  it('B5: an action dialog closed after its opener is gone returns focus to the step heading', async () => {
    open('refused');
    await userEvent.click(await screen.findByRole('button', { name: 'Choose another profile' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Retry step with this profile' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('inspector-step-heading');
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A11Y-01: one announcer for run status

/** Text currently inside any live container other than the app live region. */
function otherLiveText(): string {
  const live = [...document.querySelectorAll<HTMLElement>('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]')];
  return live
    .filter((el) => el.dataset['testid'] !== 'live-region' && el.closest('[data-testid="live-region"]') === null)
    .map((el) => el.textContent)
    .join(' | ');
}

describe('RunInspectorPage live announcements (A11Y-01)', () => {
  it('a pushed status change is announced exactly once, by the app live region only', async () => {
    const { bridge, run } = open('running-streaming');
    await ready();
    const announced: string[] = [];
    const region = screen.getByTestId('live-region');
    const observer = new MutationObserver(() => {
      const text = region.textContent.trim();
      if (text !== '') announced.push(text);
    });
    observer.observe(region, { childList: true, subtree: true, characterData: true });
    bridge.world.runs[0] = { ...run, status: 'paused', pauseReason: 'user' };
    const last = bridge.world.events.get(run.id)?.at(-1)?.seq ?? 0;

    act(() => {
      bridge.emit({
        type: 'run.event',
        event: runEventSchema.parse({
          id: 'evt_00000000000000000000099998',
          runId: run.id,
          seq: last + 1,
          type: 'run.status_changed',
          at: Date.now(),
          payload: { from: 'running', to: 'paused', pauseReason: 'user' },
        }),
      });
    });
    const banner = await screen.findByTestId('status-banner');
    await waitFor(() => {
      expect(banner).toHaveTextContent('Paused by you');
    });
    observer.disconnect();

    expect(announced).toEqual(['Run status: Paused by you.']);
    expect(otherLiveText()).not.toMatch(/Paused/);
  });
});

/** Replaces the focus run of `bridge` (before render) with `patch` applied. */
function patchRun(bridge: FakeBridge, patch: (run: RunDetail) => Partial<RunDetail>): RunDetail {
  const run = focusRun(bridge);
  const next = { ...run, ...patch(run) };
  bridge.world.runs[0] = next;
  return next;
}

/** Gives steps display names through `RunDetail.stepMeta` (E1). */
function nameSteps(bridge: FakeBridge, names: Readonly<Record<string, string>>): RunDetail {
  return patchRun(bridge, (run) => ({
    stepMeta: (run.stepMeta ?? []).map((m) => ({ ...m, name: names[m.stepKey] ?? m.name })),
  }));
}

function stepOf(run: RunDetail, stepKey: string): StepView {
  const step = run.steps.find((s) => s.stepKey === stepKey);
  if (step === undefined) throw new Error(`no ${stepKey} step`);
  return step;
}

describe('RunInspectorPage E1 run-level fields', () => {
  it('Attempts tab: "This step / Whole run" toggle lists every attempt of the run', async () => {
    const bridge = createFakeBridge('completed');
    const run = nameSteps(bridge, { review: 'Code review' });
    renderApp(`${P}/runs/${run.id}?step=${stepOf(run, 'implement').id}&tab=attempts`, { bridge });
    const group = await screen.findByRole('group', { name: 'Attempts to show' });
    expect(within(group).getByRole('button', { name: 'This step' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByRole('table', { name: 'Attempts for Produce patch' })).toBeInTheDocument();
    await userEvent.click(within(group).getByRole('button', { name: 'Whole run' }));
    const table = screen.getByRole('table', { name: 'Attempts for the whole run, oldest first' });
    expect(within(table).getAllByRole('row')).toHaveLength((run.attempts?.length ?? 0) + 1);
    // The run-level view names each attempt's step (display name from stepMeta).
    expect(within(table).getByText('Code review · Initial')).toBeInTheDocument();
  });

  it('Attempts tab: a step with no attempts opens on the whole run', async () => {
    const bridge = createFakeBridge('completed');
    const run = focusRun(bridge);
    renderApp(`${P}/runs/${run.id}?step=${stepOf(run, 'approve').id}&tab=attempts`, { bridge });
    expect(await screen.findByRole('table', { name: 'Attempts for the whole run, oldest first' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Whole run' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/has no attempts yet, so every attempt of the run is shown/)).toBeInTheDocument();
  });

  it('Attempts tab: an older runner without RunDetail.attempts shows the step table and no toggle', async () => {
    const bridge = createFakeBridge('completed');
    const run = patchRun(bridge, () => ({ attempts: undefined }));
    renderApp(`${P}/runs/${run.id}?step=${stepOf(run, 'implement').id}&tab=attempts`, { bridge });
    expect(await screen.findByRole('table', { name: 'Attempts for Produce patch' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Attempts to show' })).not.toBeInTheDocument();
  });

  it('Context tab: a step without a manifest shows the latest context of the run, fetched and schema-checked', async () => {
    const bridge = createFakeBridge('completed');
    const run = nameSteps(bridge, { verify: 'Final check' });
    renderApp(`${P}/runs/${run.id}?step=${stepOf(run, 'approve').id}&tab=context`, { bridge });
    expect(await screen.findByRole('heading', { name: 'Latest context sent (step Final check)' })).toBeInTheDocument();
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/artifacts.get').map((c) => c.input)).toContainEqual({ artifactId: run.latestManifest?.artifactId });
    });
    expect((await screen.findAllByText('Selected by you', {}, { timeout: 3000 })).length).toBeGreaterThan(0);
  });

  it('Context tab: a purged or missing latest manifest is explained, not an error', async () => {
    const bridge = createFakeBridge('completed');
    const run = focusRun(bridge);
    bridge.failNext('relay/v1/artifacts.get', errors.notFound('artifact'));
    renderApp(`${P}/runs/${run.id}?step=${stepOf(run, 'approve').id}&tab=context`, { bridge });
    expect(await screen.findByText(/This manifest is no longer stored/)).toBeInTheDocument();
  });

  it('Choose profile: each option shows "reserves ≈ $X" and the current profile is marked', async () => {
    open('budget-paused');
    await userEvent.click(await screen.findByRole('button', { name: 'Choose another profile' }));
    const select = await screen.findByRole('combobox', { name: 'Profile' });
    const options = within(select).getAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    for (const o of options) expect(o.textContent).toMatch(/ · reserves ≈ \$\d+\.\d\d/);
    const current = options.filter((o) => o.textContent.endsWith('(current)'));
    expect(current).toHaveLength(1);
    expect(current[0]).toBeDisabled();
  });

  it('Choose profile: a never-estimated step says "reserves at least ≈ $X"', async () => {
    open('choose-profile-minimum');
    await userEvent.click(await screen.findByRole('button', { name: 'Choose another profile' }));
    const select = await screen.findByRole('combobox', { name: 'Profile' });
    for (const o of within(select).getAllByRole('option')) expect(o.textContent).toMatch(/reserves at least ≈ \$\d/);
  });

  it('Choose profile: without profileOptions the permitted profiles are listed as before', async () => {
    const bridge = createFakeBridge('budget-paused');
    const run = patchRun(bridge, () => ({ profileOptions: [] }));
    renderApp(`${P}/runs/${run.id}`, { bridge });
    await userEvent.click(await screen.findByRole('button', { name: 'Choose another profile' }));
    const select = await screen.findByRole('combobox', { name: 'Profile' });
    for (const o of within(select).getAllByRole('option')) expect(o.textContent).not.toMatch(/reserves/);
  });

  it('stepMeta: display names in the timeline and step header, with the instruction version', async () => {
    const bridge = createFakeBridge('completed');
    const run = nameSteps(bridge, { implement: 'Write the fix' });
    renderApp(`${P}/runs/${run.id}?step=${stepOf(run, 'implement').id}`, { bridge });
    expect(await screen.findByRole('heading', { level: 2, name: 'Write the fix' })).toBeInTheDocument();
    const timeline = screen.getByRole('list', { name: 'Run steps' });
    expect(within(timeline).getByText('Write the fix')).toBeInTheDocument();
    expect(within(timeline).getByText('Review input')).toBeInTheDocument(); // unnamed steps keep the key label
    expect(screen.getByTestId('step-instruction-version')).toHaveTextContent('Instructions implementer.v1');
  });
});

describe('RunInspectorPage unknown requests', () => {
  it('unknown-outcome: the request facts show the dispatch time and that no request id was recorded', async () => {
    const { run } = open('unknown-outcome');
    const banner = await screen.findByTestId('status-banner');
    const facts = within(banner).getByRole('list', { name: 'Requests with an unknown outcome' });
    expect(within(facts).getByText('No request id was recorded')).toBeInTheDocument();
    const sent = within(facts).getByText('Sent').nextElementSibling?.querySelector('time');
    expect(sent).toHaveAttribute('dateTime', new Date(run.unresolvedAttempts[0]?.startedAt ?? 0).toISOString());
  });

  it('unknown-outcome: a recorded provider request id is shown and copyable', async () => {
    const bridge = createFakeBridge('unknown-outcome');
    const run = patchRun(bridge, (r) => ({
      unresolvedAttempts: r.unresolvedAttempts.map((a) => ({ ...a, providerRequestId: 'req_01JABCDEF' })),
    }));
    renderApp(`${P}/runs/${run.id}`, { bridge });
    const banner = await screen.findByTestId('status-banner');
    expect(within(banner).getByText('req_01JABCDEF')).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: /Copy provider request id of Produce patch · attempt 1/ })).toBeInTheDocument();
  });

  it('cancelled (finished) run: "Decide on unknown charge" offers only accepting the estimate or marking failed', async () => {
    const { run } = open('cancelled');
    expect(run.unresolvedAttempts.length).toBeGreaterThan(0);
    await userEvent.click(await screen.findByRole('button', { name: 'Decide on unknown charge' }));
    const dialog = await screen.findByRole('dialog', { name: 'Decide on the unknown request' });
    const radios = within(dialog).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('value'))).toEqual(['accept_estimated_charge', 'mark_failed_keep_liability']);
    expect(within(dialog).queryByText(UNKNOWN_OUTCOME_DECISION_LABELS.retry_acknowledging_charge)).not.toBeInTheDocument();
    expect(within(dialog).getByText('No request id was recorded')).toBeInTheDocument();
  });
});

describe('RunInspectorPage interrupted wording (AppInfo.lastShutdown)', () => {
  it('interrupted (crash): the background runner stopped responding while the step was running', async () => {
    open('interrupted');
    const banner = await screen.findByTestId('status-banner');
    await waitFor(() => {
      expect(banner).toHaveTextContent(/The background runner stopped responding while Produce patch was running\./);
    });
  });

  it('interrupted-quit (clean): Relay was closed while the step was running', async () => {
    open('interrupted-quit');
    const banner = await screen.findByTestId('status-banner');
    await waitFor(() => {
      expect(banner).toHaveTextContent(/Relay was closed while Produce patch was running\./);
    });
  });

  it('no shutdown record: a neutral cause', async () => {
    const bridge = createFakeBridge('interrupted');
    bridge.world.info = { ...bridge.world.info, lastShutdown: null };
    renderApp(`${P}/runs/${focusRun(bridge).id}`, { bridge });
    const banner = await screen.findByTestId('status-banner');
    await waitFor(() => {
      expect(banner).toHaveTextContent(/Relay stopped while Produce patch was running\./);
    });
  });
});

describe('RunInspectorPage exports', () => {
  it('a part that failed to export is a warning naming the reason, not a success toast', async () => {
    const bridge = createFakeBridge('completed');
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = (async (channel: string, input: unknown) => {
      if (channel !== 'relay/v1/artifacts.export') return invoke(channel as never, input as never);
      await invoke(channel as never, input as never);
      return {
        ok: true,
        data: {
          exported: true,
          displayPaths: ['~/Downloads/report.md'],
          written: [{ what: 'report', displayPath: '~/Downloads/report.md' }],
          failed: [{ what: 'patch', code: 'ARTIFACT_WRITE_FAILED', userMessage: 'The folder may be read-only.' }],
        },
      };
    }) as typeof bridge.invoke;
    renderApp(`${P}/runs/${focusRun(bridge).id}`, { bridge });
    await userEvent.click(await screen.findByRole('button', { name: RUN_ACTION_LABELS.export_report }));
    expect(await screen.findByText('Export partly saved')).toBeInTheDocument();
    expect(screen.getByText(/Patch not saved: The folder may be read-only\./)).toBeInTheDocument();
    expect(screen.queryByText('Export saved')).not.toBeInTheDocument();
  });

  it('a full export is a success toast', async () => {
    open('completed');
    await userEvent.click(await screen.findByRole('button', { name: RUN_ACTION_LABELS.export_report }));
    expect(await screen.findByText('Export saved')).toBeInTheDocument();
  });
});
