import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Keeps keyboard focus inside a card when a render disables the focused control (for example a
 * decision button that turns pending after its confirm dialog returned focus to it). Chromium blurs a
 * focused element once it becomes disabled, which would drop focus to <body>; this moves it to
 * `fallback` (a heading with `tabIndex={-1}`) instead. Runs after every render; it only reads the DOM.
 */
export function useFocusRescue(container: RefObject<HTMLElement | null>, fallback: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.matches(':disabled')) return;
    if (container.current?.contains(active) !== true) return;
    fallback.current?.focus();
  });
}
