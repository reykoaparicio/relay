import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `profiles.list` (profiles with engine-computed capability warnings). */
export function useProfiles() {
  return useQuery({ queryKey: qk.profiles(), queryFn: () => call('relay/v1/profiles.list', {}) });
}
