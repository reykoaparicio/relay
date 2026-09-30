import { useEffect, useState } from 'react';

/** `value`, settled for `delayMs` (e.g. the new-run preflight recomputes 400 ms after the last change, 10 J7). */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => {
      setSettled(value);
    }, delayMs);
    return () => {
      clearTimeout(t);
    };
  }, [value, delayMs]);
  return settled;
}
