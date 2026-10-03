import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast, ROUTE_CHANGE_GRACE_MS, TOAST_DEDUPE_MS } from './Toast';

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

function RouteTrigger() {
  const { show, dismissStale } = useToast();
  return (
    <>
      <button type="button" onClick={() => show({ key: 'old', title: 'Plan approved', tone: 'success' })}>
        Show old
      </button>
      <button type="button" onClick={() => show({ key: 'new', title: 'Project created', tone: 'success' })}>
        Show new
      </button>
      <button type="button" onClick={dismissStale}>
        Leave page
      </button>
    </>
  );
}

describe('Toast route change', () => {
  it('dismisses the toasts of the page the user left, keeping one raised by the navigation itself', async () => {
    let now = 1_000_000;
    render(
      <ToastProvider now={() => now}>
        <RouteTrigger />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Show old' }));
    now += ROUTE_CHANGE_GRACE_MS + 1;
    await userEvent.click(screen.getByRole('button', { name: 'Show new' }));
    await userEvent.click(screen.getByRole('button', { name: 'Leave page' }));
    expect(screen.queryByText('Plan approved')).not.toBeInTheDocument();
    expect(screen.getByText('Project created')).toBeInTheDocument();
  });
});
