import type { AppError, NextAction } from '@relay/contracts';
import { NEXT_ACTION_LABELS } from '../../lib/format/actions';
import { Button } from './Button';
import { InlineAlert } from './InlineAlert';

export interface ErrorViewProps {
  readonly error: AppError;
  /** Called with the chosen next action; the page maps it to an operation (10 J8). */
  readonly onAction: (action: NextAction) => void;
  readonly title?: string;
  readonly pendingAction?: NextAction | null;
}

/** Renders an AppError: plain message, stable code, and one button per next action (09 I3 `.banner.danger`). */
export function ErrorView({ error, onAction, title, pendingAction = null }: ErrorViewProps) {
  const actions = [error.nextAction, ...error.alternatives].filter(
    (a, i, all): a is NextAction => a !== 'none' && all.indexOf(a) === i,
  );
  return (
    <InlineAlert
      tone="danger"
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
