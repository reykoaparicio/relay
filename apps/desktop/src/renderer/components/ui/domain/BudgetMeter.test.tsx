import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { costSummary } from '../test-fixtures';
import { BudgetMeter } from './BudgetMeter';

describe('BudgetMeter', () => {
  it('shows every amount as legend text, not color only', () => {
    render(<BudgetMeter cost={costSummary()} />);
    const legend = screen.getByRole('list');

    expect(legend).toHaveTextContent('Reported / calculated $0.48');
    expect(legend).toHaveTextContent('Estimated ~$0.12');
    expect(legend).toHaveTextContent('Reserved $1.10');
    // The remaining amount depends on an estimate: "~".
    expect(legend).toHaveTextContent('Remaining ~$1.30');
    expect(legend).not.toHaveTextContent(/unknown/i);
  });

  it('summarizes the amounts in the meter aria-label', () => {
    render(<BudgetMeter cost={costSummary()} />);

    expect(screen.getByRole('img')).toHaveAccessibleName(
      'Run allowance $3.00: $0.48 reported or calculated, ~$0.12 estimated, $1.10 reserved, ~$1.30 remaining',
    );
  });

  it('folds a legacy not-confirmed amount into the estimate, never "Unknown"', () => {
    render(<BudgetMeter cost={costSummary({ settledEstimated: 0, unknown: 50_000, hasEstimates: false })} />);

    expect(screen.getByRole('list')).toHaveTextContent('Estimated ~$0.05');
    expect(screen.getByRole('img').getAttribute('aria-label')).not.toMatch(/unknown/i);
  });

  it('reads exact amounts without "~" when nothing is estimated', () => {
    render(<BudgetMeter cost={costSummary({ settledEstimated: 0, hasEstimates: false })} />);

    expect(screen.getByRole('list')).toHaveTextContent('Estimated $0.00');
    expect(screen.getByRole('list')).toHaveTextContent('Remaining $1.30');
  });

  it('says "over by" when the run overran its allowance', () => {
    render(<BudgetMeter cost={costSummary({ remaining: -100_000, overrun: true })} />);

    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/over by ~\$0\.10$/);
    expect(screen.getByRole('list')).toHaveTextContent('Over allowance ~$0.10');
  });
});
