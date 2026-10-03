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

describe('BudgetLedger per-step table', () => {
  const byStep = [
    { stepKey: 'review', cost: costSummary({ settledReported: 0, settledCalculated: 4_200, settledEstimated: 0, reserved: 0, unknown: 0 }) },
    { stepKey: 'implement', cost: costSummary({ settledReported: 0, settledCalculated: 20_000, settledEstimated: 0, reserved: 0, unknown: 0 }) },
  ];

  it('has one header cell per column and one precision per column', () => {
    render(<BudgetLedger cost={costSummary()} byStep={byStep} />);
    const table = screen.getByRole('table', { name: /Settled usage by step/ });
    const headers = screen
      .getAllByRole('columnheader')
      .filter((h) => table.contains(h))
      .map((h) => h.textContent);
    expect(headers).toEqual(['Step', 'Settled', 'Estimated', 'Reserved']);
    const settled = screen.getAllByRole('row').filter((r) => table.contains(r)).slice(1).map((r) => r.querySelectorAll('td')[0]?.textContent);
    // "$0.0042" over "$0.0200": not "$0.0042" over "$0.02".
    expect(settled).toEqual(['$0.0042', '$0.0200']);
  });
});

describe('BudgetLedger estimates (decision 1)', () => {
  it('shows the estimated row as "~$X (estimated)", a "~" tracked total and remaining, and no "Unknown" row', () => {
    render(<BudgetLedger cost={costSummary()} />);

    expect(screen.getByRole('row', { name: /Estimated/ })).toHaveTextContent('~$0.12 (estimated)');
    expect(screen.getByRole('row', { name: /Tracked total/ })).toHaveTextContent('~$0.60');
    expect(screen.getByRole('row', { name: /Remaining/ })).toHaveTextContent('~$1.30');
    expect(screen.queryByText(/unknown/i)).toBeNull();
  });

  it('reads exact totals without "~" when nothing is estimated', () => {
    render(<BudgetLedger cost={costSummary({ settledEstimated: 0, hasEstimates: false, remaining: 1_420_000 })} />);

    expect(screen.getByRole('row', { name: /Tracked total/ })).toHaveTextContent('$0.48');
    expect(screen.getByRole('row', { name: /Tracked total/ })).not.toHaveTextContent('~');
  });
});
