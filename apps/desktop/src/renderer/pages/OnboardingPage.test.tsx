import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { appError, errors } from '@relay/contracts';
import { createFakeBridge } from '../api/fake-bridge';
import type { FakeScenarioName } from '../api/fake-bridge';
import { renderApp } from '../features/testing/render-app';

const KEY = 'sk-ant-api03-SECRETSECRETSECRET-9x7Q';

async function heading(name: string | RegExp) {
  return screen.findByRole('heading', { level: 2, name });
}

async function clickContinue(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('OnboardingPage (J6)', () => {
  it('completes all 8 steps on the fake bridge: masked key, redacted label, key never in the DOM after submit', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp('/onboarding', { scenario: 'first-launch' });

    // 1 welcome
    await heading('Welcome to Relay');
    expect(screen.getByRole('heading', { level: 1, name: 'Set up Relay' })).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 8')).toBeInTheDocument();
    expect(screen.getByText(/Local storage does not make remote processing private/)).toBeInTheDocument();
    await clickContinue(user);

    // 2 start-point: the sample is the default choice → projects.createSample
    await heading('Choose a starting point');
    expect(screen.getByRole('radio', { name: 'Built-in sample project' })).toBeChecked();
    await clickContinue(user);

    // 3 connect-provider
    await heading('Connect a model provider');
    expect(bridge.callsTo('relay/v1/projects.createSample')).toHaveLength(1);
    const keyInput = screen.getByLabelText(/Anthropic API key/);
    expect(keyInput).toHaveAttribute('type', 'password');
    expect(keyInput).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.type(keyInput, KEY);
    await user.click(screen.getByRole('button', { name: 'Connect and test' }));
    const connected = await screen.findByText(/Connected to Anthropic/);
    expect(connected.closest('.banner')).toHaveTextContent('sk-ant-…9x7Q');
    expect(keyInput).toHaveValue('');
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(document.body.innerHTML).not.toContain('SECRETSECRET');
    expect(bridge.callsTo('relay/v1/providers.connect')[0]?.input).toMatchObject({
      providerId: 'anthropic',
      storage: 'os_protected',
    });
    expect(bridge.callsTo('relay/v1/providers.test')).toHaveLength(1);
    expect(screen.getByText('A second provider is optional for setup')).toBeInTheDocument();
    await clickContinue(user);

    // 4 select-project: skipped for the sample, but its preview is shown
    await heading('The sample project');
    expect(await screen.findByText(/9 included · 4 excluded/)).toBeInTheDocument();
    expect(screen.getByText('Excluded: Possible secret')).toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/projects.pickDirectory')).toHaveLength(0);
    await clickContinue(user);

    // 5 add-rule → memory.create (user_rule)
    await heading('Add one project rule');
    const rule = screen.getByRole('textbox', { name: /Rule/ });
    expect(rule).toHaveAttribute('placeholder', 'Preserve the existing public response format');
    await user.type(rule, 'Preserve the existing public response format. Do not rename fields.');
    await user.click(screen.getByRole('button', { name: 'Save rule and continue' }));

    // 6 choose-template
    await heading('Choose a workflow template');
    expect(bridge.callsTo('relay/v1/memory.create')[0]?.input).toMatchObject({
      type: 'user_rule',
      title: 'Preserve the existing public response format',
      scope: { roles: 'all' },
    });
    expect(await screen.findByRole('radio', { name: /Review & propose a fix · v3/ })).toBeChecked();
    await clickContinue(user);

    // 7 profiles-and-allowance (run allowance defaults to $3.00)
    await heading('Pick role profiles and a run allowance');
    expect(await screen.findByRole('table', { name: 'Model profile for each role' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Run allowance/)).toHaveValue('3.00');
    // Only Anthropic is connected: move the roles whose default profile uses OpenAI to an Anthropic profile.
    await useAnthropicOnly(user);
    await clickContinue(user);

    // 8 review-and-start
    await heading('Review the input and start');
    expect(await screen.findByText('First reservation')).toBeInTheDocument();
    await user.click(await startEnabled());
    await waitFor(() => {
      expect(router.state.location.pathname).toMatch(/^\/p\/prj_\w+\/runs\/run_\w+$/);
    });
    const start = bridge.callsTo('relay/v1/runs.start');
    expect(start).toHaveLength(1);
    expect(start[0]?.input).toMatchObject({
      input: { kind: 'files' },
      limitOverrides: { budgetMicrousd: 3_000_000 },
    });
    expect(bridge.world.settings.onboardingCompletedAt).not.toBeNull();
    expect(bridge.world.settings.activeProjectId).toBe(bridge.world.projects[0]?.id);
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it('review-and-start: a role whose provider has no key blocks Start with a "Connect provider" way back (06 F14)', async () => {
    const user = userEvent.setup();
    const { bridge } = await walkToReview(user, { scenario: 'missing-credential' });
    expect(await screen.findByText('2 problems prevent starting', {}, SLOW)).toBeInTheDocument();
    expect(screen.getAllByText(/no API key is connected for OpenAI/)).toHaveLength(2);
    expect(screen.getAllByText('missing_credential')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Connect provider' }));
    await heading('Connect a model provider');
    expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(0);
  });

  it('own folder, session key, and a rule step that stays skippable when memory.create fails (generic ErrorView)', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/onboarding/start-point', { scenario: 'first-launch' });
    bridge.world.notImplemented.add('memory.create'); // a future stubbed runner channel
    await heading('Choose a starting point');
    await user.click(screen.getByRole('radio', { name: 'My own project folder' }));
    await clickContinue(user);

    await heading('Connect a model provider');
    await user.click(screen.getByRole('radio', { name: 'Session only' }));
    await user.type(screen.getByLabelText(/Anthropic API key/), KEY);
    await user.click(screen.getByRole('button', { name: 'Connect and test' }));
    expect(await screen.findByText(/Connected to Anthropic/)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(bridge.callsTo('relay/v1/providers.connect')[0]?.input).toMatchObject({ storage: 'session' });
    await clickContinue(user);

    await heading('Select the project folder');
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }));
    expect(await screen.findByText('~/code/my-api')).toBeInTheDocument();
    expect(await screen.findByText(/9 included/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Project name/ })).toHaveValue('my-api');
    const providers = screen.getByRole('group', { name: 'Providers allowed to receive selected context' });
    expect(within(providers).getByRole('checkbox', { name: 'Anthropic' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Create project and continue' }));

    await heading('Add one project rule');
    expect(bridge.callsTo('relay/v1/projects.create')[0]?.input).toMatchObject({
      name: 'my-api',
      allowedProviderIds: ['anthropic'],
    });
    await user.type(screen.getByRole('textbox', { name: /Rule/ }), 'Keep handlers thin.');
    await user.click(screen.getByRole('button', { name: 'Save rule and continue' }));
    const alert = (await screen.findByText('This feature is not available in this build yet.')).closest('[role="alert"]') as HTMLElement;
    expect(alert).toHaveTextContent('INTERNAL');
    expect(screen.queryByText(/Not available yet/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await heading('Choose a workflow template');
  });

  it('offers only session-only storage when secure storage is unavailable (never plaintext)', async () => {
    renderApp('/onboarding/connect-provider', { scenario: 'no-secure-storage' });
    await heading('Connect a model provider');
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Store with macOS Keychain protection' })).toBeDisabled();
    });
    expect(screen.getByRole('radio', { name: 'Session only' })).toBeChecked();
    expect(screen.getByText(/never stores keys in plaintext/)).toBeInTheDocument();
  });

  it('redirects an unknown step to welcome', async () => {
    const { router } = renderApp('/onboarding/nope', { scenario: 'first-launch' });
    await heading('Welcome to Relay');
    expect(router.state.location.pathname).toBe('/onboarding/welcome');
  });

  // ----- Referee regressions -----

  it('B1: the API key never enters the query client (mutation or query cache), pending or settled', async () => {
    const user = userEvent.setup();
    const { bridge, queryClient } = renderApp('/onboarding/connect-provider', { scenario: 'first-launch' });
    await heading('Connect a model provider');
    const cached = () =>
      JSON.stringify([
        queryClient.getMutationCache().getAll().map((m) => m.state),
        queryClient.getQueryCache().getAll().map((q) => [q.queryKey, q.state.data]),
      ]);
    const keyInput = await screen.findByLabelText(/Anthropic API key/);
    const release = bridge.hold('relay/v1/providers.connect');
    await user.type(keyInput, KEY);
    await user.click(screen.getByRole('button', { name: 'Connect and test' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/providers.connect')).toHaveLength(1);
    });
    expect(cached()).not.toContain('SECRETSECRET');
    release();
    expect(await screen.findByText(/Connected to Anthropic/)).toBeInTheDocument();
    expect(cached()).not.toContain('SECRETSECRET');
    expect(bridge.callsTo('relay/v1/providers.connect')[0]?.input).toMatchObject({ apiKey: KEY });
  });

  it('B2: a second Start after runs.start succeeded never creates a second run', async () => {
    const user = userEvent.setup();
    const { bridge, router } = await walkToReview(user);
    const startButton = await startEnabled();
    const releaseSettings = bridge.hold('relay/v1/app.updateSettings');
    await user.click(startButton);
    // runs.start has succeeded once the post-success settings write is in flight.
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/app.updateSettings')).toHaveLength(1);
    });
    fireEvent.click(startButton);
    fireEvent.click(startButton);
    releaseSettings();
    await waitFor(() => {
      expect(router.state.location.pathname).toMatch(/^\/p\/prj_\w+\/runs\/run_\w+$/);
    });
    await waitFor(() => {
      expect(bridge.world.settings.onboardingCompletedAt).not.toBeNull();
    });
    expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(1);
  });

  it('B3: Start waits for the preflight of the goal being submitted', async () => {
    const user = userEvent.setup();
    const { bridge } = await walkToReview(user);
    await startEnabled();
    const goal = screen.getByRole('textbox', { name: /Goal/ });
    await user.clear(goal);
    await user.type(goal, 'A goal that was never checked');
    const start = screen.getByRole('button', { name: 'Start run' });
    expect(start).toBeDisabled();
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    fireEvent.submit(start.closest('form') as HTMLFormElement);
    expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(0);
    await startEnabled();
    expect(bridge.callsTo('relay/v1/runs.preflight').at(-1)?.input).toMatchObject({
      goal: 'A goal that was never checked',
    });
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/runs.start')[0]?.input).toMatchObject({
      goal: 'A goal that was never checked',
    });
  });

  it('B3: a BUDGET_BLOCKED preflight shows the breakdown and blocks Start', async () => {
    const user = userEvent.setup();
    const { bridge } = await walkToReview(user, {
      beforeReview: (b) => {
        b.failNext(
          'relay/v1/runs.preflight',
          errors.budgetBlocked({
            L: 3_000_000,
            C: 1_200_000,
            R: 400_000,
            U: 0,
            N: 1_500_000,
            scope: 'run',
            total: 3_100_000,
            allowed: false,
          } as never),
        );
      },
    });
    expect(await screen.findByText('The run allowance would be exceeded', {}, SLOW)).toBeInTheDocument();
    expect(screen.getByText('$3.10 > $3.00 → blocked')).toBeInTheDocument();
    const start = screen.getByRole('button', { name: 'Start run' });
    expect(start).toBeDisabled();
    expect(screen.getByText('Blocked by the run allowance. Go back and raise it.')).toBeInTheDocument();
    fireEvent.submit(start.closest('form') as HTMLFormElement);
    expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(0);
  });

  it('B5: a start error next action routes (AUTH_REQUIRED → Settings → Providers) and never re-sends runs.start', async () => {
    const user = userEvent.setup();
    const { bridge, router } = await walkToReview(user);
    await startEnabled();
    bridge.failNext('relay/v1/runs.start', errors.authRequired('anthropic'));
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await user.click(await screen.findByRole('button', { name: 'Reconnect provider' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/providers');
    });
    expect(bridge.callsTo('relay/v1/runs.start')).toHaveLength(1);
  });

  it('B8: a rule saved for the sample is not shown as saved for my own folder', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/onboarding/start-point', { scenario: 'awaiting-approval' });
    await heading('Choose a starting point');
    await clickContinue(user);
    await heading('Connect a model provider');
    await continueWhenEnabled(user);
    await heading('The sample project');
    await clickContinue(user);
    await heading('Add one project rule');
    await user.type(screen.getByRole('textbox', { name: /Rule/ }), 'Keep handlers thin.');
    await user.click(screen.getByRole('button', { name: 'Save rule and continue' }));
    await heading('Choose a workflow template');

    await act(() => router.navigate('/onboarding/start-point'));
    await heading('Choose a starting point');
    await user.click(screen.getByRole('radio', { name: 'My own project folder' }));
    await clickContinue(user);
    await heading('Connect a model provider');
    await continueWhenEnabled(user);
    await heading('Select the project folder');
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await screen.findByText('~/code/my-api');
    await user.click(screen.getByRole('button', { name: 'Create project and continue' }));
    await heading('Add one project rule');
    expect(screen.queryByText('Rule saved')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save rule and continue' })).toBeInTheDocument();
  });

  it('B10: NOT_FOUND from projects.create clears the folder choice and a new choice uses a new key', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/onboarding/select-project', { scenario: 'awaiting-approval' });
    await heading('Select the project folder');
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await screen.findByText('~/code/my-api');
    bridge.failNext('relay/v1/projects.create', appError('NOT_FOUND'));
    await user.click(screen.getByRole('button', { name: 'Create project and continue' }));
    expect(await screen.findByText('Choose the folder again')).toBeInTheDocument();
    expect(screen.queryByText('~/code/my-api')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await screen.findByText('~/code/my-api');
    await user.click(screen.getByRole('button', { name: 'Create project and continue' }));
    await heading('Add one project rule');
    const [first, second] = bridge.callsTo('relay/v1/projects.create').map(
      (c) => c.input as { idempotencyKey: string; selectionId: string },
    );
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);
    expect(second?.selectionId).not.toBe(first?.selectionId);
  });

  it('B10: an expired folder choice is never sent to projects.create', async () => {
    const user = userEvent.setup();
    // The fake clock is 11 minutes behind: pickDirectory's 10-minute selection is already expired.
    const bridge = createFakeBridge('awaiting-approval', { now: () => Date.now() - 11 * 60_000 });
    renderApp('/onboarding/select-project', { bridge });
    await heading('Select the project folder');
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await screen.findByText('~/code/my-api');
    await user.click(screen.getByRole('button', { name: 'Create project and continue' }));
    expect(await screen.findByText('Choose the folder again')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose folder…' })).toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/projects.create')).toHaveLength(0);
  });

  it('B12: a step change by keyboard focuses the new heading and announces "Step N of 8"', async () => {
    const user = userEvent.setup();
    renderApp('/onboarding', { scenario: 'first-launch' });
    await heading('Welcome to Relay');
    screen.getByRole('button', { name: 'Continue' }).focus();
    await user.keyboard('{Enter}');
    const next = await heading('Choose a starting point');
    await waitFor(() => {
      expect(next).toHaveFocus();
    });
    expect(screen.getByTestId('live-region')).toHaveTextContent('Step 2 of 8: Choose a starting point');
  });
});

