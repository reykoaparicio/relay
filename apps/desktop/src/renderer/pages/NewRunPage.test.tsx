import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { appError, errors } from '@relay/contracts';
import { createFakeBridge, FAKE_PROJECT_ID } from '../api/fake-bridge';
import { PROFILES } from '../api/fake-scenarios/world';
import { renderApp } from '../features/testing/render-app';
import { budgetBreakdown } from '../components/ui/test-fixtures';

const NEW_RUN = `/p/${FAKE_PROJECT_ID}/runs/new`;
const SLOW = { timeout: 3000 };

async function ready() {
  await screen.findByRole('heading', { level: 1, name: 'Start a workflow' });
  await screen.findByRole('table', { name: 'Role to model profile snapshot' });
}

describe('NewRunPage (J7)', () => {
  it('ready: the preflight summary recomputes and shows the providers that receive context', async () => {
    const { bridge } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    await ready();
    // Every check passed, but there is no goal yet: Start stays disabled and says why (never "Ready to start").
    expect(await screen.findByText('Checks passed. Enter a goal to start.', {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByText('All checks passed. Ready to start.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start run' })).toHaveAccessibleDescription('Enter a goal to start.');
    const summary = screen.getByRole('region', { name: 'Input summary' });
    expect(within(summary).getByText('First reservation')).toBeInTheDocument();
    expect(within(summary).getByText('≈ $0.54 est.')).toBeInTheDocument();
    const providers = screen.getByRole('region', { name: 'Providers that will receive this context' });
    expect(within(providers).getByText(/Anthropic/)).toBeInTheDocument();
    // Debounced: typing a goal does not send one preflight per keystroke.
    const before = bridge.callsTo('relay/v1/runs.preflight').length;
    await userEvent.type(screen.getByRole('textbox', { name: /Goal/ }), 'Tighten validation');
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.preflight').length).toBe(before + 1);
    }, SLOW);
    expect(bridge.callsTo('relay/v1/runs.preflight').at(-1)?.input).toMatchObject({
      goal: 'Tighten validation',
    });
  });

  it('validation-errors: client errors appear next to their fields and in the summary with anchors', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    const summary = await screen.findByRole('alert', { name: /2 problems prevent starting this run/ });
    const goalLink = within(summary).getByRole('link', { name: /Enter a goal/ });
    within(summary).getByRole('link', { name: 'Select at least one file.' });
    const goal = screen.getByRole('textbox', { name: /Goal/ });
    expect(goal).toHaveAttribute('aria-invalid', 'true');
    expect(goal).toHaveAccessibleDescription(/Enter a goal: describe the outcome you want\./);
    await user.click(goalLink);
    expect(goal).toHaveFocus();
    expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(0);
  });

  it('validation-errors: preflight issues are listed in the summary and shown at the profile select', async () => {
    const { bridge } = renderApp(NEW_RUN, { scenario: 'validation-errors' });
    await ready();
    const summary = await screen.findByRole('alert', { name: /3 problems prevent starting this run/ }, SLOW);
    expect(
      within(summary).getByRole('link', { name: 'Planner: no working credential for OpenAI.' }),
    ).toBeInTheDocument();
    expect(within(summary).getByText('AUTH_REQUIRED')).toBeInTheDocument();
    const plan = screen.getByRole('combobox', { name: /Planner profile \(Plan a fix step\)/ });
    expect(plan).toHaveAttribute('aria-invalid', 'true');
    expect(plan).toHaveAccessibleDescription(/no working credential for OpenAI/);
    expect(screen.getByText('Fix 3 problems to start.')).toBeInTheDocument();
    // Start stays disabled while the preflight reports issues: runs.start is never sent.
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Try anyway');
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.preflight').at(-1)?.input).toMatchObject({ goal: 'Try anyway' });
    }, SLOW);
    expect(
      await screen.findByRole('alert', { name: /3 problems prevent starting this run/ }, SLOW),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();
    await user.type(screen.getByRole('spinbutton', { name: /Max attempts/ }), '{Enter}');
    expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(0);
  });

  it('missing credential (06 F14): each affected step names the provider, links to Settings → Providers, and blocks Start', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp(NEW_RUN, { scenario: 'missing-credential' });
    await ready();
    await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Tighten validation');
    const summary = await screen.findByRole('alert', { name: /2 problems prevent starting this run/ }, SLOW);
    const planLink = within(summary).getByRole('link', {
      name: 'Planner: no API key is connected for OpenAI. Connect it, or choose a profile whose provider is connected.',
    });
    expect(within(summary).getAllByText('missing_credential')).toHaveLength(2);
    const plan = screen.getByRole('combobox', { name: /Planner profile \(Plan a fix step\)/ });
    expect(plan).toHaveAttribute('aria-invalid', 'true');
    await user.click(planLink);
    expect(plan).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();
    await user.type(screen.getByRole('spinbutton', { name: /Max attempts/ }), '{Enter}');
    expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(0);
    const connect = within(summary).getAllByRole('link', { name: 'Connect provider' });
    expect(connect).toHaveLength(2);
    await user.click(connect[0] as HTMLElement);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/providers');
    });
  });

  it('missing credential: choosing a profile whose provider is connected clears the problem and allows Start', async () => {
    const user = userEvent.setup();
    renderApp(NEW_RUN, { scenario: 'missing-credential' });
    await ready();
    await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Tighten validation');
    await screen.findByRole('alert', { name: /2 problems prevent starting this run/ }, SLOW);
    for (const name of [/Planner profile \(Plan a fix step\)/, /Reviewer profile \(Review patch step\)/]) {
      const select = screen.getByRole('combobox', { name });
      await user.selectOptions(select, within(select).getByRole('option', { name: /^Capable · Anthropic/ }));
    }
    expect(await screen.findByText('All checks passed. Ready to start.', {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByText('missing_credential')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeEnabled();
  });

  it('a limit above RUN_LIMIT_MAXIMUMS shows a field error at once', async () => {
    const user = userEvent.setup();
    renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    await ready();
    const attempts = screen.getByRole('spinbutton', { name: /Max attempts/ });
    await user.clear(attempts);
    await user.type(attempts, '51');
    expect(attempts).toHaveAttribute('aria-invalid', 'true');
    expect(attempts).toHaveAccessibleDescription(/Must be at most 50/);
    const cycles = screen.getByRole('spinbutton', { name: /Revision cycles/ });
    await user.clear(cycles);
    await user.type(cycles, '6');
    expect(cycles).toHaveAccessibleDescription(/Must be at most 5/);
  });

  it('budget-blocked: shows L/C/R/U/N, blocks Start, and an inline allowance increase re-checks', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(NEW_RUN, { scenario: 'budget-blocked' });
    await ready();
    const panel = await screen.findByRole('region', { name: /Admission check/ }, SLOW);
    const table = within(panel).getByRole('table', { name: /C \+ R \+ U \+ N must not exceed L/ });
    const amount = (sym: string) =>
      within(table).getByText(sym).closest('tr')?.querySelector('td.num')?.textContent;
    expect(amount('L')).toBe('$3.00');
    expect(amount('C')).toBe('$1.20');
    expect(amount('R')).toBe('$0.40');
    expect(amount('U')).toBe('$0.00');
    expect(amount('N')).toBe('$1.50');
    expect(within(panel).getByText('$3.10 > $3.00 → blocked')).toBeInTheDocument();
    // The preflight also lists `budget_run` (06 F14); the budget card already shows it, so it is not a second problem.
    expect(screen.queryByText('budget_run')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: /problems? prevents? starting/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();
    expect(screen.getByText(/Blocked by the run allowance/)).toBeInTheDocument();
    expect(within(panel).getByRole('textbox', { name: /New run allowance/ })).toHaveValue('3.10');
    await user.click(within(panel).getByRole('button', { name: 'Use this allowance and re-check' }));
    expect(screen.getByRole('textbox', { name: /Run allowance \(USD\)/ })).toHaveValue('3.10');
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: /Admission check/ })).not.toBeInTheDocument();
    }, SLOW);
    expect(bridge.callsTo('relay/v1/runs.preflight').at(-1)?.input).toMatchObject({
      limitOverrides: { budgetMicrousd: 3_100_000 },
    });
    // The budget passes now; only the goal is missing.
    expect(await screen.findByText('Checks passed. Enter a goal to start.', {}, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();
  });

  it('double submit sends a single runs.start with one idempotency key; overrides and memory ids are exact', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    await ready();
    await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Review input validation');
    // Change only the plan step's profile (default Balanced → Economy).
    await user.selectOptions(
      screen.getByRole('combobox', { name: /Planner profile \(Plan a fix step\)/ }),
      PROFILES.economy.id,
    );
    // A pinned rule is checked and locked; every approved record starts ticked; untick one non-pinned record.
    expect(
      screen.getByRole('checkbox', { name: 'Preserve the existing public response format' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: 'Preserve the existing public response format' }),
    ).toBeChecked();
    const keepBox = await screen.findByRole('checkbox', { name: 'Keep handlers thin' });
    expect(keepBox).toBeChecked();
    await user.click(keepBox);
    // Start waits for the preflight of exactly this input.
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();
    expect(await screen.findByText('All checks passed. Ready to start.', {}, SLOW)).toBeInTheDocument();

    const release = bridge.hold('relay/v1/runs.start');
    const startButton = screen.getByRole('button', { name: 'Start run' });
    await user.dblClick(startButton);
    await user.click(startButton);
    expect(startButton).toBeDisabled();
    release();
    await waitFor(() => {
      expect(router.state.location.pathname).toMatch(/\/runs\/run_\w+$/);
    });
    const calls = bridge.callsTo('relay/v1/runs.start');
    expect(calls).toHaveLength(1);
    const input = calls[0]?.input as Record<string, unknown>;
    expect(input['idempotencyKey']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(input['profileOverrides']).toEqual({ plan: PROFILES.economy.id });
    // Touched: the explicit list of the still-ticked non-pinned approved records (pinned rules never sent).
    const expected = bridge.world.memory
      .filter((m) => m.status === 'approved' && !m.pinned && m.title !== 'Keep handlers thin')
      .map((m) => m.id);
    expect(input['memoryRecordIds']).toEqual(expected);
    expect(input).not.toHaveProperty('limitOverrides');
    expect(input['goal']).toBe('Review input validation');
  });

  it('memory default: every approved record is ticked and memoryRecordIds is absent; the preflight lists the records', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    await ready();
    await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Review input validation');
    for (const m of bridge.world.memory.filter((x) => x.status === 'approved')) {
      expect(await screen.findByRole('checkbox', { name: m.title })).toBeChecked();
    }
    expect(await screen.findByText('All checks passed. Ready to start.', {}, SLOW)).toBeInTheDocument();
    const included = screen.getByRole('list', { name: 'Memory records this run includes' });
    expect(within(included).getAllByRole('listitem')).toHaveLength(bridge.world.memory.filter((x) => x.status === 'approved').length);
    expect(within(included).getByText('Keep handlers thin')).toBeInTheDocument();
    for (const c of bridge.callsTo('relay/v1/runs.preflight')) expect(c.input).not.toHaveProperty('memoryRecordIds');
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/runs.start')[0]?.input).not.toHaveProperty('memoryRecordIds');
  });

  it('memory: unticking every non-pinned record sends memoryRecordIds: [] (pinned only)', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    await ready();
    await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Review input validation');
    for (const m of bridge.world.memory.filter((x) => x.status === 'approved' && !x.pinned)) {
      await user.click(await screen.findByRole('checkbox', { name: m.title }));
    }
    expect(await screen.findByText('All checks passed. Ready to start.', {}, SLOW)).toBeInTheDocument();
    const included = screen.getByRole('list', { name: 'Memory records this run includes' });
    expect(within(included).getAllByRole('listitem')).toHaveLength(bridge.world.memory.filter((x) => x.status === 'approved' && x.pinned).length);
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(1);
    });
    expect((bridge.callsTo('relay/v1/runs.start')[0]?.input as Record<string, unknown>)['memoryRecordIds']).toEqual([]);
  });

  it('memory.list failing (e.g. a future stubbed channel): the generic ErrorView, and the form stays usable', async () => {
    const { bridge } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    bridge.world.notImplemented.add('memory.list');
    await ready();
    const alert = (await screen.findByText('This feature is not available in this build yet.')).closest('.banner') as HTMLElement;
    expect(alert).toHaveTextContent('INTERNAL');
    expect(screen.queryByText(/Not available yet/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeEnabled();
  });

  // ----- Referee regressions -----

  it('B3: a profile change followed by Enter within the debounce never starts unpreflighted inputs', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    await ready();
    await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Review input validation');
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.preflight').at(-1)?.input).toMatchObject({
        goal: 'Review input validation',
      });
    }, SLOW);
    expect(await screen.findByText('All checks passed. Ready to start.', {}, SLOW)).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole('combobox', { name: /Planner profile \(Plan a fix step\)/ }),
      PROFILES.economy.id,
    );
    await user.type(screen.getByRole('textbox', { name: /Run allowance \(USD\)/ }), '{Enter}');
    expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();
    expect(screen.getAllByText('Checking…').length).toBeGreaterThan(0);
    // Once the preflight of this exact input passes, Enter starts it.
    expect(await screen.findByText('All checks passed. Ready to start.', {}, SLOW)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /Run allowance \(USD\)/ }), '{Enter}');
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(1);
    });
    const started = { ...(bridge.callsTo('relay/v1/runs.start')[0]?.input as Record<string, unknown>) };
    expect(started['idempotencyKey']).toEqual(expect.any(String) as unknown);
    delete started['idempotencyKey'];
    expect(started['profileOverrides']).toEqual({ plan: PROFILES.economy.id });
    expect(bridge.callsTo('relay/v1/runs.preflight').at(-1)?.input).toEqual(started);
  });

  it('B4: a preflight RUNNER_UNAVAILABLE shows an ErrorView with retry (no endless skeleton) and disables Start', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    bridge.failNext('relay/v1/runs.preflight', appError('RUNNER_UNAVAILABLE'));
    await ready();
    const summary = screen.getByRole('region', { name: 'Input summary' });
    expect(
      await within(summary).findByText('The background runner is not available.', {}, SLOW),
    ).toBeInTheDocument();
    expect(within(summary).getByRole('button', { name: 'Restart runner' })).toBeInTheDocument();
    expect(summary.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();
    expect(screen.getByText('The run check failed. Retry it in Input summary.')).toBeInTheDocument();
    await user.click(within(summary).getByRole('button', { name: 'Retry the check' }));
    expect(await screen.findByText('Checks passed. Enter a goal to start.', {}, SLOW)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Tighten validation');
    expect(await screen.findByText('All checks passed. Ready to start.', {}, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeEnabled();
  });

  it('B5: a preflight error next action (Restart runner) restarts the runner in place and never starts the run', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    bridge.failNext('relay/v1/runs.preflight', appError('RUNNER_UNAVAILABLE'));
    await ready();
    await user.click(await screen.findByRole('button', { name: 'Restart runner' }, SLOW));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/app.restartRunner')).toHaveLength(1);
    });
    expect(router.state.location.pathname).toBe(NEW_RUN);
    expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(0);
  });

  it('B5: a runs.start RUNNER_UNAVAILABLE next action restarts the runner and never re-sends runs.start', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    await ready();
    await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Review input validation');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start run' })).toBeEnabled();
    }, SLOW);
    await screen.findByText('All checks passed. Ready to start.', {}, SLOW);
    bridge.failNext('relay/v1/runs.start', appError('RUNNER_UNAVAILABLE'));
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await user.click(await screen.findByRole('button', { name: 'Restart runner' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/app.restartRunner')).toHaveLength(1);
    });
    expect(router.state.location.pathname).toBe(NEW_RUN);
    expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(1);
  });

  it('a runs.start BUDGET_BLOCKED after a passing preflight is announced, and the admission panel shows', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    await ready();
    await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Review input validation');
    await screen.findByText('All checks passed. Ready to start.', {}, SLOW);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start run' })).toBeEnabled();
    }, SLOW);
    const live = screen.getByTestId('live-region');
    expect(live).toHaveTextContent('');
    bridge.failNext('relay/v1/runs.start', errors.budgetBlocked(budgetBreakdown()));
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    expect(await screen.findByRole('region', { name: /Admission check/ })).toBeInTheDocument();
    expect(live).toHaveTextContent(
      'Start blocked: the run allowance would be exceeded. Nothing was reserved or sent. Choose how to continue below.',
    );
    expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(1);
  });

  it('diff import: a cancelled dialog changes nothing; parse warnings show; runs.start sends the imported diff', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    await ready();
    await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Review this change');
    await user.click(screen.getByRole('radio', { name: /Import a \.diff\/\.patch file/ }));
    bridge.world.dialogCancels.add('artifacts.importDiff');
    await user.click(screen.getByRole('button', { name: 'Import a .diff/.patch file…' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/artifacts.importDiff')).toHaveLength(1);
    });
    expect(screen.queryByText(/Imported diff touching/)).not.toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/artifacts.importDiff')[0]?.input).toEqual({ projectId: FAKE_PROJECT_ID });

    bridge.world.dialogCancels.delete('artifacts.importDiff');
    bridge.world.importDiffWarnings = ['Hunk 3 of src/routes/users.ts has no trailing newline.'];
    await user.click(screen.getByRole('button', { name: 'Import a .diff/.patch file…' }));
    expect(await screen.findByText(/Imported diff touching 2 files/)).toBeInTheDocument();
    expect(screen.getByText('Relay read the file with warnings')).toBeInTheDocument();
    expect(screen.getByText('Hunk 3 of src/routes/users.ts has no trailing newline.')).toBeInTheDocument();
    expect(await screen.findByText('All checks passed. Ready to start.', {}, SLOW)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toMatch(/\/runs\/run_\w+$/);
    });
    expect(bridge.callsTo('relay/v1/runs.start')[0]?.input).toMatchObject({
      input: { kind: 'diff', diffArtifactId: expect.stringMatching(/^art_/) as unknown },
    });
  });

  it('B9: in diff mode an input problem links to the diff import button, which shows the error', async () => {
    const user = userEvent.setup();
    renderApp(NEW_RUN, { scenario: 'validation-errors' });
    await ready();
    await user.click(screen.getByRole('radio', { name: /Import a \.diff\/\.patch file/ }));
    const importButton = screen.getByRole('button', { name: 'Import a .diff/.patch file…' });
    await user.click(importButton);
    await screen.findByText(/Imported diff touching 2 files/);
    const summary = await screen.findByRole('alert', { name: /problems prevent starting this run/ }, SLOW);
    const link = await within(summary).findByRole(
      'link',
      { name: 'The selected context is too large for the Reviewer profile.' },
      SLOW,
    );
    const diffButton = screen.getByRole('button', { name: 'Import a different file…' });
    expect(diffButton).toHaveAccessibleDescription(/too large for the Reviewer profile/);
    await user.click(link);
    expect(diffButton).toHaveFocus();
  });

  it('B9: a memory problem links to the first enabled memory checkbox (pinned rules are disabled)', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    bridge.world.preflightIssues = [
      { path: 'memoryRecordIds.0', message: 'A chosen memory record is no longer approved.', code: 'VALIDATION_FAILED' },
    ];
    await ready();
    const summary = await screen.findByRole('alert', { name: /1 problem prevents starting this run/ }, SLOW);
    await screen.findByRole('checkbox', { name: 'Keep handlers thin' });
    await user.click(
      within(summary).getByRole('link', { name: 'A chosen memory record is no longer approved.' }),
    );
    const focused = document.activeElement as HTMLInputElement;
    expect(focused.type).toBe('checkbox');
    expect(focused).toBeEnabled();
    expect(focused).toHaveAccessibleDescription(/no longer approved/);
  });

  it('keeps a per-project draft: a trip to Settings and back keeps the goal and overrides', async () => {
    const user = userEvent.setup();
    const { router } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    await ready();
    await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Keep me');
    const allowance = screen.getByRole('textbox', { name: /Run allowance \(USD\)/ });
    await user.clear(allowance);
    await user.type(allowance, '4.50');
    await act(async () => {
      await router.navigate('/settings/projects');
    });
    await act(async () => {
      await router.navigate(NEW_RUN);
    });
    await ready();
    expect(screen.getByRole('textbox', { name: /Goal/ })).toHaveValue('Keep me');
    expect(screen.getByRole('textbox', { name: /Run allowance \(USD\)/ })).toHaveValue('4.50');
  });

  describe('suspected-secret (E2 #11)', () => {
    const KEYS = 'src/config/keys.ts';

    it('a flagged file is shown with its label in words and left unticked, also by "Select all"', async () => {
      const user = userEvent.setup();
      renderApp(NEW_RUN, { scenario: 'suspected-secret' });
      await ready();
      const keys = await screen.findByRole('checkbox', { name: KEYS });
      expect(keys).not.toBeChecked();
      expect(keys).toHaveAccessibleDescription(/Looks like it contains a secret: Anthropic API key, line 4\./);
      expect(screen.getByRole('checkbox', { name: 'src/app.ts' })).toBeChecked();
      await user.click(screen.getByRole('button', { name: 'Clear' }));
      await user.click(screen.getByRole('button', { name: 'Select all' }));
      expect(screen.getByRole('checkbox', { name: 'src/app.ts' })).toBeChecked();
      expect(keys).not.toBeChecked();
      // The hard-link exclusion says why, in words.
      expect(screen.getByText(/scripts\/shared-fixture\.txt \(Hard-linked file: has more than one hard link, so it may be a file from outside the project; never read\)/)).toBeInTheDocument();
    });

    it('ticking it asks to confirm sending it to the providers; cancel keeps it out; confirm sends acknowledgedSuspectedSecrets', async () => {
      const user = userEvent.setup();
      const { bridge } = renderApp(NEW_RUN, { scenario: 'suspected-secret' });
      await ready();
      await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Review the config');
      await screen.findByText('All checks passed. Ready to start.', {}, SLOW);
      const keys = screen.getByRole('checkbox', { name: KEYS });
      await user.click(keys);
      let dialog = await screen.findByRole('dialog', { name: 'Send this file to Anthropic and OpenAI?' });
      expect(dialog).toHaveTextContent(/Anthropic API key, line 4/);
      await user.click(within(dialog).getByRole('button', { name: 'Do not send it' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(keys).not.toBeChecked();

      await user.click(keys);
      dialog = await screen.findByRole('dialog', { name: 'Send this file to Anthropic and OpenAI?' });
      await user.click(within(dialog).getByRole('button', { name: 'Send this file' }));
      expect(screen.getByRole('checkbox', { name: KEYS })).toBeChecked();
      await waitFor(() => {
        expect(bridge.callsTo('relay/v1/runs.preflight').at(-1)?.input).toMatchObject({
          input: { acknowledgedSuspectedSecrets: [KEYS] },
        });
      }, SLOW);
      await screen.findByText('All checks passed. Ready to start.', {}, SLOW);
      await user.click(screen.getByRole('button', { name: 'Start run' }));
      await waitFor(() => {
        expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(1);
      });
      const input = bridge.callsTo('relay/v1/runs.start')[0]?.input as { input: { relPaths: string[]; acknowledgedSuspectedSecrets?: string[] } };
      expect(input.input.relPaths).toContain(KEYS);
      expect(input.input.acknowledgedSuspectedSecrets).toEqual([KEYS]);
    });

    it('unticking a confirmed file drops its acknowledgement', async () => {
      const user = userEvent.setup();
      const { bridge } = renderApp(NEW_RUN, { scenario: 'suspected-secret' });
      await ready();
      await user.click(await screen.findByRole('checkbox', { name: KEYS }));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Send this file' }));
      await user.click(screen.getByRole('checkbox', { name: KEYS }));
      await waitFor(() => {
        const last = bridge.callsTo('relay/v1/runs.preflight').at(-1)?.input as { input: Record<string, unknown> } | undefined;
        expect(last?.input['relPaths']).not.toContain(KEYS);
        expect(last?.input).not.toHaveProperty('acknowledgedSuspectedSecrets');
      }, SLOW);
    });

    it('a preflight suspected_secret issue links to the file checkbox', async () => {
      const user = userEvent.setup();
      const { bridge } = createBridgeWithIssue();
      renderApp(NEW_RUN, { bridge });
      await ready();
      const summary = await screen.findByRole('alert', { name: /1 problem prevents starting this run/ }, SLOW);
      const link = within(summary).getByRole('link', { name: 'src/app.ts looks like it contains a secret. Remove it or confirm sending it.' });
      expect(within(summary).getByText('suspected_secret')).toBeInTheDocument();
      await user.click(link);
      expect(screen.getByRole('checkbox', { name: 'src/app.ts' })).toHaveFocus();
      expect(screen.getByRole('checkbox', { name: 'src/app.ts' })).toHaveAccessibleDescription(/looks like it contains a secret/);
    });

    it('a runs.start suspected_secret denial links to the file checkbox (label and line, never a value)', async () => {
      const user = userEvent.setup();
      const { bridge } = renderApp(NEW_RUN, { scenario: 'suspected-secret' });
      await ready();
      await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Review the config');
      await user.click(await screen.findByRole('checkbox', { name: KEYS }));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Send this file' }));
      await screen.findByText('All checks passed. Ready to start.', {}, SLOW);
      bridge.failNext(
        'relay/v1/runs.start',
        errors.permissionDenied('suspected_secret', {
          details: { relPath: KEYS, denied: [{ relPath: KEYS, reason: 'suspected_secret', secretLabel: 'anthropic_key', secretLine: 4 }] },
        }),
      );
      await user.click(screen.getByRole('button', { name: 'Start run' }));
      const summary = await screen.findByRole('alert', { name: /1 problem prevents starting this run/ });
      const link = within(summary).getByRole('link', {
        name: `${KEYS} looks like it contains a secret (Anthropic API key, line 4). Untick it, or confirm sending it.`,
      });
      await user.click(link);
      expect(screen.getByRole('checkbox', { name: KEYS })).toHaveFocus();
    });
  });

  describe('unreadable-file (E2 #8)', () => {
    const CLIENT = 'src/db/client.ts';

    it('lists unreadable entries as not selectable, and "Exclude this file" leaves the failing file out of this run', async () => {
      const user = userEvent.setup();
      const { bridge } = renderApp(NEW_RUN, { scenario: 'unreadable-file' });
      await ready();
      expect(await screen.findByText('config/local.json')).toBeInTheDocument();
      expect(screen.getByText('Cannot be read (permissions)')).toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: 'config/local.json' })).not.toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: CLIENT })).toBeChecked();
      const summary = await screen.findByRole('alert', { name: /1 problem prevents starting this run/ }, SLOW);
      const link = within(summary).getByRole('link', { name: /Relay cannot read src\/db\/client\.ts/ });
      await user.click(link);
      expect(screen.getByRole('checkbox', { name: CLIENT })).toHaveFocus();
      await user.click(within(summary).getByRole('button', { name: 'Exclude this file' }));
      expect(screen.getByRole('checkbox', { name: CLIENT })).not.toBeChecked();
      await waitFor(() => {
        expect(screen.queryByRole('alert', { name: /problem/ })).not.toBeInTheDocument();
      }, SLOW);
      const last = bridge.callsTo('relay/v1/runs.preflight').at(-1)?.input as { input: { relPaths: string[] } };
      expect(last.input.relPaths).not.toContain(CLIENT);
      expect(bridge.callsTo('relay/v1/projects.update')).toHaveLength(0);
    });

    it('"Exclude from project" confirms, then saves the exclusion with projects.update (a CONFLICT reloads first)', async () => {
      const user = userEvent.setup();
      const { bridge } = renderApp(NEW_RUN, { scenario: 'unreadable-file' });
      await ready();
      const summary = await screen.findByRole('alert', { name: /1 problem prevents starting this run/ }, SLOW);
      const before = bridge.world.projects[0]?.exclusions ?? [];
      bridge.failNext('relay/v1/projects.update', appError('CONFLICT'));
      await user.click(within(summary).getByRole('button', { name: 'Exclude from project…' }));
      const dialog = await screen.findByRole('dialog', { name: 'Exclude this file from the project?' });
      expect(dialog).toHaveTextContent(/skipped in this and future runs/);
      await user.click(within(dialog).getByRole('button', { name: 'Exclude from project' }));
      expect(await within(dialog).findByText('The project settings changed meanwhile')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Exclude from project' }));
      await waitFor(() => {
        expect(bridge.callsTo('relay/v1/projects.update')).toHaveLength(2);
      });
      expect(bridge.callsTo('relay/v1/projects.update')[1]?.input).toMatchObject({
        patch: { exclusions: [...before, CLIENT] },
      });
      expect(bridge.world.projects[0]?.exclusions).toContain(CLIENT);
      await waitFor(() => {
        expect(screen.queryByRole('checkbox', { name: CLIENT })).not.toBeInTheDocument();
      }, SLOW);
      await waitFor(() => {
        expect(screen.queryByRole('alert', { name: /problem/ })).not.toBeInTheDocument();
      }, SLOW);
    });
  });
});

/** The suspected-secret world with an engine `suspected_secret` issue for the third selected file (src/app.ts). */
function createBridgeWithIssue() {
  const bridge = createFakeBridge('suspected-secret');
  bridge.world.preflightIssues = [
    { path: 'input.relPaths.2', code: 'suspected_secret', message: 'src/app.ts looks like it contains a secret. Remove it or confirm sending it.' },
  ];
  return { bridge };
}
