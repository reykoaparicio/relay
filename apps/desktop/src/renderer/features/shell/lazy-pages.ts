// Lazy route modules (00b §5, PERF-04): pages outside the first paint load on demand. The loaders are shared so a
// page can warm the next one (Overview / New run prefetch the run inspector) without importing the router.
import { lazy } from 'react';
import { loadRunInspectorPage } from './prefetch';


export const RunInspectorPage = lazy(() => loadRunInspectorPage().then((m) => ({ default: m.RunInspectorPage })));
export const NewRunPage = lazy(() => import('../../pages/NewRunPage').then((m) => ({ default: m.NewRunPage })));
export const MemoryPage = lazy(() => import('../../pages/MemoryPage').then((m) => ({ default: m.MemoryPage })));
export const OnboardingPage = lazy(() => import('../../pages/OnboardingPage').then((m) => ({ default: m.OnboardingPage })));
export const WorkflowEditorPage = lazy(() => import('../../pages/WorkflowEditorPage').then((m) => ({ default: m.WorkflowEditorPage })));
export const ReportPage = lazy(() => import('../../pages/ReportPage').then((m) => ({ default: m.ReportPage })));
export const SettingsPage = lazy(() => import('../../pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
