import { useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './Dialog';
import { DIALOG_RESTORE_GRACE_MS, usePageFocusRescue } from './usePageFocusRescue';

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

/** The shell's app-wide rescue (<main> fallback) behind a ConfirmDialog whose confirm stays pending. */
function DialogPage({ removeOpenerOnConfirm = false }: { readonly removeOpenerOnConfirm?: boolean }) {
  const mainRef = useRef<HTMLElement>(null);
  usePageFocusRescue(mainRef);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [openerShown, setOpenerShown] = useState(true);
  return (
    <main ref={mainRef} tabIndex={-1} aria-label="Main">
      {openerShown ? (
        <button type="button" onClick={() => { setOpen(true); }}>
          Archive project…
        </button>
      ) : null}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Archive?"
        consequences="It is hidden."
        confirmLabel="Archive project"
        pending={pending}
        onConfirm={() => {
          if (removeOpenerOnConfirm) {
            // The decision removes the opener and closes the dialog (non-discrete, like a mutation's onSuccess).
            setTimeout(() => {
              setOpenerShown(false);
              setOpen(false);
            }, 0);
          } else {
            setPending(true); // in flight: the dialog stays open until it settles
          }
        }}
      />
    </main>
  );
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Records every element that takes focus (tag:text), so a detour through <main> is visible. */
function recordFocus() {
  const seen: string[] = [];
  const onFocusIn = (e: FocusEvent) => {
    const el = e.target as HTMLElement;
    seen.push(`${el.tagName}:${el.textContent.slice(0, 20)}`);
  };
  document.addEventListener('focusin', onFocusIn);
  return { seen, stop: () => { document.removeEventListener('focusin', onFocusIn); } };
}

let stopRecording: (() => void) | undefined;
afterEach(() => {
  stopRecording?.();
  stopRecording = undefined;
});

describe('usePageFocusRescue', () => {
  it('moves focus to the fallback (<main>) when the focused control is removed', async () => {
    const user = userEvent.setup();
    render(<Page />);

    await user.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('main', { hidden: true }));
    });
  });

  it('leaves focus alone when it is somewhere meaningful', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const other = screen.getByRole('button', { name: 'Other' });

    await user.click(other);

    expect(document.activeElement).toBe(other);
  });

  it('never pulls focus out of an open dialog when its confirm turns pending (disabled)', async () => {
    const user = userEvent.setup();
    render(<DialogPage />);
    await user.click(screen.getByRole('button', { name: 'Archive project…' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Archive project' }));
    expect(screen.getByRole('button', { name: /Archive project$/ })).toBeDisabled();
    await tick(DIALOG_RESTORE_GRACE_MS + 50);
    expect(document.activeElement?.tagName).not.toBe('MAIN');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it.each([
    ['Cancel', async (user: ReturnType<typeof userEvent.setup>) => { await user.click(screen.getByRole('button', { name: 'Keep going' })); }],
    ['Esc', async (user: ReturnType<typeof userEvent.setup>) => { await user.keyboard('{Escape}'); }],
  ])('closing with %s moves focus straight to the opener, never via <main>', async (_how, close) => {
    const user = userEvent.setup();
    render(<DialogPage />);
    const opener = screen.getByRole('button', { name: 'Archive project…' });
    await user.click(opener);
    await screen.findByRole('dialog');
    const rec = recordFocus();
    stopRecording = rec.stop;
    await close(user);
    await tick(DIALOG_RESTORE_GRACE_MS + 50);
    expect(document.activeElement).toBe(opener);
    // The only stop after the dialog's own controls is the opener: no detour through <main>.
    expect(rec.seen.filter((s) => !s.startsWith('BUTTON:Keep going'))).toEqual(['BUTTON:Archive project…']);
  });

  it('still rescues once a closed dialog could not restore focus (its opener is gone)', async () => {
    const user = userEvent.setup();
    render(<DialogPage removeOpenerOnConfirm />);
    await user.click(screen.getByRole('button', { name: 'Archive project…' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Archive project' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('main'));
    });
  });
});
