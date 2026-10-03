// Next-action routing for ErrorView buttons (10 J2): a page handler when the page owns the behavior, else the
// fixed navigation target from `nextActionTarget`. A next action never silently re-sends the failed operation.
import { useContext, useRef } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { NextAction } from '@relay/contracts';
import { call } from '../../api/client';
import { nextActionTarget } from '../../api/errors';
import type { NextActionContext } from '../../api/errors';

export type NextActionHandlers = Partial<Readonly<Record<NextAction, () => void>>>;

/**
 * Returns an `ErrorView.onAction`: `handlers[action]` when given, otherwise the route from {@link nextActionTarget}.
 * `restart_runner` restarts the runner in place (`app.restartRunner`; queries refetch when it is back). Other
 * handler-kind actions the page does not handle (and `dismiss`) do nothing.
 */
export function useNextAction(
  handlers: NextActionHandlers = {},
  ctx: NextActionContext = {},
): (action: NextAction) => void {
  const navigate = useNavigate();
  // Optional context: next actions also render in isolated component tests without a QueryClient.
  const queryClient = useContext(QueryClientContext);
  const restarting = useRef(false);
  return (action) => {
    const own = handlers[action];
    if (own !== undefined) {
      own();
      return;
    }
    if (action === 'restart_runner') {
      // Restart in place; when the runner is back every query refetches (they failed while it was down). A restart
      // that fails again is reported by the runner banner (runner.state push) and Settings → Diagnostics.
      if (restarting.current) return;
      restarting.current = true;
      void call('relay/v1/app.restartRunner', {})
        .then((res) => {
          if (res.state === 'ready') void queryClient?.invalidateQueries();
        })
        .catch(() => undefined)
        .finally(() => {
          restarting.current = false;
          void queryClient?.invalidateQueries({ queryKey: ['diagnostics'] });
        });
      return;
    }
    const target = nextActionTarget(action, ctx);
    if (target.kind === 'navigate') void navigate(target.to);
  };
}

/** `useNextAction` for a failed load: "Reload" / "Try again later" refetch; the rest route as usual. */
export function useRetryAction(retry: () => void, ctx: NextActionContext = {}): (action: NextAction) => void {
  return useNextAction({ reload: retry, wait: retry }, ctx);
}
