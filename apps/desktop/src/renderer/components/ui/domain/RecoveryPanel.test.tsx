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
});
