// PERF-04: warms the run inspector chunk from pages whose next step is usually a run. Kept apart from
// lazy-pages.ts so a page can prefetch without importing the module that lazily imports it (no cycle).

export const loadRunInspectorPage = () => import('../../pages/RunInspectorPage');

/** Starts loading the run inspector chunk in the background (no-op once loaded: the module is cached). */
export function prefetchRunInspector(): void {
  loadRunInspectorPage().catch(() => undefined);
}
