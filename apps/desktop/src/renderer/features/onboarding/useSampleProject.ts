import { useQueryClient } from '@tanstack/react-query';
import type { Dispatch } from 'react';
import { qk } from '../../api/keys';
import { useIdempotentMutation } from '../../hooks/useIdempotentMutation';
import type { OnboardingAction } from './onboarding-state';

/** `projects.createSample` (idempotent; returns the existing sample when there is one). */
export function useSampleProject(dispatch: Dispatch<OnboardingAction>, onCreated: () => void) {
  const queryClient = useQueryClient();
  return useIdempotentMutation('relay/v1/projects.createSample', {
    onSuccess: (project) => {
      dispatch({
        type: 'patch',
        patch: {
          startPoint: 'sample',
          project: { id: project.id, name: project.name, isSample: true },
          selection: null,
        },
      });
      void queryClient.invalidateQueries({ queryKey: qk.projects() });
      void queryClient.invalidateQueries({ queryKey: qk.settings() });
      onCreated();
    },
  });
}
