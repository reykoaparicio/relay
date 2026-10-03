import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `app.getDiagnostics` (main answers it also while the runner is down). Disabled when `enabled` is false. */
export function useDiagnostics({ enabled = true }: { readonly enabled?: boolean } = {}) {
  return useQuery({ queryKey: qk.diagnostics(), queryFn: () => call('relay/v1/app.getDiagnostics', {}), enabled });
}
