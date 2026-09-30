import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    await clickContinue(user);

    // 8 review-and-start
    await heading('Review the input and start');
    expect(await screen.findByText('First reservation')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start run' }));
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

  it('works against the M1 runner stubs: own folder, "saved (not tested)" key, and a skippable rule step', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/onboarding/start-point', { scenario: 'backend-stubs' });
    await heading('Choose a starting point');
    await user.click(screen.getByRole('radio', { name: 'My own project folder' }));
    await clickContinue(user);

    await heading('Connect a model provider');
    await user.click(screen.getByRole('radio', { name: 'Session only' }));
    await user.type(screen.getByLabelText(/Anthropic API key/), KEY);
    await user.click(screen.getByRole('button', { name: 'Connect and test' }));
    expect(await screen.findByText(/Anthropic key saved \(not tested\)/)).toBeInTheDocument();
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
    expect(await screen.findByText('Not available yet in this build')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue without a rule' }));
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
});
