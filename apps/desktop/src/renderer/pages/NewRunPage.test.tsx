import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    // Starting anyway: runs.start answers VALIDATION_FAILED with the same issues; they are not listed twice.
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /Goal/ }), 'Try anyway');
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(1);
    });
    expect(
      await screen.findByRole('alert', { name: /3 problems prevent starting this run/ }),
    ).toBeInTheDocument();
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
    // A pinned rule is checked and locked; tick one non-pinned record.
    expect(
      screen.getByRole('checkbox', { name: 'Preserve the existing public response format' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: 'Preserve the existing public response format' }),
    ).toBeChecked();
    await user.click(await screen.findByRole('checkbox', { name: 'Keep handlers thin' }));

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
    const keep = bridge.world.memory.find((m) => m.title === 'Keep handlers thin');
    expect(input['memoryRecordIds']).toEqual([keep?.id]);
    expect(input).not.toHaveProperty('limitOverrides');
    expect(input['goal']).toBe('Review input validation');
  });

  it('memory.list not implemented in this build: says so and keeps the form usable', async () => {
    const { bridge } = renderApp(NEW_RUN, { scenario: 'awaiting-approval' });
    bridge.world.notImplemented.add('memory.list');
    await ready();
    expect(await screen.findByText('Not available yet in this build')).toBeInTheDocument();
    expect(screen.getByText(/Pinned project rules are still included/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeEnabled();
  });
});
