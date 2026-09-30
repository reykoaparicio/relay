import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `providers.list` (redacted connection state). */
export function useProviders() {
  return useQuery({ queryKey: qk.providers(), queryFn: () => call('relay/v1/providers.list', {}) });
}
