import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast, TOAST_DEDUPE_MS } from './Toast';

let clock = 0;
const results: boolean[] = [];

function Trigger() {
  const { show } = useToast();
  return (
    <button type="button" onClick={() => results.push(show({ key: 'RATE_LIMITED:run1', title: 'Provider rate limit', tone: 'warning' }))}>
      Fire
    </button>
  );
}

describe('Toast', () => {
  it('dedupes the same key within 10 seconds', async () => {
    render(
      <ToastProvider now={() => clock}>
        <Trigger />
      </ToastProvider>,
    );
    const fire = screen.getByRole('button', { name: 'Fire' });

    await userEvent.click(fire);
    clock += TOAST_DEDUPE_MS - 1;
    await userEvent.click(fire);
    clock += 2;
    await userEvent.click(fire);

    expect(results).toEqual([true, false, true]);
    expect(screen.getAllByText('Provider rate limit')).toHaveLength(1);
  });
});
