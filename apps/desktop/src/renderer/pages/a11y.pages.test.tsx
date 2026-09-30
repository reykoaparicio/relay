import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { axe, describeViolations } from '../components/ui/test-utils';
import { FAKE_PROJECT_ID } from '../api/fake-bridge';
import type { FakeScenarioName } from '../api/fake-bridge';
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
  { name: 'Memory placeholder', path: `${P}/memory`, scenario: 'completed', ready: 'Coming soon' },
];

describe('page accessibility (axe, J11)', () => {
  it.each(CASES)('$name has no axe violations, a skip link, and exactly one h1', async ({ path, scenario, ready }) => {
    const { container } = renderApp(path, { scenario });
    await screen.findAllByText(ready);
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
