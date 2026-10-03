// Request facts of an attempt whose outcome is unknown (E1, §4.4): the provider's request id (copyable, to ask the
// provider about the charge) and when Relay dispatched it. Shown wherever an unknown request is decided.
import type { AttemptView } from '@relay/contracts';
import { CopyButton, KeyValueList } from '../../components/ui';
import { formatAbsoluteTime, toIsoString } from '../../lib/format';

export interface RequestFactsProps {
  readonly attempt: Pick<AttemptView, 'id' | 'providerRequestId' | 'startedAt'>;
  /** Names the attempt in the copy button's accessible name (e.g. "Implement · attempt 1"). */
  readonly label: string;
}

/** "Provider request id" (copyable, or "No request id was recorded") and "Sent" (the dispatch time). */
export function RequestFacts({ attempt, label }: RequestFactsProps) {
  return (
    <KeyValueList
      className="small"
      items={[
        {
          id: 'request-id',
          term: 'Provider request id',
          value:
            attempt.providerRequestId === null ? (
              <span className="subtle">No request id was recorded</span>
            ) : (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="mono">{attempt.providerRequestId}</span>
                <CopyButton
                  value={attempt.providerRequestId}
                  label={`Copy provider request id of ${label}`}
                />
              </span>
            ),
        },
        {
          id: 'sent',
          term: 'Sent',
          value: (
            <time dateTime={toIsoString(attempt.startedAt)}>{formatAbsoluteTime(attempt.startedAt)}</time>
          ),
        },
      ]}
    />
  );
}
