import { InlineAlert } from '../../components/ui';
import { errorTitle, toViewError } from '../../api/errors';

/** The failure of a run action: the plain message and the stable code. Nothing about the run changed. */
export function ActionErrorNotice({ error }: { readonly error: unknown }) {
  if (error === null || error === undefined) return null;
  const e = toViewError(error);
  return (
    <InlineAlert tone="danger" live="assertive" title={errorTitle(e)}>
      {errorTitle(e) === e.userMessage ? null : <p>{e.userMessage}</p>}
      <p className="subtle">
        Error code <code>{e.code}</code>. The run is unchanged.
      </p>
    </InlineAlert>
  );
}
