import { useEffect } from 'react';
import type { RefObject } from 'react';

/** An open dialog (Radix keeps `data-state="closed"` on one that is animating out). */
const OPEN_DIALOG = [
  '[aria-modal="true"]',
  '[role="dialog"]:not([data-state="closed"])',
  '[role="alertdialog"]:not([data-state="closed"])',
].join(', ');
const DIALOG = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/**
 * How long focus that was inside a dialog may stay lost before the rescue steps in. A closing dialog restores focus
 * to its opener from a `setTimeout(0)` scheduled in an effect cleanup, which can run after this hook's own deferred
 * check (a close that is not a discrete user event): the dialog gets this long to put focus back first.
 */
export const DIALOG_RESTORE_GRACE_MS = 100;

function canTakeFocus(el: HTMLElement): boolean {
  return el.isConnected && !el.matches(':disabled') && el.closest('[inert]') === null;
}

function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === document.documentElement;
}

function dialogIsOpen(): boolean {
  return document.querySelector(OPEN_DIALOG) !== null;
}

/**
 * Page-level focus rescue (run inspector B5, A11Y-02): when the control that last had keyboard focus is removed or disabled
 * by a re-render (a banner button that disappears once its action changes the run status, an opener that is gone
 * when its dialog closes), focus would drop to `<body>`. This moves it to `fallback` (a heading with
 * `tabIndex={-1}`) instead. It never steals focus that is somewhere meaningful.
 *
 * Dialogs own their focus: while one is open nothing is rescued (a pending confirm button that turns disabled keeps
 * focus in the dialog; the page behind it is `aria-hidden`). The check is deferred past the dialog's own focus
 * restore, so closing a dialog moves focus straight back to its opener, never via the fallback.
 *
 * The shell installs one with `<main tabIndex={-1}>` as the app-wide fallback; a page may add its own with a closer
 * target (its observer is created first, since child effects run before the shell's, so the page's target wins).
 */
export function usePageFocusRescue(fallback: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let last: HTMLElement | null = document.activeElement instanceof HTMLElement && !focusIsLost() ? document.activeElement : null;
    /** `last` was inside a dialog when it took focus (it may be detached by now). */
    let lastInDialog = last?.closest(DIALOG) != null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onFocusIn = (e: FocusEvent) => {
      if (!(e.target instanceof HTMLElement)) return;
      last = e.target;
      lastInDialog = e.target.closest(DIALOG) !== null;
    };
    const needsRescue = (): boolean => {
      if (last === null || canTakeFocus(last)) return false;
      // A disabled element can keep document.activeElement in some engines; treat that as lost as well.
      return focusIsLost() || document.activeElement === last;
    };
    const check = () => {
      timer = undefined;
      // Re-checked after the dialogs' focus scopes ran: they may have moved focus somewhere meaningful already.
      if (!needsRescue() || dialogIsOpen()) return;
      last = null;
      const target = fallback.current;
      if (target !== null && canTakeFocus(target) && target.closest('[aria-hidden="true"]') === null) target.focus();
    };
    const onMutation = () => {
      if (timer !== undefined || !needsRescue() || dialogIsOpen()) return;
      timer = setTimeout(check, lastInDialog ? DIALOG_RESTORE_GRACE_MS : 0);
    };
    const observer = new MutationObserver(onMutation);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'inert'] });
    document.addEventListener('focusin', onFocusIn);
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', onFocusIn);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [fallback]);
}
