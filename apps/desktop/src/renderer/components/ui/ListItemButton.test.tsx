import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListItemButton } from './ListItemButton';

describe('ListItemButton', () => {
  it('is named by its title and described by its aside, meta and badges (no aria-label)', () => {
    render(
      <ListItemButton
        title="Use zod for input"
        aside={<span>Approved</span>}
        meta="Validate every request body"
        badges={<span>Pinned</span>}
        aria-current="true"
        onClick={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: 'Use zod for input' });

    expect(button).not.toHaveAttribute('aria-label');
    expect(button).toHaveAccessibleDescription('Approved Validate every request body Pinned');
    expect(button).toHaveAttribute('aria-current', 'true');
    expect(button).toHaveClass('list-item');
  });

  it('keeps a screen-reader prefix in the name and hides the leading decoration', () => {
    render(<ListItemButton leading={<span>2</span>} title={<><span className="sr-only">Step 2:</span> Plan</>} />);

    expect(screen.getByRole('button', { name: 'Step 2: Plan' })).not.toHaveAttribute('aria-describedby');
    expect(screen.getByText('2').closest('[aria-hidden="true"]')).not.toBeNull();
  });
});
