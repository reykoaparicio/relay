import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, describeViolations } from '../components/ui/test-utils';
import { FAKE_PROJECT_ID } from '../api/fake-bridge';
import type { FakeScenarioName } from '../api/fake-bridge';
import { sid } from '../api/fake-scenarios/world';
import { renderApp } from '../features/testing/render-app';

interface PageCase {
  readonly name: string;
  readonly path: string;
  readonly scenario: FakeScenarioName;
  /** Text that proves the page's primary content rendered. */
  readonly ready: RegExp | string;
}

const P = `/p/${FAKE_PROJECT_ID}`;

const CASES: readonly PageCase[] = [
  { name: 'Overview awaiting-approval', path: P, scenario: 'awaiting-approval', ready: 'Needs your attention' },
  { name: 'Overview active-run', path: P, scenario: 'active-run', ready: 'Active run' },
  { name: 'Overview empty', path: P, scenario: 'empty', ready: 'Start your first run' },
  { name: 'Overview interrupted', path: P, scenario: 'interrupted', ready: 'Recovery' },
  { name: 'Overview provider-disconnected', path: P, scenario: 'provider-disconnected', ready: 'Authentication failed for OpenAI' },
  { name: 'Runs list', path: `${P}/runs`, scenario: 'awaiting-approval', ready: /Runs in Example API/ },
  { name: 'Runs filtered', path: `${P}/runs?status=attention`, scenario: 'budget-paused', ready: /Runs in Example API/ },
  { name: 'Runs empty', path: `${P}/runs`, scenario: 'empty', ready: 'No runs yet' },
  { name: 'Memory approved', path: `${P}/memory`, scenario: 'awaiting-approval', ready: 'Revision history' },
  { name: 'Memory suggestions', path: `${P}/memory?tab=suggested`, scenario: 'awaiting-approval', ready: /Review queue: 2 suggestions/ },
  { name: 'Memory archived', path: `${P}/memory?tab=archived`, scenario: 'awaiting-approval', ready: /Superseded by/ },
  { name: 'Memory conflict', path: `${P}/memory`, scenario: 'memory-conflict', ready: 'Two records give incompatible instructions' },
  { name: 'Memory stale-source', path: `${P}/memory?record=${sid('memory', 4)}`, scenario: 'memory-stale', ready: 'Source changed since approval' },
  { name: 'Workflow editor editing', path: `${P}/workflows/${sid('workflow', 1)}`, scenario: 'awaiting-approval', ready: 'Ordered steps' },
  { name: 'Workflow editor draft', path: `${P}/workflows/${sid('workflow', 1)}`, scenario: 'workflow-draft', ready: /Draft revision 1 · based on v3/ },
  { name: 'Onboarding welcome', path: '/onboarding', scenario: 'first-launch', ready: 'Welcome to Relay' },
  { name: 'Onboarding start-point', path: '/onboarding/start-point', scenario: 'first-launch', ready: 'Choose a starting point' },
  { name: 'Onboarding connect-provider', path: '/onboarding/connect-provider', scenario: 'first-launch', ready: 'Where to keep the key' },
  { name: 'Onboarding select-project', path: '/onboarding/select-project', scenario: 'first-launch', ready: 'Choose folder…' },
  { name: 'Onboarding add-rule (missing project)', path: '/onboarding/add-rule', scenario: 'first-launch', ready: 'Choose a project first' },
  { name: 'Onboarding choose-template', path: '/onboarding/choose-template', scenario: 'first-launch', ready: /Review & propose a fix · v3/ },
  { name: 'New run ready', path: `${P}/runs/new`, scenario: 'awaiting-approval', ready: 'Checks passed. Enter a goal to start.' },
  { name: 'New run validation-errors', path: `${P}/runs/new`, scenario: 'validation-errors', ready: 'Fix 3 problems to start.' },
  { name: 'New run budget-blocked', path: `${P}/runs/new`, scenario: 'budget-blocked', ready: '$3.10 > $3.00 → blocked' },
  { name: 'Settings providers', path: '/settings/providers', scenario: 'awaiting-approval', ready: /Model catalog, version/ },
  { name: 'Settings no-secure-storage', path: '/settings/providers', scenario: 'no-secure-storage', ready: 'OS credential protection is unavailable' },
  { name: 'Settings auth-failed', path: '/settings/providers', scenario: 'auth-failed', ready: 'OpenAI rejected the stored key' },
  { name: 'Settings diagnostics', path: '/settings/diagnostics', scenario: 'awaiting-approval', ready: 'Runner heartbeat' },
  { name: 'Settings profiles', path: '/settings/profiles', scenario: 'awaiting-approval', ready: 'Default max output' },
  { name: 'Settings projects', path: '/settings/projects', scenario: 'awaiting-approval', ready: 'Store responses at OpenAI' },
  { name: 'Settings data', path: '/settings/data', scenario: 'awaiting-approval', ready: 'Retention and setup allowance' },
  { name: 'Settings about', path: '/settings/about', scenario: 'awaiting-approval', ready: /local desktop prototype/ },
];

const RUN = (n: number) => `${P}/runs/${sid('run', n)}`;

