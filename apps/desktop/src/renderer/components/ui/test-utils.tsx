import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import type { RenderOptions, RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe as runAxe } from 'vitest-axe';
import { LiveRegionProvider } from './LiveRegion';
import { ThemeProvider } from './ThemeProvider';
import type { ThemeSetting } from './ThemeProvider';
import { ToastProvider } from './Toast';

export type AxeResults = Awaited<ReturnType<typeof runAxe>>;

export interface ProviderOptions extends Omit<RenderOptions, 'wrapper'> {
  readonly theme?: ThemeSetting;
  readonly queryClient?: QueryClient;
}

/** A QueryClient that never retries, so failing queries surface immediately in tests. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
}

/** Renders `ui` inside the app providers (09 I6): QueryClient, Theme, LiveRegion, Toast. */
export function renderWithProviders(ui: ReactElement, options: ProviderOptions = {}): RenderResult & { queryClient: QueryClient } {
  const { theme = 'dark', queryClient = createTestQueryClient(), ...rest } = options;
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider theme={theme}>
          <LiveRegionProvider>
            <ToastProvider>{children}</ToastProvider>
          </LiveRegionProvider>
        </ThemeProvider>
      </QueryClientProvider>
    );
  }
  return { ...render(ui, { wrapper: Wrapper, ...rest }), queryClient };
}

/**
 * Runs axe on a rendered container. `color-contrast` is disabled because jsdom has no layout or
 * computed colors; contrast is proven from the tokens by styles/contrast.test.ts instead.
 */
export async function axe(container: Element): Promise<AxeResults> {
  return runAxe(container, { rules: { 'color-contrast': { enabled: false } } });
}

/** Formats violations so a failing assertion names the rule and the offending nodes. */
export function describeViolations(results: AxeResults): string[] {
  return results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}
