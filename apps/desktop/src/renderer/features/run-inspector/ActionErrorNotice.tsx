import { InlineAlert } from '../../components/ui';
import { errorTitle, isNotImplemented, toViewError } from '../../api/errors';
import { NotAvailableNotice } from '../common/NotAvailableNotice';

/**
 * The failure of a run action. A runner channel still stubbed in this build (INTERNAL `not_implemented`) shows the
 * NotAvailableNotice; anything else shows the plain message and the stable code. Nothing about the run changed.
 */
export function ActionErrorNotice({ error, fallback }: { readonly error: unknown; readonly fallback?: string }) {
  if (error === null || error === undefined) return null;
  if (isNotImplemented(error)) {
    return (
      <NotAvailableNotice error={error}>
        {fallback ?? 'The run is unchanged. You can stop it, or come back after updating Relay.'}
      </NotAvailableNotice>
    );
  }
  const e = toViewError(error);
  return (
    <InlineAlert tone="danger" title={errorTitle(e)}>
      {errorTitle(e) === e.userMessage ? null : <p>{e.userMessage}</p>}
      <p className="subtle">
        Error code <code>{e.code}</code>. The run is unchanged.
      </p>
    </InlineAlert>
  );
}
