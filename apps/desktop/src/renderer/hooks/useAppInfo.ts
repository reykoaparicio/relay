import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `app.getInfo` (version, provider mode). Static for the app's lifetime. */
export function useAppInfo() {
  return useQuery({ queryKey: qk.info(), queryFn: () => call('relay/v1/app.getInfo', {}), staleTime: Infinity });
}
