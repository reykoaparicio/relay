import { lazy } from 'react';
import { createHashRouter } from 'react-router';
import type { RouteObject } from 'react-router';
import { ShellLayout } from './features/shell/Shell';
import { RouteErrorPage } from './features/shell/RouteErrorPage';
import { attachNavPerf } from './hooks/useNavPerf';
import { MemoryPage } from './pages/MemoryPage';
import { NewRunPage } from './pages/NewRunPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { OverviewPage } from './pages/OverviewPage';
import { RootRedirect } from './pages/RootRedirect';
import { RunInspectorPage } from './pages/RunInspectorPage';
import { RunsPage } from './pages/RunsPage';
import { WorkflowsRedirect } from './pages/WorkflowsRedirect';

// Lazy routes (00b §5): workflow editor, report/diff viewer, settings.
const WorkflowEditorPage = lazy(() => import('./pages/WorkflowEditorPage').then((m) => ({ default: m.WorkflowEditorPage })));
const ReportPage = lazy(() => import('./pages/ReportPage').then((m) => ({ default: m.ReportPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));

/**
 * Route table (10 J1). Leaf `id`s are the `relay:nav:<route>` names (hooks/useNavPerf). Every page renders inside
 * the shell; the active project lives in the URL.
 */
export const routes: RouteObject[] = [
  {
    id: 'shell',
    element: <ShellLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      { id: 'root-redirect', index: true, element: <RootRedirect /> },
      { id: 'onboarding', path: 'onboarding/:step?', element: <OnboardingPage /> },
      { id: 'overview', path: 'p/:projectId', element: <OverviewPage /> },
      { id: 'workflows', path: 'p/:projectId/workflows', element: <WorkflowsRedirect /> },
      { id: 'workflow-editor', path: 'p/:projectId/workflows/:workflowId', element: <WorkflowEditorPage /> },
      { id: 'runs', path: 'p/:projectId/runs', element: <RunsPage /> },
      { id: 'new-run', path: 'p/:projectId/runs/new', element: <NewRunPage /> },
      { id: 'run-inspector', path: 'p/:projectId/runs/:runId', element: <RunInspectorPage /> },
      { id: 'report', path: 'p/:projectId/runs/:runId/report', element: <ReportPage /> },
      { id: 'memory', path: 'p/:projectId/memory', element: <MemoryPage /> },
      { id: 'settings', path: 'settings/:section?', element: <SettingsPage /> },
      { id: 'not-found', path: '*', element: <NotFoundPage /> },
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
