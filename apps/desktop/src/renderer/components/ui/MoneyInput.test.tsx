import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Microusd } from '@relay/contracts';
import { MoneyInput, parseDollarInput } from './MoneyInput';

describe('parseDollarInput', () => {
  it('converts dollar strings to integer micro-USD without floats', () => {
    expect(parseDollarInput('3.50')).toEqual({ ok: true, value: 3_500_000 });
    expect(parseDollarInput('$0.000001')).toEqual({ ok: true, value: 1 });
    expect(parseDollarInput('1,000')).toEqual({ ok: true, value: 1_000_000_000 });
  });

  it('rejects malformed, negative, and over-precise input', () => {
    expect(parseDollarInput('abc').ok).toBe(false);
    expect(parseDollarInput('-1').ok).toBe(false);
    expect(parseDollarInput('1.0000001').ok).toBe(false);
    expect(parseDollarInput('').ok).toBe(false);
  });
});

describe('MoneyInput', () => {
  it('shows a parse error inline and emits null until the amount is valid', async () => {
    let parsed: Microusd | null = null;
    function Harness() {
      const [text, setText] = useState('');
      return <MoneyInput label="Run allowance" value={text} onValueChange={(t, p) => { setText(t); parsed = p; }} />;
    }
    render(<Harness />);
    const input = screen.getByLabelText('Run allowance');

    await userEvent.type(input, '3.5x');

    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/at most 6 decimal places/)).toBeVisible();
    expect(parsed).toBeNull();

    await userEvent.clear(input);
    await userEvent.type(input, '3.50');

    expect(input).not.toHaveAttribute('aria-invalid');
    expect(parsed).toBe(3_500_000);
  });
});
