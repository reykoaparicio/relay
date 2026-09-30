import type { ReactNode } from 'react';
import { ErrorView } from '../../components/ui';
import { NOT_AVAILABLE_TITLE, notAvailableError } from '../../api/errors';

export interface NotAvailableNoticeProps {
  /** The thrown not-implemented error (see `isNotImplemented`). */
  readonly error: unknown;
  /** What the user can do instead (shown under the message). */
  readonly children?: ReactNode;
}

/**
 * A runner channel that is still stubbed in this build (INTERNAL `not_implemented`): an ErrorView titled
 * "Not available yet in this build", without retry buttons, plus the way forward.
 */
export function NotAvailableNotice({ error, children }: NotAvailableNoticeProps) {
  return (
    <div className="stack">
      <ErrorView error={notAvailableError(error)} title={NOT_AVAILABLE_TITLE} onAction={() => undefined} />
      {children === undefined ? null : <div className="small muted">{children}</div>}
    </div>
  );
}
