import type { ReactNode } from 'react';
import { Button } from './Button';
import { InlineAlert } from './InlineAlert';

export interface ServerChangesNoticeProps {
  /** E.g. "This project changed since you started editing". */
  readonly title: ReactNode;
  /** What happened to the user's edits (default: nothing was overwritten). */
  readonly intro?: ReactNode;
  /** The explicit choice that keeps the user's changes on top of the newer version. */
  readonly keepLabel: string;
  readonly onKeep: () => void;
  readonly keepPending?: boolean;
  readonly keepDisabled?: boolean;
  /** The comparison (a table or two lists) of what changed on each side. */
  readonly children?: ReactNode;
}

/**
 * A newer server version arrived while the user had edits (DUP-01, `useRebasableForm`): nothing was overwritten, the
 * comparison is shown, and keeping the user's changes is an explicit action. Polite live region: it appears without
 * the user acting and they should hear about it.
 */
export function ServerChangesNotice({
  title,
  intro = 'Nothing was overwritten. Your edits are kept in the form.',
  keepLabel,
  onKeep,
  keepPending = false,
  keepDisabled = false,
  children,
}: ServerChangesNoticeProps) {
  return (
    <InlineAlert
      tone="warning"
      live="polite"
      title={title}
      actions={
        <Button size="sm" variant="primary" pending={keepPending} disabled={keepDisabled} onClick={onKeep}>
          {keepLabel}
        </Button>
      }
    >
      <p>{intro}</p>
      {children}
    </InlineAlert>
  );
}
