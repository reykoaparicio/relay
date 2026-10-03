import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { installBridge } from '../../api/bridge';
import { createFakeBridge, FAKE_PROJECT_ID } from '../../api/fake-bridge';
import { sid } from '../../api/fake-scenarios/world';
import { renderWithProviders } from '../../components/ui/test-utils';
import { RunSuggestionsLink } from './RunSuggestionsLink';

describe('RunSuggestionsLink (audit #22, #31)', () => {
  it('links the memory suggestions a run proposed to the Suggested tab', async () => {
    const bridge = createFakeBridge('awaiting-approval');
    installBridge(bridge);
    const runId = sid('run', 23);
    const fromRun = bridge.world.memory.filter(
      (r) => r.status === 'suggested' && r.source.kind === 'run' && r.source.runId === runId,
    );
    expect(fromRun.length).toBeGreaterThan(0);
    renderWithProviders(
      <MemoryRouter>
        <RunSuggestionsLink projectId={FAKE_PROJECT_ID} runId={runId} />
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: /^Review suggestions?$/ });
    expect(link.getAttribute('href')).toContain('tab=suggested');
  });

  it('renders nothing for a run that proposed none', async () => {
    installBridge(createFakeBridge('awaiting-approval'));
    renderWithProviders(
      <MemoryRouter>
        <RunSuggestionsLink projectId={FAKE_PROJECT_ID} runId={sid('run', 1)} />
      </MemoryRouter>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('link', { name: /Review suggestion/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/from this run/)).not.toBeInTheDocument();
  });
});
