import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePageFocusRescue } from './usePageFocusRescue';

function Page() {
  const mainRef = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(true);
  usePageFocusRescue(mainRef);
  return (
    <main ref={mainRef} tabIndex={-1} aria-label="Main">
      {shown ? (
        <button type="button" onClick={() => { setShown(false); }}>
          Archive
        </button>
      ) : null}
      <button type="button">Other</button>
    </main>
  );
}

describe('usePageFocusRescue', () => {
  it('moves focus to the fallback (<main>) when the focused control is removed', async () => {
    const user = userEvent.setup();
    render(<Page />);

    await user.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('main'));
    });
  });

  it('leaves focus alone when it is somewhere meaningful', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const other = screen.getByRole('button', { name: 'Other' });

    await user.click(other);

    expect(document.activeElement).toBe(other);
  });
});
