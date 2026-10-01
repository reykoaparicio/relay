import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { appError } from '@relay/contracts';
import { FAKE_PROJECT_ID } from '../api/fake-bridge';
import { PROFILES } from '../api/fake-scenarios/world';
import { renderApp } from '../features/testing/render-app';

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
    expect(await screen.findByText('All checks passed. Ready to start.', {}, SLOW)).toBeInTheDocument();
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
    const plan = screen.getByRole('combobox', { name: /Planner profile \(Plan step\)/ });
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
    expect(screen.getByRole('button', { name: 'Start run' })).toBeEnabled();
  });

  it('double submit sends a single runs.start with one idempotency key; overrides and memory ids are exact', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    await ready();
    await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Review input validation');
    // Change only the plan step's profile (default Balanced → Economy).
    await user.selectOptions(
      screen.getByRole('combobox', { name: /Planner profile \(Plan step\)/ }),
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
    const alert = (await screen.findByText('This feature is not available in this build yet.')).closest('[role="alert"]') as HTMLElement;
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
      screen.getByRole('combobox', { name: /Planner profile \(Plan step\)/ }),
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
    expect(await screen.findByText('All checks passed. Ready to start.', {}, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeEnabled();
  });

  it('B5: a preflight error next action routes (Restart runner → diagnostics) and never starts the run', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    bridge.failNext('relay/v1/runs.preflight', appError('RUNNER_UNAVAILABLE'));
    await ready();
    await user.click(await screen.findByRole('button', { name: 'Restart runner' }, SLOW));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/diagnostics');
    });
    expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(0);
  });

  it('B5: a runs.start RUNNER_UNAVAILABLE next action opens diagnostics and never re-sends runs.start', async () => {
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
      expect(router.state.location.pathname).toBe('/settings/diagnostics');
    });
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
});
