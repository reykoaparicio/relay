// Every view of a run names a step by the workflow's display name (`RunDetail.stepMeta[].name`), not its key label.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { stepMetaSchema } from '@relay/contracts';
import { attempt, costSummary, runDetail, step } from '../test-fixtures';
import { BudgetLedger } from './BudgetLedger';
import { RecoveryPanel } from './RecoveryPanel';

const META = stepMetaSchema.array().parse([
  { stepKey: 'review', name: 'Audit the handlers', instructionVersion: null },
  { stepKey: 'plan', name: 'Draft the change plan', instructionVersion: null },
]);

describe('step names come from the workflow (stepMeta)', () => {
  it('RecoveryPanel: last completed step and unknown-outcome rows', () => {
    const run = runDetail({
      stepMeta: META,
      unresolvedAttempts: [attempt(2, { stepKey: 'plan', state: 'unknown', cost: { microusd: 900_000, certainty: 'unknown' } })],
    });
    render(<RecoveryPanel run={run} onDecide={() => undefined} />);
    expect(screen.getByText('Audit the handlers')).toBeInTheDocument();
    expect(screen.getByText('Draft the change plan · attempt 2')).toBeInTheDocument();
    expect(screen.queryByText('Review input')).not.toBeInTheDocument();
  });

  it('BudgetLedger: the step rows', () => {
    render(<BudgetLedger cost={costSummary()} byStep={[{ stepKey: 'review', cost: costSummary() }]} stepMeta={META} />);
    expect(screen.getByRole('rowheader', { name: 'Audit the handlers' })).toBeInTheDocument();
  });

  it('without a name the key label is used', () => {
    render(<RecoveryPanel run={runDetail({ steps: [step(1)] })} onDecide={() => undefined} />);
    expect(screen.getByText('Review input')).toBeInTheDocument();
  });
});
