import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PAUSE_REASONS, RUN_STATUSES } from '@relay/contracts';
import { statusPresentation } from '../../lib/format/status-presentation';
import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it.each(RUN_STATUSES)('renders visible text and an icon for run status %s', (status) => {
    const { container } = render(<StatusBadge kind="run" value={status} />);
    const badge = container.querySelector('.badge');

    expect(badge?.textContent.trim()).toBeTruthy();
    expect(badge?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it.each(PAUSE_REASONS)('renders the specific label for paused + %s', (reason) => {
    const { container } = render(<StatusBadge kind="run" value="paused" pauseReason={reason} />);

    expect(container.textContent).toBe(statusPresentation('pause', reason).label);
    expect(container.textContent).not.toBe('');
  });

  it('showDetail renders the detail as visible text', () => {
    const { getByText } = render(<StatusBadge kind="run" value="paused" pauseReason="budget_run" showDetail />);

    expect(getByText("The next step would exceed this run's allowance")).toBeVisible();
  });

  it('omits detail text unless showDetail is set', () => {
    const { queryByText } = render(<StatusBadge kind="run" value="failed" />);

    expect(queryByText(/internal error/)).toBeNull();
  });

  it('uses the tone as a class alongside the text (never color alone)', () => {
    const { container } = render(<StatusBadge kind="run" value="failed" />);

    expect(container.querySelector('.badge.danger')).toHaveTextContent('Failed');
  });
});
