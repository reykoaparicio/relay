import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { attempt } from '../test-fixtures';
import { AttemptsTable, attemptAppTimeMs } from './AttemptsTable';

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
    render(<AttemptsTable attempts={[attempt(1)]} />);
    const exact = screen.getByText('12,400 exact');
    expect(exact).not.toBeVisible();

    const summary = screen.getByText('12,400 tokens').closest('summary');
    for (let i = 0; i < 10 && document.activeElement !== summary; i++) await user.tab();
    expect(summary).toHaveFocus();
    expect(summary).toHaveTextContent('12,400 tokens');

    // Browsers turn Enter/Space on a focused <summary> into a click; user-event does not, so click it.
    if (summary !== null) await user.click(summary);

    expect(exact).toBeVisible();
  });

  it('shows app time as total elapsed minus provider time (not the total), in the attempt\'s Timing details', async () => {
    // 43.5 s total, 41 s of it provider time → 2.5 s app time ("2s"), never "43s".
    render(<AttemptsTable attempts={[attempt(1)]} />);
    await userEvent.click(screen.getByText('Timing'));
    expect(screen.getByText('Provider time').nextElementSibling).toHaveTextContent('41s');
    expect(screen.getByText('App time').nextElementSibling).toHaveTextContent(/^2s$/);
  });

  it('keeps the table narrow: the purpose is short text and the model id never wraps', () => {
    render(<AttemptsTable attempts={[attempt(1)]} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).not.toContain('Provider time');
    expect(headers).not.toContain('App time');
    expect(screen.getByText('Initial')).toBeInTheDocument();
  });
});

describe('attemptAppTimeMs', () => {
  it('subtracts provider time, clamps at zero, and is all app time without a first byte', () => {
    expect(attemptAppTimeMs({ appElapsedMs: 43_500, providerLatencyMs: 41_000 })).toBe(2_500);
    expect(attemptAppTimeMs({ appElapsedMs: 1_000, providerLatencyMs: 1_200 })).toBe(0);
    expect(attemptAppTimeMs({ appElapsedMs: 900, providerLatencyMs: null })).toBe(900);
    expect(attemptAppTimeMs({ appElapsedMs: null, providerLatencyMs: null })).toBeNull();
  });

  it('run-level view: the Step column names each attempt\'s step with stepNameFor', () => {
    render(
      <AttemptsTable
        attempts={[attempt(1, { stepKey: 'review' }), attempt(2, { stepKey: 'implement', purpose: 'schema_repair' })]}
        caption="Attempts for the whole run"
        stepNameFor={(k) => (k === 'review' ? 'Code review' : 'Produce patch')}
      />,
    );
    expect(screen.getByText('Code review · Initial')).toBeInTheDocument();
    expect(screen.getByText('Produce patch · Repair')).toBeInTheDocument();
  });
});
