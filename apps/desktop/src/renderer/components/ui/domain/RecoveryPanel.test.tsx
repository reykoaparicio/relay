import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunAction } from '@relay/contracts';
import { attempt, runDetail } from '../test-fixtures';
import { axe, describeViolations, renderWithProviders } from '../test-utils';
import { RecoveryPanel } from './RecoveryPanel';

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

  const twoUncertain = () =>
    runDetail({
      uncertainAttempts: [
        attempt(2, { stepKey: 'patch', state: 'unknown', cost: { microusd: 620_000, certainty: 'estimated' }, mayNotHaveBeenCharged: true }),
        attempt(3, { stepKey: 'review', state: 'unknown', cost: { microusd: 30_000, certainty: 'estimated' }, mayNotHaveBeenCharged: false }),
      ],
    });

  it('lists each request that may not have completed with its estimate, and the note only where it applies (decision 1)', () => {
    render(<RecoveryPanel run={twoUncertain()} onDecide={() => undefined} />);

    expect(screen.getByText('Requests that may not have completed')).toBeVisible();
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Counted toward the budget: ~$0.62 (estimated) · may not have been charged');
    expect(rows[1]).toHaveTextContent('Counted toward the budget: ~$0.03 (estimated)');
    expect(rows[1]).not.toHaveTextContent('may not have been charged');
    expect(document.body).not.toHaveTextContent(/unknown/i);
  });

  it('offers no per-request decision and never a "decide" action, even if a legacy server lists one', () => {
    render(<RecoveryPanel run={runDetail({ ...twoUncertain(), availableActions: ['decide_unknown', 'review_recovery', 'stop'] })} onDecide={() => undefined} />);

    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Continue from last checkpoint', 'Stop run']);
  });

  it('can leave the request list to its host (the inspector banner lists them with request facts)', () => {
    render(<RecoveryPanel run={twoUncertain()} onDecide={() => undefined} showRequests={false} />);

    expect(screen.queryByText('Requests that may not have completed')).toBeNull();
  });

  it('calls a plain (action) => void handler with the action for non-attempt buttons', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn<(action: RunAction) => void>();
    render(<RecoveryPanel run={runDetail()} onDecide={onDecide} />);

    await user.click(screen.getByRole('button', { name: 'Continue from last checkpoint' }));
    expect(onDecide).toHaveBeenCalledWith('review_recovery');
  });

  it('has no axe violations with request rows @a11y', async () => {
    const { baseElement } = renderWithProviders(<main><RecoveryPanel run={twoUncertain()} onDecide={() => undefined} /></main>);

    expect(describeViolations(await axe(baseElement))).toEqual([]);
  });
});
