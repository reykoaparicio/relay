import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import type { MemoryTab } from '../shell/paths';
import { parseMemoryTab } from './memory-model';

export interface MemorySelection {
  readonly tab: MemoryTab;
  /** `?record=`: the selected record id (the first record when absent or unknown). */
  readonly recordParam: string | null;
  /** Changes the tab and/or the record. A tab change is a history entry; a record change replaces it. */
  readonly select: (next: { readonly tab?: MemoryTab; readonly record?: string | null }) => void;
}

/** The Memory page's selection, kept in the URL (`?tab=`, `?record=`) so it survives reloads and back/forward. */
export function useMemorySelection(): MemorySelection {
  const [search, setSearch] = useSearchParams();
  const select = useCallback(
    (next: { readonly tab?: MemoryTab; readonly record?: string | null }) => {
      setSearch(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next.tab !== undefined) p.set('tab', next.tab);
          if (next.record === null) p.delete('record');
          else if (next.record !== undefined) p.set('record', next.record);
          return p;
        },
        { replace: next.tab === undefined },
      );
    },
    [setSearch],
  );
  return { tab: parseMemoryTab(search.get('tab')), recordParam: search.get('record'), select };
}
