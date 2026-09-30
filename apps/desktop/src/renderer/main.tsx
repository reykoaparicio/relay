import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App } from './App';
import { hasPreloadBridge, installBridge } from './api/bridge';
import { createQueryClient } from './api/query-client';
import { createAppRouter } from './router';

async function bootstrap(): Promise<void> {
  // Dev/test only (10 J3): without a preload (`pnpm dev:renderer` in a browser) the fake bridge serves every channel.
  // The dynamic import sits in a branch Vite folds to `false` in production builds, so the fake is never bundled.
  if ((import.meta.env.DEV || import.meta.env.MODE === 'test') && !hasPreloadBridge()) {
    const fake = await import('./api/fake-bridge');
    installBridge(fake.createFakeBridge(fake.fakeScenarioFromUrl(), { latencyMs: 120 }));
  }
  const container = document.getElementById('root');
  if (container === null) throw new Error('#root is missing from index.html');
  createRoot(container).render(
    <StrictMode>
      <App queryClient={createQueryClient()} router={createAppRouter()} />
    </StrictMode>,
  );
}

void bootstrap();
