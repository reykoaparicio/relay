import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog, DialogClose, DialogFooter } from './Dialog';
import { axe, describeViolations, renderWithProviders } from './test-utils';

function FormDialog({
  onSubmit,
  pending = false,
  primaryDisabled = false,
  onSecondary,
}: {
  readonly onSubmit: (amount: string) => void;
  readonly pending?: boolean;
  readonly primaryDisabled?: boolean;
  readonly onSecondary?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  return (
    <>
      <button type="button" onClick={() => { setOpen(true); }}>
        Open
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Increase allowance"
        footer={
          <DialogFooter
            formId="allowance-form"
            primaryLabel="Increase allowance"
            pending={pending}
            primaryDisabled={primaryDisabled}
            {...(onSecondary === undefined ? {} : { onSecondary })}
          />
        }
      >
        <form
          id="allowance-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(amount);
          }}
        >
          <label htmlFor="amount">Amount</label>
          <input id="amount" value={amount} onChange={(e) => { setAmount(e.target.value); }} />
        </form>
      </Dialog>
    </>
  );
}

describe('DialogFooter', () => {
  it('submits the body form from the primary button', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<FormDialog onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText('Amount'), '5');
    const primary = within(dialog).getByRole('button', { name: 'Increase allowance' });
    expect(primary).toHaveAttribute('type', 'submit');
    expect(primary).toHaveAttribute('form', 'allowance-form');
    await user.click(primary);

    expect(onSubmit).toHaveBeenCalledWith('5');
  });

  it('submits on Enter in a field of the form', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<FormDialog onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText('Amount'), '7{Enter}');

    expect(onSubmit).toHaveBeenCalledWith('7');
  });

  it('closes the dialog from the default secondary (Cancel) button and returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<FormDialog onSubmit={vi.fn()} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(opener).toHaveFocus();
  });

  it('calls onSecondary instead of closing when given', async () => {
    const user = userEvent.setup();
    const onSecondary = vi.fn();
    render(<FormDialog onSubmit={vi.fn()} onSecondary={onSecondary} />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(onSecondary).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows pending on the primary, disables both, and blocks a second submit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<FormDialog onSubmit={onSubmit} pending />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');

    const primary = within(dialog).getByRole('button', { name: 'Increase allowance' });
    expect(primary).toHaveAttribute('aria-busy', 'true');
    expect(primary).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await user.click(primary);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables only the primary with primaryDisabled', async () => {
    const user = userEvent.setup();
    render(<FormDialog onSubmit={vi.fn()} primaryDisabled />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('button', { name: 'Increase allowance' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('runs onPrimary as a plain button when there is no form', async () => {
    const user = userEvent.setup();
    const onPrimary = vi.fn();
    render(
      <Dialog open onOpenChange={vi.fn()} title="Retry step?" footer={<DialogFooter primaryLabel="Retry step" primaryVariant="danger" secondaryLabel="Keep waiting" onPrimary={onPrimary} />} />,
    );
    const dialog = await screen.findByRole('dialog');

    const primary = within(dialog).getByRole('button', { name: 'Retry step' });
    expect(primary).toHaveAttribute('type', 'button');
    expect(primary).toHaveClass('danger');
    await user.click(primary);

    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole('button', { name: 'Keep waiting' })).toBeVisible();
  });

  it('has no axe violations @a11y', async () => {
    const { baseElement } = renderWithProviders(
      <Dialog open onOpenChange={vi.fn()} title="Increase allowance" description="Adds to this run only." footer={<DialogFooter formId="f" primaryLabel="Increase allowance" />}>
        <form id="f">
          <label htmlFor="x">Amount</label>
          <input id="x" />
        </form>
      </Dialog>,
    );
    await screen.findByRole('dialog');

    expect(describeViolations(await axe(baseElement))).toEqual([]);
  });
});

describe('DialogClose', () => {
  it('renders a default Cancel button that closes the dialog', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Dialog open onOpenChange={onOpenChange} title="Details" footer={<DialogClose label="Done" />} />);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('wraps a custom control', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Dialog
        open
        onOpenChange={onOpenChange}
        title="Details"
        footer={
          <DialogClose>
            <button type="button">Back to run</button>
          </DialogClose>
        }
      />,
    );
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Back to run' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
