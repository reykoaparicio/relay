// Theme `system` and reduced motion: both follow OS media queries (§5.1, 09 I5).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { readRepoFileText } from '../../styles/read-file.testing';
import { ThemeProvider } from './ThemeProvider';
import { usePrefersReducedMotion } from './useMediaQuery';

/** A controllable matchMedia: `set(query, matches)` flips a query and notifies its listeners. */
function installMatchMedia() {
  const state = new Map<string, boolean>();
  const listeners = new Map<string, Set<() => void>>();
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query: string) =>
    ({
      media: query,
      get matches() {
        return state.get(query) ?? false;
      },
      addEventListener: (_t: string, fn: () => void) => {
        const set = listeners.get(query) ?? new Set();
        set.add(fn);
        listeners.set(query, set);
      },
      removeEventListener: (_t: string, fn: () => void) => listeners.get(query)?.delete(fn),
    }) as unknown as MediaQueryList;
  return {
    set(query: string, matches: boolean) {
      state.set(query, matches);
      for (const fn of listeners.get(query) ?? []) fn();
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

const LIGHT = '(prefers-color-scheme: light)';
const REDUCE = '(prefers-reduced-motion: reduce)';
let media: ReturnType<typeof installMatchMedia>;

beforeEach(() => {
  media = installMatchMedia();
});
afterEach(() => {
  media.restore();
});

describe('ThemeProvider theme "system"', () => {
  it('follows prefers-color-scheme and updates live when the OS appearance changes', () => {
    media.set(LIGHT, true);
    render(<ThemeProvider theme="system">x</ThemeProvider>);
    expect(document.documentElement.dataset['theme']).toBe('light');

    act(() => {
      media.set(LIGHT, false);
    });

    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('an explicit theme ignores the OS preference', () => {
    media.set(LIGHT, true);
    const { rerender } = render(<ThemeProvider theme="dark">x</ThemeProvider>);
    expect(document.documentElement.dataset['theme']).toBe('dark');

    rerender(<ThemeProvider theme="light">x</ThemeProvider>);
    act(() => {
      media.set(LIGHT, false);
    });

    expect(document.documentElement.dataset['theme']).toBe('light');
  });
});

describe('reduced motion (09 I5)', () => {
  it('usePrefersReducedMotion tracks the OS setting', () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);

    act(() => {
      media.set(REDUCE, true);
    });

    expect(result.current).toBe(true);
  });

  it('the stylesheets zero durations and stop animations under prefers-reduced-motion', () => {
    const block = (css: string) => css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    const tokens = block(readRepoFileText('apps/desktop/src/renderer/styles/tokens.css'));
    const base = block(readRepoFileText('apps/desktop/src/renderer/styles/base.css'));
    const components = block(readRepoFileText('apps/desktop/src/renderer/styles/components.css'));

    expect(tokens).toMatch(/--duration-fast:\s*0ms/);
    expect(tokens).toMatch(/--duration-base:\s*0ms/);
    expect(base).toMatch(/animation-duration:\s*0ms !important/);
    expect(base).toMatch(/transition-duration:\s*0ms !important/);
    expect(components).toMatch(/\.spinner, \.spin \{ animation: none; \}/);
  });
});
