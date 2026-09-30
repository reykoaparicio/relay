// Test harness (J11): renders the real App (providers + routes) on the fake bridge with a memory router.
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import type { QueryClient } from '@tanstack/react-query';
import { createTestQueryClient } from '../../components/ui/test-utils';
import { App } from '../../App';
import { installBridge } from '../../api/bridge';
import { createFakeBridge } from '../../api/fake-bridge';
import type { FakeBridge, FakeScenarioName } from '../../api/fake-bridge';
import { attachNavPerf, resetNavPerf } from '../../hooks/useNavPerf';
import { routes } from '../../router';

export interface RenderAppOptions {
  readonly scenario?: FakeScenarioName;
  readonly bridge?: FakeBridge;
}

export interface RenderAppResult extends RenderResult {
  readonly bridge: FakeBridge;
  readonly router: ReturnType<typeof createMemoryRouter>;
  readonly queryClient: QueryClient;
}

/** Renders the app at `path` with a fake bridge for `scenario` (default awaiting-approval). */
export function renderApp(path: string, options: RenderAppOptions = {}): RenderAppResult {
  const bridge = options.bridge ?? createFakeBridge(options.scenario ?? 'awaiting-approval');
  installBridge(bridge);
  resetNavPerf();
  const queryClient = createTestQueryClient();
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  attachNavPerf(router);
  const result = render(<App queryClient={queryClient} router={router} />);
  return { ...result, bridge, router, queryClient };
}
