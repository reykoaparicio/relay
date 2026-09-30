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

/** `memory.list` for one Memory tab. */
export function useMemoryList(projectId: string | undefined, tab: MemoryTab) {
  return useQuery({
    queryKey: qk.memory(projectId ?? '', tab),
    queryFn: () => call('relay/v1/memory.list', { projectId: projectId ?? '', status: [...TAB_STATUS[tab]] }),
    enabled: projectId !== undefined && projectId !== '',
  });
}
