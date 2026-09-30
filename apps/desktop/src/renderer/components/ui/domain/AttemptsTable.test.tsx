import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { attempt } from '../test-fixtures';
import { AttemptsTable } from './AttemptsTable';

describe('AttemptsTable', () => {
  it('exposes the exact token count without a hover-only tooltip', () => {
    render(<AttemptsTable attempts={[attempt(1)]} />);

    // 12,000 + 400 + 0 input tokens: compact "12.4k" is shown, the exact count is in the accessible text.
    expect(screen.getByText('12,400 tokens')).toHaveClass('sr-only');
    expect(screen.getByText('12.4k')).toBeVisible();
    expect(screen.queryByTitle('12,400')).toBeNull();
  });

  it('lets keyboard users reveal the exact token count', async () => {
    const user = userEvent.setup();
    const { container } = render(<AttemptsTable attempts={[attempt(1)]} />);
    const exact = screen.getByText('12,400 exact');
    expect(exact).not.toBeVisible();

    const summary = container.querySelector('summary');
    for (let i = 0; i < 10 && document.activeElement !== summary; i++) await user.tab();
    expect(summary).toHaveFocus();
    expect(summary).toHaveTextContent('12,400 tokens');

    // Browsers turn Enter/Space on a focused <summary> into a click; user-event does not, so click it.
    if (summary !== null) await user.click(summary);

    expect(exact).toBeVisible();
  });
});
