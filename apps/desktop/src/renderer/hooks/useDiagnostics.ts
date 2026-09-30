import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `app.getDiagnostics`. */
export function useDiagnostics() {
  return useQuery({ queryKey: qk.diagnostics(), queryFn: () => call('relay/v1/app.getDiagnostics', {}) });
}
