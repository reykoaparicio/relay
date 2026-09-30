import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunAction } from '@relay/contracts';
import { runDetail } from '../test-fixtures';
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
});
