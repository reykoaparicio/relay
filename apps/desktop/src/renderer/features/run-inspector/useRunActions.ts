import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { InputOf, RunAction } from '@relay/contracts';
import { call } from '../../api/client';
import { qk } from '../../api/keys';
import { canonicalJson, IntentInFlightError, useIdempotentMutation } from '../../hooks/useIdempotentMutation';
import type { IdempotentMutation } from '../../hooks/useIdempotentMutation';
import { planRunAction } from './run-actions';
import type { IdemCallPlan, PlainCallPlan, RunActionRequest, RunIdemChannel, RunPlainChannel } from './run-actions';

/** One idempotent mutation per run-action channel: a channel added to the action→op table is a compile error here. */
type RunIdemMutations = { readonly [C in RunIdemChannel]: IdempotentMutation<C> };

function sendIdem<C extends RunIdemChannel>(mutations: RunIdemMutations, plan: IdemCallPlan<C>): Promise<unknown> {
  const mutation: IdempotentMutation<C> = mutations[plan.channel];
  return mutation.mutateAsync(plan.input);
}

type AnyPlainCallPlan = { [C in RunPlainChannel]: PlainCallPlan<C> }[RunPlainChannel];

function sendPlain<C extends RunPlainChannel>(channel: C, input: InputOf<C>): Promise<unknown> {
  return call(channel, input);
}

export interface RunActionsApi {
  /**
   * Executes a request; resolves true on success, false on failure (the error is in `error`). The same request while
   * it is in flight is deduped; a different request while any action is in flight is rejected with
   * {@link IntentInFlightError} (in `error`) and never sent.
   */
  readonly dispatch: (req: RunActionRequest) => Promise<boolean>;
  /** The action in flight for the displayed run (its button shows pending). */
  readonly pending: RunAction | null;
  /**
   * True while any run action is in flight, for this run or one shown before it (navigating between runs does not
   * cancel a request): every run-action control stays disabled.
   */
  readonly busy: boolean;
  /** The last action error for the displayed run; another run's error is never shown here. */
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
  const idemMutations: RunIdemMutations = {
    'relay/v1/runs.resume': useIdempotentMutation('relay/v1/runs.resume'),
    'relay/v1/approvals.decide': useIdempotentMutation('relay/v1/approvals.decide'),
    'relay/v1/runs.increaseAllowance': useIdempotentMutation('relay/v1/runs.increaseAllowance'),
    'relay/v1/runs.retryStep': useIdempotentMutation('relay/v1/runs.retryStep'),
    'relay/v1/runs.decideUnknown': useIdempotentMutation('relay/v1/runs.decideUnknown'),
  };
  const { mutateAsync: plainMutateAsync } = useMutation({
    mutationFn: (plan: AnyPlainCallPlan) => sendPlain(plan.channel, plan.input),
  });
  // Pending action and error are kept with the run they belong to (`context.runId` at dispatch): the inspector keeps
  // this hook mounted from one run to the next, and run A's spinner or error must not show on run B.
  const [pendingState, setPending] = useState<{ readonly runId: string | undefined; readonly action: RunAction } | null>(null);
  const [errorState, setErrorState] = useState<{ readonly runId: string | undefined; readonly error: unknown } | null>(null);
  const inFlight = useRef<{ readonly intent: string; readonly promise: Promise<boolean> } | null>(null);
  const idem = useRef(idemMutations);
  const ctx = useRef(context);
  useLayoutEffect(() => {
    idem.current = idemMutations;
    ctx.current = context;
  });
  const setError = useCallback((e: unknown) => {
    setErrorState(e === null ? null : { runId: ctx.current.runId, error: e });
  }, []);

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
      // The run the action was started from owns its outcome, even when it settles after a navigation.
      const owner = ctx.current.runId;
      setPending({ runId: owner, action: req.action });
      setError(null);
      try {
        if (plan.idempotent) await sendIdem(idem.current, plan);
        else await plainMutateAsync(plan);
        invalidateAfter(req);
        return true;
      } catch (e) {
        setErrorState({ runId: owner, error: e });
        return false;
      } finally {
        setPending(null);
      }
    },
    [navigate, plainMutateAsync, invalidateAfter, setError],
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
    [execute, setError],
  );

  const clearError = useCallback(() => {
    setError(null);
  }, [setError]);

  const runId = context.runId;
  const pending = pendingState !== null && pendingState.runId === runId ? pendingState.action : null;
  const error = errorState !== null && errorState.runId === runId ? errorState.error : null;
  const busy = pendingState !== null;
  return useMemo(() => ({ dispatch, pending, busy, error, clearError }), [dispatch, pending, busy, error, clearError]);
}
