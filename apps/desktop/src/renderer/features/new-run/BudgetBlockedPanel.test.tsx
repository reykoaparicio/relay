import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { BudgetBreakdown } from '@relay/contracts';
import { renderWithProviders } from '../../components/ui/test-utils';
import { BudgetBlockedPanel } from './BudgetBlockedPanel';

const BASE = { L: 3_000_000, C: 1_200_000, R: 400_000, U: 0, N: 1_500_000, scope: 'run', total: 3_100_000, allowed: false } as BudgetBreakdown;

function panel(budget: BudgetBreakdown) {
  return (
    <MemoryRouter>
      <BudgetBlockedPanel budget={budget} projectId="prj_1" onSetAllowance={() => undefined} onChooseProfile={() => undefined} />
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
});
