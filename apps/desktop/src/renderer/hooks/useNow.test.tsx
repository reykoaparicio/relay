import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNow } from './useNow';

afterEach(() => {
  vi.useRealTimers();
});

describe('useNow', () => {
  it('ticks at the interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { result } = renderHook(() => useNow(1_000));
    expect(result.current).toBe(1_000_000);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(1_001_000);
  });

  it('re-reads the clock when the refresh key changes (a refetch), between ticks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { result, rerender } = renderHook(({ key }: { key: number }) => useNow(60_000, key), { initialProps: { key: 1 } });
    vi.setSystemTime(1_030_000);
    rerender({ key: 2 });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(result.current).toBe(1_030_000);
  });
});
