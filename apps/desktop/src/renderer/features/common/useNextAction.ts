// Next-action routing for ErrorView buttons (10 J2): a page handler when the page owns the behavior, else the
// fixed navigation target from `nextActionTarget`. A next action never silently re-sends the failed operation.
import { useNavigate } from 'react-router';
import type { NextAction } from '@relay/contracts';
import { nextActionTarget } from '../../api/errors';
import type { NextActionContext } from '../../api/errors';

export type NextActionHandlers = Partial<Readonly<Record<NextAction, () => void>>>;

/**
 * Returns an `ErrorView.onAction`: `handlers[action]` when given, otherwise the route from {@link nextActionTarget}.
 * Handler-kind actions the page does not handle (and `dismiss`) do nothing.
 */
export function useNextAction(
  handlers: NextActionHandlers = {},
  ctx: NextActionContext = {},
): (action: NextAction) => void {
  const navigate = useNavigate();
  return (action) => {
    const own = handlers[action];
    if (own !== undefined) {
      own();
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
