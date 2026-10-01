import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyButton } from './CopyButton';
import { renderWithProviders } from './test-utils';

function stubClipboard(writeText: (text: string) => Promise<void>) {
  const spy = vi.fn(writeText);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: spy }, configurable: true });
  return spy;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('CopyButton', () => {
  it('copies the value and announces "Copied" in the polite live region', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CopyButton value="abc123" label="Copy plan hash" />);
    const writeText = stubClipboard(() => Promise.resolve());

    await user.click(screen.getByRole('button', { name: 'Copy plan hash' }));

    expect(writeText).toHaveBeenCalledExactlyOnceWith('abc123');
    await waitFor(() => {
      expect(screen.getByTestId('live-region')).toHaveTextContent('Copied');
    });
    expect(screen.getByTestId('live-region')).toHaveAttribute('aria-live', 'polite');
  });

  it('announces how to recover when the clipboard write fails', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CopyButton value="abc123" label="Copy plan hash" />);
    stubClipboard(() => Promise.reject(new Error('denied')));

    await user.click(screen.getByRole('button', { name: 'Copy plan hash' }));

    await waitFor(() => {
      expect(screen.getByTestId('live-region')).toHaveTextContent('Copy failed. Select the text and copy it manually.');
    });
    expect(screen.getByTestId('live-region')).not.toHaveTextContent(/^Copied$/);
  });
});
