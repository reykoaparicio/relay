import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { Channel, RunAction } from '@relay/contracts';
import { call } from '../../api/client';
import { qk } from '../../api/keys';
import { useIdempotentMutation } from '../../hooks/useIdempotentMutation';
import { planRunAction } from './run-actions';
import type { RunActionRequest } from './run-actions';

export interface RunActionsApi {
  /** Executes a request; resolves true on success, false on failure (the error is in `error`). */
  readonly dispatch: (req: RunActionRequest) => Promise<boolean>;
  /** The action in flight (buttons show pending and the others are disabled). */
  readonly pending: RunAction | null;
  readonly error: unknown;
  readonly clearError: () => void;
}

/**
 * Executes run actions through {@link planRunAction}. Every idempotent op goes through `useIdempotentMutation`
 * (one key per intent: retrying the same request reuses it; a different request starts a new intent).
 */
export function useRunActions(): RunActionsApi {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const resume = useIdempotentMutation('relay/v1/runs.resume');
  const decide = useIdempotentMutation('relay/v1/approvals.decide');
  const increase = useIdempotentMutation('relay/v1/runs.increaseAllowance');
  const retry = useIdempotentMutation('relay/v1/runs.retryStep');
  const unknown = useIdempotentMutation('relay/v1/runs.decideUnknown');
  const plain = useMutation({
    mutationFn: (p: { readonly channel: Channel; readonly input: unknown }) => call(p.channel, p.input as never),
  });
  const { mutateAsync: plainMutateAsync } = plain;
  const [pending, setPending] = useState<RunAction | null>(null);
  const [error, setError] = useState<unknown>(null);
  const lastIntent = useRef<string | null>(null);
  const idem = useRef({ resume, decide, increase, retry, unknown });
  useLayoutEffect(() => {
    idem.current = { resume, decide, increase, retry, unknown };
  });

  const dispatch = useCallback(
    async (req: RunActionRequest): Promise<boolean> => {
      const plan = planRunAction(req);
      if (plan.kind === 'navigate') {
        void navigate(plan.to);
        return true;
      }
      const intent = JSON.stringify(req);
      const m = idem.current;
      if (intent !== lastIntent.current) {
        for (const mutation of Object.values(m)) mutation.newIntent();
        lastIntent.current = intent;
      }
      setPending(req.action);
      setError(null);
      try {
        if (!plan.idempotent) {
          await plainMutateAsync({ channel: plan.channel, input: plan.input });
        } else {
          const c = plan.channel;
          if (plan.channel === 'relay/v1/runs.resume') await m.resume.mutateAsync(plan.input);
          else if (plan.channel === 'relay/v1/approvals.decide') await m.decide.mutateAsync(plan.input);
          else if (plan.channel === 'relay/v1/runs.increaseAllowance') await m.increase.mutateAsync(plan.input);
          else if (plan.channel === 'relay/v1/runs.retryStep') await m.retry.mutateAsync(plan.input);
          else if (plan.channel === 'relay/v1/runs.decideUnknown') await m.unknown.mutateAsync(plan.input);
          else throw new Error(`run action ${req.action} maps to an unexpected channel ${c}`);
        }
        lastIntent.current = null;
        if ('runId' in req) void queryClient.invalidateQueries({ queryKey: qk.run(req.runId) });
        void queryClient.invalidateQueries({ queryKey: ['runs'] });
        void queryClient.invalidateQueries({ queryKey: ['project'] });
        return true;
      } catch (e) {
        setError(e);
        return false;
      } finally {
        setPending(null);
      }
    },
    [navigate, plainMutateAsync, queryClient],
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return { dispatch, pending, error, clearError };
}
