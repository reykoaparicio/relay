import { beforeEach, describe, expect, it } from 'vitest';
import { beginNavigation, markHistoryLoaded, markRouteReady, resetNavPerf } from './useNavPerf';

const measures = (name: string) => performance.getEntriesByName(name, 'measure');

describe('nav perf marks (12 L2 contract)', () => {
  beforeEach(() => {
    resetNavPerf();
  });

  it('marks relay:nav:<route>:start and measures relay:nav:<route> once per navigation', () => {
    beginNavigation('memory');
    expect(performance.getEntriesByName('relay:nav:memory:start', 'mark')).toHaveLength(1);
    expect(markRouteReady('memory')).toBe(true);
    expect(markRouteReady('memory')).toBe(false);
    expect(measures('relay:nav:memory')).toHaveLength(1);
    beginNavigation('memory');
    expect(markRouteReady('memory')).toBe(true);
    expect(measures('relay:nav:memory')).toHaveLength(2);
  });

  it('ignores a ready signal from a route that is not the current navigation', () => {
    beginNavigation('runs');
    expect(markRouteReady('settings')).toBe(false);
    beginNavigation('not-found');
    expect(markRouteReady('runs')).toBe(false);
    expect(measures('relay:nav:runs')).toHaveLength(0);
  });

  it('relay:history-loaded is marked and measured from the runs navigation start, once', () => {
    beginNavigation('runs');
    markHistoryLoaded();
    markHistoryLoaded();
    expect(performance.getEntriesByName('relay:history-loaded', 'mark')).toHaveLength(1);
    expect(measures('relay:history-loaded')).toHaveLength(1);
  });
});
