import type { ReactNode } from 'react';
import { ErrorView } from '../../components/ui';
import { errorTitle, isNotImplemented, toViewError } from '../../api/errors';
import { NotAvailableNotice } from './NotAvailableNotice';
import { useNextAction } from './useNextAction';
import type { NextActionHandlers } from './useNextAction';

export interface MutationErrorProps {
  /** The failed mutation's error; nothing renders when null/undefined. */
  readonly error: unknown;
  /** What still works when the channel is not implemented in this build (NotAvailableNotice body). */
  readonly unavailableHint?: ReactNode;
  /** Page handlers for next actions (e.g. `reload` → refetch). Unhandled actions route as usual. */
  readonly handlers?: NextActionHandlers;
}

/**
 * The error of a command: "Not available yet in this build" for a stubbed runner channel (no retry buttons),
 * otherwise an ErrorView with the error's next actions.
 */
export function MutationError({ error, unavailableHint, handlers = {} }: MutationErrorProps) {
  const onAction = useNextAction(handlers);
  if (error === null || error === undefined) return null;
  if (isNotImplemented(error)) return <NotAvailableNotice error={error}>{unavailableHint}</NotAvailableNotice>;
  const view = toViewError(error);
  const title = errorTitle(view);
  return <ErrorView error={view} {...(title === view.userMessage ? {} : { title })} onAction={onAction} />;
}