const SLOW = { timeout: 3000 };

async function continueWhenEnabled(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });
  await clickContinue(user);
}

/** Selects the Anthropic "Capable" profile for every role whose current profile uses OpenAI (step 7 table). */
async function useAnthropicOnly(user: ReturnType<typeof userEvent.setup>) {
  const table = await screen.findByRole('table', { name: 'Model profile for each role' });
  for (const select of within(table).getAllByRole('combobox')) {
    const chosen = (select as HTMLSelectElement).selectedOptions[0]?.textContent ?? '';
    if (chosen.includes('OpenAI')) await user.selectOptions(select, within(select).getByRole('option', { name: /^Capable · Anthropic/ }));
  }
}

/** Walks the sample flow (a provider is already connected) to review-and-start. */
async function walkToReview(
  user: ReturnType<typeof userEvent.setup>,
  opts: { scenario?: FakeScenarioName; beforeReview?: (b: ReturnType<typeof renderApp>['bridge']) => void } = {},
) {
  const result = renderApp('/onboarding/start-point', { scenario: opts.scenario ?? 'awaiting-approval' });
  await heading('Choose a starting point');
  await clickContinue(user);
  await heading('Connect a model provider');
  await continueWhenEnabled(user);
  await heading('The sample project');
  await clickContinue(user);
  await heading('Add one project rule');
  await user.click(screen.getByRole('button', { name: 'Skip for now' }));
  await heading('Choose a workflow template');
  await screen.findByRole('radio', { name: /Review & propose a fix · v3/ });
  await clickContinue(user);
  await heading('Pick role profiles and a run allowance');
  await screen.findByRole('table', { name: 'Model profile for each role' });
  opts.beforeReview?.(result.bridge);
  await clickContinue(user);
  await heading('Review the input and start');
  return result;
}

/** The Start button once the preflight of the current input has passed. */
async function startEnabled() {
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Start run' })).toBeEnabled();
  }, SLOW);
  return screen.getByRole('button', { name: 'Start run' });
}
