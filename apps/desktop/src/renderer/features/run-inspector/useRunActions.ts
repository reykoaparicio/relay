import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { Channel, RunAction } from '@relay/contracts';
import { call } from '../../api/client';
import { qk } from '../../api/keys';
import { canonicalJson, IntentInFlightError, useIdempotentMutation } from '../../hooks/useIdempotentMutation';
import { planRunAction } from './run-actions';
import type { RunActionRequest } from './run-actions';

export interface RunActionsApi {
  /**
   * Executes a request; resolves true on success, false on failure (the error is in `error`). The same request while
   * it is in flight is deduped; a different request while any action is in flight is rejected with
   * {@link IntentInFlightError} (in `error`) and never sent.
   */
  readonly dispatch: (req: RunActionRequest) => Promise<boolean>;
  /** The action in flight (its button shows pending). */
  readonly pending: RunAction | null;
  /** True while any run action is in flight: every other run-action control stays disabled. */
  readonly busy: boolean;
  readonly error: unknown;
  readonly clearError: () => void;
}

/** The run (and project) the actions are displayed for: approval and project ops carry no run id of their own. */
export interface RunActionsContext {
  readonly runId?: string | undefined;
  readonly projectId?: string | undefined;
}

/**
 * Executes run actions through {@link planRunAction}. Every idempotent op goes through `useIdempotentMutation`
 * (one key per intent = channel + canonical input: retrying the same request reuses it; a different request is a
 * new intent). After a success it invalidates the run, its steps and ledger, and the project's run lists.
 */
export function useRunActions(context: RunActionsContext = {}): RunActionsApi {
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
  const inFlight = useRef<{ readonly intent: string; readonly promise: Promise<boolean> } | null>(null);
  const idem = useRef({ resume, decide, increase, retry, unknown });
  const ctx = useRef(context);
  useLayoutEffect(() => {
    idem.current = { resume, decide, increase, retry, unknown };
    ctx.current = context;
  });

  const invalidateAfter = useCallback(
    (req: RunActionRequest) => {
      const runId = 'runId' in req ? req.runId : ctx.current.runId;
      const projectId = ctx.current.projectId ?? (req.action === 'edit_project_allowance' ? req.projectId : undefined);
      if (runId !== undefined && runId !== '') {
        void queryClient.invalidateQueries({ queryKey: qk.run(runId) });
        void queryClient.invalidateQueries({ queryKey: ['step', runId] });
        void queryClient.invalidateQueries({ queryKey: qk.ledger(runId) });
      }
      if (projectId === undefined || projectId === '') {
        void queryClient.invalidateQueries({ queryKey: ['runs'] });
        void queryClient.invalidateQueries({ queryKey: ['project'] });
      } else {
        void queryClient.invalidateQueries({ queryKey: ['runs', projectId] });
        void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
        void queryClient.invalidateQueries({ queryKey: qk.projectCost(projectId) });
      }
    },
    [queryClient],
  );

  const execute = useCallback(
    async (req: RunActionRequest): Promise<boolean> => {
      const plan = planRunAction(req);
      if (plan.kind === 'navigate') {
        void navigate(plan.to);
        return true;
      }
      const m = idem.current;
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
        invalidateAfter(req);
        return true;
      } catch (e) {
        setError(e);
        return false;
      } finally {
        setPending(null);
      }
    },
    [navigate, plainMutateAsync, invalidateAfter],
  );

  const dispatch = useCallback(
    (req: RunActionRequest): Promise<boolean> => {
      const intent = canonicalJson(req);
      const current = inFlight.current;
      if (current !== null) {
        if (current.intent === intent) return current.promise; // double submit of the same request
        const plan = planRunAction(req);
        setError(new IntentInFlightError(plan.kind === 'call' ? plan.channel : undefined));
        return Promise.resolve(false);
      }
      const promise = execute(req).finally(() => {
        inFlight.current = null;
      });
      inFlight.current = { intent, promise };
      return promise;
    },
    [execute],
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return { dispatch, pending, busy: pending !== null, error, clearError };
}
