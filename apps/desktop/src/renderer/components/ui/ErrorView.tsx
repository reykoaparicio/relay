import type { AppError, NextAction } from '@relay/contracts';
import { DATABASE_BUSY_MESSAGE, NEXT_ACTION_LABELS } from '../../lib/format/actions';
import { Button } from './Button';
import { InlineAlert } from './InlineAlert';
import type { InlineAlertLive } from './InlineAlert';

export interface ErrorViewProps {
  readonly error: AppError;
  /** Called with the chosen next action; the page maps it to an operation (10 J8). */
  readonly onAction: (action: NextAction) => void;
  readonly title?: string;
  readonly pendingAction?: NextAction | null;
  /** `'assertive'` when the error answers the user's own submit (a failed command); default `'off'` (load errors). */
  readonly live?: InlineAlertLive;
}

/** E2 #2: another program holds the database lock — a wait, not a crash (no error code, no danger tone). */
function isBusy(error: AppError): boolean {
  return error.code === 'DATABASE_UNAVAILABLE' && error.details?.['reason'] === 'database_busy';
}

/** Renders an AppError: plain message, stable code, and one button per next action (09 I3 `.banner.danger`). */
export function ErrorView({ error, onAction, title, pendingAction = null, live = 'off' }: ErrorViewProps) {
  const actions = [error.nextAction, ...error.alternatives].filter(
    (a, i, all): a is NextAction => a !== 'none' && all.indexOf(a) === i,
  );
  if (isBusy(error)) {
    return (
      <InlineAlert
        tone="info"
        live={live}
        title={DATABASE_BUSY_MESSAGE}
        actions={
          <Button pending={pendingAction === 'wait'} onClick={() => { onAction('wait'); }}>
            Try again now
          </Button>
        }
      >
        <p>Close other copies of Relay or programs that open its data folder if this keeps happening.</p>
      </InlineAlert>
    );
  }
  return (
    <InlineAlert
      tone="danger"
      live={live}
      title={title ?? error.userMessage}
      actions={
        actions.length > 0
          ? actions.map((a, i) => (
              <Button
                key={a}
                variant={i === 0 ? 'primary' : 'secondary'}
                pending={pendingAction === a}
                disabled={pendingAction !== null && pendingAction !== a}
                onClick={() => { onAction(a); }}
              >
                {NEXT_ACTION_LABELS[a]}
              </Button>
            ))
          : undefined
      }
    >
      {title === undefined ? null : <p>{error.userMessage}</p>}
      <p className="subtle">
        Error code <code>{error.code}</code>
        {error.correlationId === undefined ? null : (
          <>
            {' '}· reference <code>{error.correlationId}</code>
          </>
        )}
      </p>
    </InlineAlert>
  );
}
