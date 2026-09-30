import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useMediaQuery } from './useMediaQuery';

export type ThemeSetting = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

/** Dark is the default (§5.1); `system` follows prefers-color-scheme. */
export function useResolvedTheme(setting: ThemeSetting): ResolvedTheme {
  const prefersLight = useMediaQuery('(prefers-color-scheme: light)');
  if (setting === 'system') return prefersLight ? 'light' : 'dark';
  return setting;
}

export interface ThemeProviderProps {
  /** From `app.getSettings().theme`; the page layer passes it in (no data fetching here). */
  readonly theme: ThemeSetting;
  readonly children: ReactNode;
}

/** Sets `data-theme` on `<html>`; tokens.css switches palettes on that attribute. */
export function ThemeProvider({ theme, children }: ThemeProviderProps) {
  const resolved = useResolvedTheme(theme);
  useEffect(() => {
    document.documentElement.dataset['theme'] = resolved;
  }, [resolved]);
  return <>{children}</>;
}
