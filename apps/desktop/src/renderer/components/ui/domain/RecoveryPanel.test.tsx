import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UNKNOWN_OUTCOME_DECISIONS } from '@relay/contracts';
import type { RunAction } from '@relay/contracts';
import { attempt, runDetail } from '../test-fixtures';
import { axe, describeViolations, renderWithProviders } from '../test-utils';
import { RecoveryPanel } from './RecoveryPanel';

/** The accept decision names its amount ("Accept $0.39 as the charge"). */
const ACCEPT = /^Accept \$[\d.,]+ as the charge$/;

describe('RecoveryPanel', () => {
  it('keeps focus in the panel (not <body>) after confirming a destructive action @a11y', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [pending, setPending] = useState<RunAction | null>(null);
      return <RecoveryPanel run={runDetail()} onDecide={setPending} pendingAction={pending} />;
    }
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Stop run' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(screen.getAllByRole('button', { name: 'Stop run' }).find((b) => dialog.contains(b)) ?? dialog);

    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    await waitFor(() => { expect(document.activeElement).not.toBe(document.body); });
    expect(screen.getByRole('heading', { name: 'Recovery' })).toHaveFocus();
  });

  it('shows the status detail in full on its own line under the heading row (wraps on narrow cards)', () => {
    render(<RecoveryPanel run={runDetail()} onDecide={() => undefined} />);
    const heading = screen.getByRole('heading', { name: 'Recovery' });
    const detail = screen.getByText('Relay stopped unexpectedly. Review what happened before continuing');
    const headerRow = heading.closest('.card-header');

    expect(detail.tagName).toBe('P');
    expect(detail).toHaveClass('status-detail');
    expect(headerRow).not.toBeNull();
    expect(headerRow?.contains(detail)).toBe(false);
    expect(headerRow?.nextElementSibling).toBe(detail);
    expect(screen.getByText('Interrupted')).toBeInTheDocument();
  });

  const twoUnknown = () =>
    runDetail({
      unresolvedAttempts: [
        attempt(2, { stepKey: 'patch', state: 'unknown', cost: { microusd: 620_000, certainty: 'unknown' } }),
        attempt(3, { stepKey: 'review', state: 'unknown', cost: null }),
      ],
    });

  it('offers the three decisions on each unresolved attempt row and reports which attempt was decided', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    const run = twoUnknown();
    render(<RecoveryPanel run={run} onDecide={onDecide} attemptDecisions={UNKNOWN_OUTCOME_DECISIONS} />);

    const first = screen.getByRole('group', { name: /attempt 2/ });
    const retry = within(first).getByRole('button', { name: /may incur another charge/ });
    expect(retry).toHaveTextContent('Retry (may incur another charge)');
    expect(within(first).getByRole('button', { name: 'Mark as failed without retry' })).toBeVisible();
    expect(within(first).getByRole('button', { name: ACCEPT })).toBeVisible();
    // The single "Decide on unknown charge" button is replaced by the rows.
    expect(screen.queryByRole('button', { name: 'Decide on unknown charge' })).toBeNull();

    await user.click(within(first).getByRole('button', { name: 'Mark as failed without retry' }));
    expect(onDecide).toHaveBeenLastCalledWith('decide_unknown', { attemptId: run.unresolvedAttempts[0]?.id, decision: 'mark_failed_keep_liability' });

    const second = screen.getByRole('group', { name: /attempt 3/ });
    await user.click(within(second).getByRole('button', { name: /may incur another charge/ }));
    expect(onDecide).toHaveBeenLastCalledWith('decide_unknown', { attemptId: run.unresolvedAttempts[1]?.id, decision: 'retry_acknowledging_charge' });
  });

  it('does not offer "accept the estimated charge" when the attempt has no amount', () => {
    render(<RecoveryPanel run={twoUnknown()} onDecide={() => undefined} attemptDecisions={UNKNOWN_OUTCOME_DECISIONS} />);

    const second = screen.getByRole('group', { name: /attempt 3/ });
    expect(within(second).queryByRole('button', { name: ACCEPT })).toBeNull();
    expect(within(second).getAllByRole('button')).toHaveLength(2);
  });

  it('shows pending on the chosen row decision and disables every other button', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [pending, setPending] = useState<RunAction | null>(null);
      return <RecoveryPanel run={twoUnknown()} onDecide={(a) => { setPending(a); }} pendingAction={pending} attemptDecisions={UNKNOWN_OUTCOME_DECISIONS} />;
    }
    render(<Harness />);

    const first = screen.getByRole('group', { name: /attempt 2/ });
    await user.click(within(first).getByRole('button', { name: ACCEPT }));

    expect(within(first).getByRole('button', { name: ACCEPT })).toHaveAttribute('aria-busy', 'true');
    expect(within(first).getByRole('button', { name: /may incur another charge/ })).toBeDisabled();
    expect(within(first).getByRole('button', { name: /may incur another charge/ })).not.toHaveAttribute('aria-busy');
    expect(screen.getByRole('button', { name: 'Stop run' })).toBeDisabled();
    // Focus never drops to <body> when the clicked button turns disabled.
    expect(document.activeElement).not.toBe(document.body);
  });

  it('limits the offered decisions with attemptDecisions', () => {
    render(<RecoveryPanel run={twoUnknown()} onDecide={() => undefined} attemptDecisions={['retry_acknowledging_charge', 'mark_failed_keep_liability']} />);

    expect(screen.queryByRole('button', { name: ACCEPT })).toBeNull();
    expect(screen.getAllByRole('button', { name: /may incur another charge/ })).toHaveLength(2);
  });

  it('keeps the single "Decide on unknown charge" action by default (existing callers)', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(<RecoveryPanel run={runDetail()} onDecide={onDecide} />);

    expect(screen.queryByRole('group')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Decide on unknown charge' }));
    expect(onDecide).toHaveBeenCalledWith('decide_unknown');
  });

  it('shows no decision buttons on attempt rows when decide_unknown is not available', () => {
    render(<RecoveryPanel run={runDetail({ availableActions: ['review_recovery', 'stop'] })} onDecide={() => undefined} attemptDecisions={UNKNOWN_OUTCOME_DECISIONS} />);

    expect(screen.getByText('Requests with an unknown outcome')).toBeVisible();
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.queryByRole('button', { name: /may incur another charge/ })).toBeNull();
  });

  it('calls a plain (action) => void handler with the action for non-attempt buttons', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn<(action: RunAction) => void>();
    render(<RecoveryPanel run={runDetail()} onDecide={onDecide} />);

    await user.click(screen.getByRole('button', { name: 'Continue from last checkpoint' }));
    expect(onDecide).toHaveBeenCalledWith('review_recovery');
  });

  it('has no axe violations with per-attempt decision rows @a11y', async () => {
    const { baseElement } = renderWithProviders(<main><RecoveryPanel run={twoUnknown()} onDecide={() => undefined} attemptDecisions={UNKNOWN_OUTCOME_DECISIONS} /></main>);

    expect(describeViolations(await axe(baseElement))).toEqual([]);
  });
});
