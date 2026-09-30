// jsdom setup for the unit-web Vitest project (created by Agent I; owned by Agent J).
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';
import { installBridge } from './api/bridge';

expect.extend(axeMatchers);

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  installBridge(null);
  performance.clearMarks();
  performance.clearMeasures();
});

/**
 * matchMedia polyfill that evaluates min-width/max-width against window.innerWidth and notifies
 * listeners on `resize`, so tests can do: `window.innerWidth = 1100; window.dispatchEvent(new Event('resize'))`.
 * Other features (prefers-color-scheme, prefers-reduced-motion) never match.
 */
function evaluateQuery(query: string): boolean {
  const min = /\(min-width:\s*(\d+)px\)/.exec(query);
  const max = /\(max-width:\s*(\d+)px\)/.exec(query);
  if (!min && !max) return false;
  const width = window.innerWidth;
  return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
}

window.matchMedia = (query: string): MediaQueryList => {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  let last = evaluateQuery(query);
  const mql = {
    media: query,
    get matches() {
      return evaluateQuery(query);
    },
    onchange: null,
    addEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    addListener: (fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeListener: (fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    dispatchEvent: () => true,
  };
  window.addEventListener('resize', () => {
    const now = evaluateQuery(query);
    if (now === last) return;
    last = now;
    for (const fn of listeners) fn({ matches: now, media: query } as MediaQueryListEvent);
  });
  return mql as unknown as MediaQueryList;
};

// Radix popper/menus measure elements; jsdom lacks these APIs.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub;
}
Element.prototype.scrollIntoView = () => undefined;
Element.prototype.hasPointerCapture = () => false;
Element.prototype.releasePointerCapture = () => undefined;