/** Every run-inspector mock state (10 J5), ready when the step tabs render. */
const INSPECTOR_STATES: ReadonlyArray<readonly [FakeScenarioName, number]> = [
  ['awaiting-approval', 24],
  ['running-streaming', 25],
  ['budget-paused', 24],
  ['budget-paused-project', 24],
  ['budget-overrun', 24],
  ['unknown-outcome', 24],
  ['schema-invalid', 24],
  ['output-invalid', 24],
  ['provider-unavailable', 24],
  ['setup-blocked', 24],
  ['refused', 24],
  ['rate-limited', 24],
  ['paused-user', 24],
  ['paused-limit', 24],
  ['paused-deadline', 24],
  ['auth-failed', 24],
  ['approval-stale', 24],
  ['interrupted', 24],
  ['cancelling', 24],
  ['cancelled', 24],
  ['failed', 24],
  ['completed', 24],
  ['incomplete', 24],
];

const INSPECTOR_CASES: readonly PageCase[] = INSPECTOR_STATES.map(([scenario, n]) => ({
  name: `Run inspector ${scenario}`,
  path: RUN(n),
  scenario,
  ready: 'Timeline',
}));

const REPORT_CASES: readonly PageCase[] = [
  { name: 'Report report', path: `${RUN(24)}/report`, scenario: 'completed', ready: 'Limitations' },
  { name: 'Report patch', path: `${RUN(24)}/report?tab=patch`, scenario: 'completed', ready: 'Files in patch' },
  { name: 'Report incomplete-report', path: `${RUN(24)}/report`, scenario: 'incomplete-report', ready: 'Limitations' },
  { name: 'Report incomplete-report (cancelled)', path: `${RUN(24)}/report`, scenario: 'cancelled', ready: 'Limitations' },
];

describe('page accessibility (axe, J11)', () => {
  it.each([...CASES, ...INSPECTOR_CASES, ...REPORT_CASES])('$name has no axe violations, a skip link, and exactly one h1', async ({ path, scenario, ready }) => {
    const { container } = renderApp(path, { scenario });
    await screen.findAllByText(ready, {}, { timeout: 3000 });
    // Let secondary queries (badges, provider line) settle so axe sees the final DOM.
    await waitFor(() => {
      expect(screen.queryAllByText(/providers? connected/).length).toBeGreaterThan(0);
    });
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    const results = await axe(container);
    expect(describeViolations(results)).toEqual([]);
  });
});

/** Mock states reached by interaction (memory edit / delete-confirm / conflict, workflow validation-errors / validated). */
interface InteractiveCase {
  readonly name: string;
  readonly path: string;
  readonly scenario: FakeScenarioName;
  readonly act: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
}

const WF = `${P}/workflows/${sid('workflow', 1)}`;

const INTERACTIVE_CASES: readonly InteractiveCase[] = [
  {
    name: 'Memory edit',
    path: `${P}/memory?record=${sid('memory', 3)}`,
    scenario: 'awaiting-approval',
    act: async (user) => {
      await user.click(await screen.findByRole('button', { name: 'Edit' }));
      await screen.findByText(/Saving creates revision 2/);
    },
  },
  {
    name: 'Memory delete-confirm',
    path: `${P}/memory?record=${sid('memory', 3)}`,
    scenario: 'awaiting-approval',
    act: async (user) => {
      await user.click(await screen.findByRole('button', { name: 'Delete…' }));
      await screen.findByRole('dialog');
    },
  },
  {
    name: 'Memory conflict panel',
    path: `${P}/memory`,
    scenario: 'memory-conflict',
    act: async (user) => {
      await user.click(await screen.findByRole('button', { name: 'Resolve conflict' }));
      await screen.findByText('Record A');
    },
  },
  {
    name: 'Memory add rule dialog',
    path: `${P}/memory`,
    scenario: 'awaiting-approval',
    act: async (user) => {
      await screen.findByText('Revision history');
      await user.click(screen.getAllByRole('button', { name: 'Add project rule' })[0] as HTMLElement);
      await screen.findByRole('dialog');
    },
  },
  {
    name: 'Workflow editor validation-errors',
    path: WF,
    scenario: 'validation-errors',
    act: async (user) => {
      await user.click(await screen.findByRole('button', { name: 'Validate' }));
      await screen.findByText(/4 problems prevent/);
    },
  },
  {
    name: 'Workflow editor validated',
    path: WF,
    scenario: 'workflow-draft',
    act: async (user) => {
      await user.click(await screen.findByRole('button', { name: 'Validate' }));
      await user.click(await screen.findByRole('button', { name: 'Publish as v4' }));
      await screen.findByText(/v4 validated/);
    },
  },
  {
    name: 'Settings purge dialog',
    path: '/settings/data',
    scenario: 'awaiting-approval',
    act: async (user) => {
      await user.click(await screen.findByRole('button', { name: 'Purge project history…' }));
      await screen.findByRole('dialog');
    },
  },
];

describe('interactive page states (axe, J11)', () => {
  it.each(INTERACTIVE_CASES)('$name has no axe violations', async ({ path, scenario, act }) => {
    const user = userEvent.setup();
    renderApp(path, { scenario });
    await act(user);
    await waitFor(() => {
      expect(screen.queryAllByText(/providers? connected/).length).toBeGreaterThan(0);
    });
    const results = await axe(document.body);
    expect(describeViolations(results)).toEqual([]);
  });
});
