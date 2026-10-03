import { Button, InlineAlert } from '../../components/ui';
import { errorTitle, toViewError } from '../../api/errors';

/** The failure of a run action: the plain message and the stable code. Nothing about the run changed. */
export function ActionErrorNotice({ error }: { readonly error: unknown }) {
  if (error === null || error === undefined) return null;
  const e = toViewError(error);
  return (
    <InlineAlert tone="danger" live="assertive" title={errorTitle(e, 'command')}>
      {errorTitle(e, 'command') === e.userMessage ? null : <p>{e.userMessage}</p>}
      <p className="subtle">
        Error code <code>{e.code}</code>. The run is unchanged.
      </p>
    </InlineAlert>
  );
}

/**
 * A failed load of something shown on the page (not an action): a neutral note, never an assertive alert, and nothing
 * about the run being unchanged (nothing was attempted on it). `what`: "This manifest".
 */
export function LoadErrorNotice({ error, what, onRetry }: { readonly error: unknown; readonly what: string; readonly onRetry?: () => void }) {
  const e = toViewError(error);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <p className="subtle">
        {what} could not be loaded: {errorTitle(e)}
      </p>
      <p className="subtle small">
        Error code <code>{e.code}</code>
      </p>
      {onRetry === undefined ? null : (
        <div>
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
