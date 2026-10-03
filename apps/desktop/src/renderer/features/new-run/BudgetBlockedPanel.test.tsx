import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { BudgetBreakdown, ProfileWithWarnings, Project } from '@relay/contracts';
import { installBridge } from '../../api/bridge';
import { createFakeBridge } from '../../api/fake-bridge';
import { renderWithProviders } from '../../components/ui/test-utils';
import { PROFILES } from '../../api/fake-scenarios/world';
import type { ModelStepRow } from '../run-setup/model-steps';
import { BudgetBlockedPanel } from './BudgetBlockedPanel';

const BASE = { L: 3_000_000, C: 1_200_000, R: 400_000, U: 0, N: 1_500_000, scope: 'run', total: 3_100_000, allowed: false } as BudgetBreakdown;
const PROJECT = {
  id: 'prj_01HZX0000000000000000000P1',
  name: 'Example API',
  rootDisplayPath: '~/code/example-api',
  exclusions: [],
  providerPolicy: { allowedProviderIds: ['anthropic'] },
  monthlyAllowanceMicrousd: 20_000_000,
  isDemo: false,
  createdAt: 1,
  updatedAt: 2,
  archivedAt: null,
} as unknown as Project;
const PROFILE_LIST = [PROFILES.economy, PROFILES.balanced].map((p) => ({
  profile: { ...p, params: { maxOutputTokens: 8_000, refusalFallback: 'default' }, revision: 1, updatedAt: 1 },
  warnings: [],
})) as unknown as readonly ProfileWithWarnings[];
const ROWS: readonly ModelStepRow[] = [
  { stepKey: 'review', role: 'reviewer', specProfile: 'Balanced', defaultProfileId: PROFILES.balanced.id, maxOutputTokens: undefined },
];

function panel(
  budget: BudgetBreakdown,
  handlers: { onSelectProfile?: (k: string, id: string) => void; onSaved?: () => void } = {},
  selection: Readonly<Record<string, string>> = {},
) {
  return (
    <MemoryRouter>
      <BudgetBlockedPanel
        budget={budget}
        project={PROJECT}
        rows={ROWS}
        profiles={PROFILE_LIST}
        selection={selection}
        onSetAllowance={() => undefined}
        onSelectProfile={handlers.onSelectProfile ?? (() => undefined)}
        onProjectAllowanceSaved={handlers.onSaved ?? (() => undefined)}
      />
    </MemoryRouter>
  );
}

describe('BudgetBlockedPanel (B11)', () => {
  it('the suggested allowance follows the current breakdown', () => {
    const { rerender } = renderWithProviders(panel(BASE));
    expect(screen.getByRole('textbox', { name: /New run allowance/ })).toHaveValue('3.10');
    rerender(panel({ ...BASE, N: 2_400_000, total: 4_000_000 } as BudgetBreakdown));
    expect(screen.getByRole('textbox', { name: /New run allowance/ })).toHaveValue('4.00');
  });

  it('switches the first step’s profile inline', async () => {
    const onSelectProfile = vi.fn();
    renderWithProviders(panel(BASE, { onSelectProfile }));
    const select = screen.getByRole('combobox', { name: /Profile for Review input/ });
    expect(select).toHaveValue(PROFILES.balanced.id);
    await userEvent.selectOptions(select, PROFILES.economy.id);
    expect(onSelectProfile).toHaveBeenCalledWith('review', PROFILES.economy.id);
  });

  it('lists only profiles whose provider the project allows, with the reservation of the current one', () => {
    // The project allows Anthropic only: the OpenAI profile is not offered once it is not the current choice.
    renderWithProviders(panel(BASE, {}, { review: PROFILES.economy.id }));
    const select = screen.getByRole('combobox', { name: /Profile for Review input/ });
    const labels = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(labels).toEqual(['Economy · Anthropic · reserves $1.50 now']);
  });

  it('a current profile whose provider is not allowed stays listed, marked', () => {
    renderWithProviders(panel(BASE));
    const select = screen.getByRole('combobox', { name: /Profile for Review input/ });
    const labels = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(labels).toEqual(['Economy · Anthropic', 'Balanced · OpenAI · not allowed by this project']);
  });

  it('project scope: saves the monthly allowance inline with projects.update, then re-checks', async () => {
    const bridge = createFakeBridge('awaiting-approval');
    installBridge(bridge);
    const onSaved = vi.fn();
    renderWithProviders(panel({ ...BASE, L: 20_000_000, total: 20_240_000, scope: 'project' } as BudgetBreakdown, { onSaved }));
    const input = screen.getByRole('textbox', { name: /New monthly allowance/ });
    expect(input).toHaveValue('20.24');
    await userEvent.click(screen.getByRole('button', { name: 'Save and re-check' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/projects.update').at(-1)?.input).toMatchObject({
        projectId: PROJECT.id,
        patch: { monthlyAllowanceMicrousd: 20_240_000 },
      });
    });
    expect(within(screen.getByRole('region', { name: /Admission check/ })).getByRole('link', { name: 'edit it in Settings' })).toBeInTheDocument();
  });
});
