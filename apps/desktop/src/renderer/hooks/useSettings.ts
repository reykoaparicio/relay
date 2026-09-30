import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `app.getSettings` (theme, active project, onboarding completion). */
export function useSettings() {
  return useQuery({ queryKey: qk.settings(), queryFn: () => call('relay/v1/app.getSettings', {}) });
}
