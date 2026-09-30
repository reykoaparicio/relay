import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `memory.get` (record detail with revisions and events). */
export function useMemoryRecord(recordId: string | undefined) {
  return useQuery({
    queryKey: qk.memoryRecord(recordId ?? ''),
    queryFn: () => call('relay/v1/memory.get', { recordId: recordId ?? '' }),
    enabled: recordId !== undefined && recordId !== '',
  });
}
