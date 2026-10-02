import { createHashRouter } from 'react-router';
import type { RouteObject } from 'react-router';
import { ShellLayout } from './features/shell/Shell';
import { PageErrorView } from './features/shell/PageErrorView';
import { RouteErrorPage } from './features/shell/RouteErrorPage';
import {
  MemoryPage,
  NewRunPage,
  OnboardingPage,
  ReportPage,
  RunInspectorPage,
  SettingsPage,
  WorkflowEditorPage,
} from './features/shell/lazy-pages';
import { attachNavPerf } from './hooks/useNavPerf';
import { NotFoundPage } from './pages/NotFoundPage';
import { OverviewPage } from './pages/OverviewPage';
import { RootRedirect } from './pages/RootRedirect';
import { RunsPage } from './pages/RunsPage';
import { WorkflowsRedirect } from './pages/WorkflowsRedirect';

// Eager: the shell, Overview and Runs (first paint after onboarding). Everything else is lazy (features/shell/lazy-pages).

/**
 * Route table (10 J1). Leaf `id`s are the `relay:nav:<route>` names (hooks/useNavPerf). Every page renders inside
 * the shell; the active project lives in the URL.
 *
 * Two error boundaries: `pages` (pathless, inside the shell's Suspense) catches a page that fails to load (a lazy chunk
 * import rejected) or crashes, and keeps the shell and its navigation; `shell` catches a crash of the shell itself.
 */
export const routes: RouteObject[] = [
  {
    id: 'shell',
    element: <ShellLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      {
        id: 'pages',
        errorElement: <PageErrorView />,
        children: [
          { id: 'root-redirect', index: true, element: <RootRedirect /> },
          { id: 'onboarding', path: 'onboarding/:step?', element: <OnboardingPage /> },
          { id: 'overview', path: 'p/:projectId', element: <OverviewPage /> },
          { id: 'workflows', path: 'p/:projectId/workflows', element: <WorkflowsRedirect /> },
          {
            id: 'workflow-editor',
            path: 'p/:projectId/workflows/:workflowId',
            element: <WorkflowEditorPage />,
          },
          { id: 'runs', path: 'p/:projectId/runs', element: <RunsPage /> },
          { id: 'new-run', path: 'p/:projectId/runs/new', element: <NewRunPage /> },
          { id: 'run-inspector', path: 'p/:projectId/runs/:runId', element: <RunInspectorPage /> },
          { id: 'report', path: 'p/:projectId/runs/:runId/report', element: <ReportPage /> },
          { id: 'memory', path: 'p/:projectId/memory', element: <MemoryPage /> },
          { id: 'settings', path: 'settings/:section?', element: <SettingsPage /> },
          { id: 'not-found', path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

/** The app router: hash routing works under `file://` (packaged app). Nav perf marks are attached. */
export function createAppRouter() {
  const router = createHashRouter(routes);
  attachNavPerf(router);
  return router;
}

export type AppRouter = ReturnType<typeof createAppRouter>;
