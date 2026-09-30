import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { budgetBreakdown } from '../test-fixtures';
import { BudgetBreakdownTable } from './BudgetBreakdownTable';

describe('BudgetBreakdownTable', () => {
  it('spells out the admission inequality with cents when they already differ', () => {
    render(<BudgetBreakdownTable breakdown={budgetBreakdown()} />);

    expect(screen.getByText('$3.10 > $3.00 → blocked')).toBeVisible();
  });

  it('adds decimals so a blocked verdict never reads "$3.00 > $3.00" (3_004_000 vs 3_000_000)', () => {
    const b = budgetBreakdown({ C: 1_200_000, R: 400_000, U: 4_000, N: 1_400_000, total: 3_004_000, allowed: false });

    render(<BudgetBreakdownTable breakdown={b} />);

    expect(screen.getByText('$3.004 > $3.000 → blocked')).toBeVisible();
    expect(screen.queryByText('$3.00 > $3.00 → blocked')).toBeNull();
  });

  it('keeps the normal display when the total equals the allowance', () => {
    const b = budgetBreakdown({ C: 1_200_000, R: 400_000, U: 0, N: 1_400_000, total: 3_000_000, allowed: true });

    render(<BudgetBreakdownTable breakdown={b} />);

    expect(screen.getByText('$3.00 ≤ $3.00 → allowed')).toBeVisible();
  });
});
