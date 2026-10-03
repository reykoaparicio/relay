import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { LiveRegionProvider, ThemeProvider, ToastProvider } from './components/ui';
import { useSettings } from './hooks/useSettings';
import type { AppRouter } from './router';
import { PushSyncProvider } from './state/PushSyncProvider';

/**
 * Applies the saved theme (`app.getSettings().theme`); until settings load, `system` (the engine default), so the
 * first paint already follows the OS instead of flashing dark on a light system.
 */
export function ThemeController({ children }: { readonly children: ReactNode }) {
  const settings = useSettings();
  return <ThemeProvider theme={settings.data?.theme ?? 'system'}>{children}</ThemeProvider>;
}

export interface AppProps {
  readonly queryClient: QueryClient;
  readonly router: AppRouter;
}

/** Provider stack (10 J1): QueryClient → LiveRegion → Toast → ThemeController → (push sync) → Router. */
export function App({ queryClient, router }: AppProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <LiveRegionProvider>
        <ToastProvider>
          <ThemeController>
            <PushSyncProvider>
              <RouterProvider router={router} />
            </PushSyncProvider>
          </ThemeController>
        </ToastProvider>
      </LiveRegionProvider>
    </QueryClientProvider>
  );
}
