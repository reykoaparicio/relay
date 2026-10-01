import { useQuery } from '@tanstack/react-query';
import type { MemoryStatus } from '@relay/contracts';
import { call } from '../api/client';
import { qk } from '../api/keys';
import type { MemoryTab } from '../features/shell/paths';

const TAB_STATUS: Readonly<Record<MemoryTab, readonly MemoryStatus[]>> = {
  approved: ['approved'],
  suggested: ['suggested'],
  archived: ['archived'],
};

export interface UseMemoryListOptions {
  /** False defers the fetch (e.g. the Archived list until its tab is opened). Default true. */
  readonly enabled?: boolean;
}

/** `memory.list` for one Memory tab. */
export function useMemoryList(projectId: string | undefined, tab: MemoryTab, { enabled = true }: UseMemoryListOptions = {}) {
  return useQuery({
    queryKey: qk.memory(projectId ?? '', tab),
    queryFn: () => call('relay/v1/memory.list', { projectId: projectId ?? '', status: [...TAB_STATUS[tab]] }),
    enabled: enabled && projectId !== undefined && projectId !== '',
  });
}
