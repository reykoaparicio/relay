import { useEffect } from 'react';
import type { RefObject } from 'react';

function canTakeFocus(el: HTMLElement): boolean {
  return el.isConnected && !el.matches(':disabled') && el.closest('[inert]') === null;
}

function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === document.documentElement;
}

/**
 * Page-level focus rescue (run inspector, B5): when the control that last had keyboard focus is removed or disabled
 * by a re-render (a banner button that disappears once its action changes the run status, an opener that is gone
 * when its dialog closes), focus would drop to `<body>`. This moves it to `fallback` (a heading with
 * `tabIndex={-1}`) instead. It never steals focus that is somewhere meaningful.
 */
export function usePageFocusRescue(fallback: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let last: HTMLElement | null = document.activeElement instanceof HTMLElement && !focusIsLost() ? document.activeElement : null;
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement) last = e.target;
    };
    const rescue = () => {
      if (last === null || canTakeFocus(last)) return;
      // A disabled element can keep document.activeElement in some engines; treat that as lost as well.
      if (!focusIsLost() && document.activeElement !== last) return;
      last = null;
      const target = fallback.current;
      if (target !== null && canTakeFocus(target)) target.focus();
    };
    const observer = new MutationObserver(rescue);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'inert'] });
    document.addEventListener('focusin', onFocusIn);
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [fallback]);
}
