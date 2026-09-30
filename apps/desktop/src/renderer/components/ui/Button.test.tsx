import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Save } from 'lucide-react';
import { Button } from './Button';

describe('Button', () => {
  it('is a real button that fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('pending disables the button, sets aria-busy, and keeps the label', async () => {
    const onClick = vi.fn();
    render(
      <Button pending icon={Save} onClick={onClick}>
        Save changes
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save changes' });

    await userEvent.click(button);

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveTextContent('Save changes');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('uses the variant class for primary and danger buttons', () => {
    render(
      <>
        <Button variant="primary">Start run</Button>
        <Button variant="danger">Stop run</Button>
      </>,
    );

    expect(screen.getByRole('button', { name: 'Start run' })).toHaveClass('btn', 'primary');
    expect(screen.getByRole('button', { name: 'Stop run' })).toHaveClass('btn', 'danger');
  });
});
