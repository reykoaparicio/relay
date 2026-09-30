import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { costSummary } from '../test-fixtures';
import { BudgetLedger } from './BudgetLedger';

const OVERRUN_NOTE = /Actual cost exceeded the reservation/;

describe('BudgetLedger', () => {
  it('labels remaining "over allowance" when remaining is negative, even without a reservation overrun', () => {
    render(<BudgetLedger cost={costSummary({ remaining: -120_000, overrun: false })} />);

    expect(screen.getByRole('rowheader', { name: 'Remaining (over allowance)' })).toBeVisible();
    expect(screen.queryByText(OVERRUN_NOTE)).toBeNull();
  });

  it('reports a reservation overrun separately and keeps "Remaining" while still within the allowance', () => {
    render(<BudgetLedger cost={costSummary({ remaining: 250_000, overrun: true })} />);

    expect(screen.getByRole('rowheader', { name: 'Remaining' })).toBeVisible();
    expect(screen.queryByText('Remaining (over allowance)')).toBeNull();
    expect(screen.getByText(OVERRUN_NOTE)).toBeVisible();
  });

  it('shows both when the overrun also pushed remaining below zero', () => {
    render(<BudgetLedger cost={costSummary({ remaining: -1, overrun: true })} />);

    expect(screen.getByRole('rowheader', { name: 'Remaining (over allowance)' })).toBeVisible();
    expect(screen.getByText(OVERRUN_NOTE)).toBeVisible();
  });

  it('shows plain "Remaining" when neither applies', () => {
    render(<BudgetLedger cost={costSummary()} />);

    expect(screen.getByRole('rowheader', { name: 'Remaining' })).toBeVisible();
    expect(screen.queryByText(OVERRUN_NOTE)).toBeNull();
  });
});
