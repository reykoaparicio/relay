import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './Dialog';

function Harness({ onConfirm }: { readonly onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => { setOpen(true); }}>
        Stop run
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Stop this run?"
        consequences="Finished steps are kept."
        confirmLabel="Stop run now"
        onConfirm={onConfirm}
      />
    </>
  );
}

describe('ConfirmDialog', () => {
  it('traps focus inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Harness onConfirm={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Stop run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop this run?' });
    for (let i = 0; i < 6; i++) await user.tab();

    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(dialog).toHaveAccessibleDescription('Finished steps are kept.');
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<Harness onConfirm={vi.fn()} />);
    const opener = screen.getByRole('button', { name: 'Stop run' });

    await user.click(opener);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(opener).toHaveFocus();
  });

  it('calls onConfirm from the destructive button', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Stop run' }));
    const confirm = await screen.findByRole('button', { name: 'Stop run now' });
    await user.click(confirm);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveClass('danger');
  });
});
