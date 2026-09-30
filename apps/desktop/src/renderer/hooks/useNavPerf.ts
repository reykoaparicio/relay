// Navigation performance marks (10 J2, 12 L2 contract). Always on: cheap, no PII.
//   relay:nav:<route>:start  mark     when a navigation to <route> starts (router subscription, before render)
//   relay:nav:<route>        measure  when the route's content is ready (once per navigation)
//   relay:history-loaded     mark + measure (from the runs navigation start) when the runs list first renders
import { useEffect, useSyncExternalStore } from 'react';

/** Route ids that carry nav measures (the `id` of each leaf route in router.tsx). */
export const NAV_ROUTES = [
  'overview',
  'runs',
  'new-run',
  'run-inspector',
  'report',
  'memory',
  'settings',
  'workflow-editor',
  'onboarding',
] as const;
export type NavRoute = (typeof NAV_ROUTES)[number];

export function isNavRoute(id: unknown): id is NavRoute {
  return typeof id === 'string' && (NAV_ROUTES as readonly string[]).includes(id);
}

export const startMarkName = (route: NavRoute): string => `relay:nav:${route}:start`;
export const measureName = (route: NavRoute): string => `relay:nav:${route}`;
export const HISTORY_LOADED = 'relay:history-loaded';

interface NavState {
  readonly route: NavRoute | null;
  /** Increments on every navigation; pages re-arm their ready effect on change. */
  readonly token: number;
  readonly measured: boolean;
}

let state: NavState = { route: null, token: 0, measured: false };
const listeners = new Set<() => void>();

function setState(next: NavState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Starts a navigation measurement: marks `relay:nav:<route>:start`. Non-nav routes only bump the token. */
export function beginNavigation(route: string | null | undefined): void {
  if (isNavRoute(route)) {
    performance.mark(startMarkName(route));
    setState({ route, token: state.token + 1, measured: false });
  } else {
    setState({ route: null, token: state.token + 1, measured: true });
  }
}

/** Measures `relay:nav:<route>` once for the current navigation. Returns true when a measure was recorded. */
export function markRouteReady(route: NavRoute): boolean {
  if (state.route !== route || state.measured) return false;
  if (performance.getEntriesByName(startMarkName(route), 'mark').length === 0) return false;
  performance.measure(measureName(route), startMarkName(route));
  state = { ...state, measured: true };
  return true;
}

let historyLoadedRecorded = false;

/** Marks and measures `relay:history-loaded` (first runs page rendered, rows or empty state). Once per page mount. */
export function markHistoryLoaded(): void {
  if (historyLoadedRecorded) return;
  historyLoadedRecorded = true;
  performance.mark(HISTORY_LOADED);
  const start = startMarkName('runs');
  if (performance.getEntriesByName(start, 'mark').length > 0) performance.measure(HISTORY_LOADED, start);
}

/** Allows the next {@link markHistoryLoaded} (RunsPage calls it on mount). */
export function resetHistoryLoaded(): void {
  historyLoadedRecorded = false;
}

/** Minimal router surface used by {@link attachNavPerf} (React Router data routers satisfy it). */
export interface NavRouterLike {
  readonly state: { readonly location: { readonly key: string }; readonly matches: ReadonlyArray<{ readonly route: { readonly id: string } }> };
  subscribe(fn: (s: NavRouterLike['state']) => void): () => void;
}

function leafRouteId(s: NavRouterLike['state']): string | undefined {
  return s.matches[s.matches.length - 1]?.route.id;
}

/**
 * Wires a data router to the marks: the current location counts as the first navigation, then every location
 * change (router subscription fires before React renders the new route) starts a new one.
 */
export function attachNavPerf(router: NavRouterLike): () => void {
  let lastKey = router.state.location.key;
  beginNavigation(leafRouteId(router.state));
  return router.subscribe((s) => {
    if (s.location.key === lastKey) return;
    lastKey = s.location.key;
    beginNavigation(leafRouteId(s));
  });
}

/** Test reset. */
export function resetNavPerf(): void {
  state = { route: null, token: 0, measured: false };
  historyLoadedRecorded = false;
}

/**
 * Page hook: records `relay:nav:<route>` when `ready` (primary query rendered, or the placeholder mounted),
 * once per navigation.
 */
export function useNavPerf(route: NavRoute, ready: boolean): void {
  const token = useSyncExternalStore(subscribe, () => state.token);
  useEffect(() => {
    if (ready) markRouteReady(route);
  }, [route, ready, token]);
}
