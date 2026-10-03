// Decision 1 (founder): when a call's exact cost isn't available Relay shows an estimate, "~$0.03 (estimated)", never
// "unknown"; totals that include an estimate read "~". This renders every main money surface with an estimated attempt
// (and with a legacy not-confirmed amount) and checks that no money text says "unknown".
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { reportV1Schema } from '@relay/contracts';
import { AttemptsTable, BudgetLedger, BudgetMeter, RecoveryPanel } from '../../components/ui';
import { attempt, costSummary, runDetail } from '../../components/ui/test-fixtures';
import { renderWithProviders } from '../../components/ui/test-utils';
import { createFakeBridge, FAKE_PROJECT_ID } from '../../api/fake-bridge';
import { CostSection } from '../report/ReportSections';
import { StatusBanner } from '../run-inspector/StatusBanner';
import { renderApp } from '../testing/render-app';
import { RunCost } from './run-display';

const UNKNOWN = /unknown/i;

const estimated = attempt(2, {
  stepKey: 'implement',
  state: 'unknown',
  cost: { microusd: 30_000, certainty: 'estimated' },
  mayNotHaveBeenCharged: true,
  providerRequestId: null,
});
/** A run reported before decision 1: its uncertain request still carries the legacy certainty and liability. */
const legacy = attempt(3, { stepKey: 'implement', state: 'unknown', cost: { microusd: 620_000, certainty: 'unknown' } });

const cost = costSummary({ settledEstimated: 30_000, unknown: 0, hasEstimates: true });
const legacyCost = costSummary({ settledEstimated: 0, unknown: 620_000, hasEstimates: false });

describe('no "unknown" in money surfaces (decision 1)', () => {
  it('RunCost: a total with an estimate reads "~$…" with an "estimated" tag', () => {
    for (const c of [cost, legacyCost]) {
      const { container, unmount } = renderWithProviders(
        <MemoryRouter>
          <RunCost cost={c} detailed />
        </MemoryRouter>,
      );
      expect(container).toHaveTextContent(/~\$/);
      expect(container).toHaveTextContent('estimated');
      expect(container).not.toHaveTextContent(UNKNOWN);
      unmount();
    }
  });

  it('RunCost: an exact total has no "~"', () => {
    const { container } = renderWithProviders(
      <MemoryRouter>
        <RunCost cost={costSummary({ settledEstimated: 0, unknown: 0, hasEstimates: false })} />
      </MemoryRouter>,
    );
    expect(container).toHaveTextContent('$0.48');
    expect(container).not.toHaveTextContent('~');
  });

  it('Budget card (meter + ledger), with an estimate and with a legacy amount', () => {
    for (const c of [cost, legacyCost]) {
      const { container, unmount } = renderWithProviders(
        <>
          <BudgetMeter cost={c} />
          <BudgetLedger cost={c} byStep={[{ stepKey: 'implement', cost: c }]} />
        </>,
      );
      expect(container).toHaveTextContent(/~\$/);
      expect(container).not.toHaveTextContent(UNKNOWN);
      for (const el of container.querySelectorAll('[aria-label]')) expect(el.getAttribute('aria-label')).not.toMatch(UNKNOWN);
      unmount();
    }
  });

  it('Attempts table: the cost cell reads "~$0.03 (estimated)"', () => {
    const { container } = renderWithProviders(<AttemptsTable attempts={[estimated, legacy]} />);
    const cells = screen.getAllByTestId('attempt-cost');
    expect(cells[0]).toHaveTextContent('~$0.03 (estimated) may not have been charged');
    expect(cells[1]).toHaveTextContent('~$0.62 (estimated)');
    expect(container).not.toHaveTextContent(UNKNOWN);
  });

  it('RecoveryPanel: the estimate with "may not have been charged" as a muted note', () => {
    const { container } = renderWithProviders(
      <RecoveryPanel run={runDetail({ uncertainAttempts: [estimated], unresolvedAttempts: [legacy] })} onDecide={() => undefined} />,
    );
    const note = screen.getByText('· may not have been charged');
    expect(note).toHaveClass('subtle');
    expect(container).toHaveTextContent('~$0.03 (estimated) · may not have been charged');
    expect(container).not.toHaveTextContent(UNKNOWN);
  });

  it('status banner of every state with an uncertain request', () => {
    for (const status of ['paused', 'interrupted', 'cancelled'] as const) {
      const { unmount } = renderWithProviders(
        <MemoryRouter>
          <StatusBanner
            run={runDetail({
              status,
              pauseReason: status === 'paused' ? 'unknown_outcome' : null,
              uncertainAttempts: [estimated],
              unresolvedAttempts: [legacy],
              availableActions: status === 'paused' ? ['retry_step', 'stop'] : status === 'interrupted' ? ['review_recovery', 'stop'] : ['export_report'],
            })}
            projectId="prj_1"
            events={[]}
            onAction={() => undefined}
            onRecoveryAction={() => undefined}
            pending={null}
            busy={false}
          />
        </MemoryRouter>,
      );
      const banner = screen.getByTestId('status-banner');
      expect(banner, status).toHaveTextContent('~$0.03 (estimated)');
      expect(banner, status).not.toHaveTextContent(UNKNOWN);
      unmount();
    }
  });

  it('report cost section: "~" total, the estimated charges list, and legacy liabilities as estimates', () => {
    const bridge = createFakeBridge('cancelled');
    const run = bridge.world.runs[0];
    const stored = bridge.world.artifacts.get(run?.reportArtifactId ?? '');
    const report = reportV1Schema.parse(stored?.content.kind === 'json' ? stored.content.value : null);
    const withLegacy = {
      ...report,
      unknownLiabilities: [{ attemptId: legacy.id, stepKey: 'implement', liabilityMicrousd: 620_000, state: 'unknown' as const }],
    };
    const { container } = renderWithProviders(<CostSection report={reportV1Schema.parse(withLegacy)} />);
    // The total ($0.48 reported + $0.62 estimated) is approximate.
    expect(container.querySelector('.text-2xl')).toHaveTextContent('~$1.10');
    expect(screen.getByText('Estimated charges')).toBeInTheDocument();
    expect(within(container).getAllByText('~$0.62 (estimated)').length).toBeGreaterThan(0);
    expect(container).not.toHaveTextContent(UNKNOWN);
  });

  it.each([
    ['runs list', `/p/${FAKE_PROJECT_ID}/runs`],
    ['overview', `/p/${FAKE_PROJECT_ID}`],
  ] as const)('%s with an estimated charge never says "unknown"', async (_name, path) => {
    renderApp(path, { scenario: 'unknown-outcome' });
    expect((await screen.findAllByText(/^~\$/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('main')).not.toHaveTextContent(UNKNOWN);
  });
});
