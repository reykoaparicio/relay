import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `providers.catalog` (all providers). */
export function useCatalog() {
  return useQuery({ queryKey: qk.catalog(), queryFn: () => call('relay/v1/providers.catalog', {}) });
}
