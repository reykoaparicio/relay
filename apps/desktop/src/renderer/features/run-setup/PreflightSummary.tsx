import type { ReactNode } from 'react';
import type { Microusd, RunPreflight } from '@relay/contracts';
import { KeyValueList, Money } from '../../components/ui';
import type { KeyValueItem } from '../../components/ui';
import { formatTokensExact, PROVIDER_LABELS } from '../../lib/format';
import { formatBytes } from './PreviewPanel';

export interface PreflightSummaryProps {
  readonly preflight: RunPreflight;
  readonly allowance: Microusd | null;
  /** Rows placed before the computed ones (project, workflow, …). */
  readonly leading?: readonly KeyValueItem[];
  readonly capBytes?: number | undefined;
}

/** Input summary of a preflight: files/bytes/tokens, memory, first reservation (§9.3), and the allowance. */
export function PreflightSummary({ preflight, allowance, leading = [], capBytes }: PreflightSummaryProps) {
  const s = preflight.inputSummary;
  const memoryCount = s.memoryRecords.length;
  const items: KeyValueItem[] = [
    ...leading,
    {
      id: 'files',
      term: 'Files',
      value: `${String(s.files)} · ${formatBytes(s.bytes)}${capBytes === undefined ? '' : ` of ${formatBytes(capBytes)}`}`,
      mono: true,
    },
    {
      id: 'tokens',
      term: 'Input tokens',
      value: `~${formatTokensExact(s.estimatedInputTokens)} est.`,
      mono: true,
    },
    {
      id: 'memory',
      term: 'Memory records',
      value: memoryCount === 0 ? 'None' : `${String(memoryCount)} approved`,
    },
    {
      id: 'first',
      term: 'First reservation',
      value: <Money value={preflight.firstReservation.N} certainty="estimated" />,
    },
    { id: 'allowance', term: 'Run allowance', value: allowance === null ? '—' : <Money value={allowance} /> },
  ];
  return <KeyValueList items={items} />;
}

/** "Providers that will receive this context" (§6.2). */
export function ProvidersReceiving({
  preflight,
  footnote,
}: {
  readonly preflight: RunPreflight;
  readonly footnote?: ReactNode;
}) {
  const ids = preflight.inputSummary.providersReceivingContext;
  return (
    <div className="stack">
      {ids.length === 0 ? (
        <p className="small muted">No provider receives context for this run.</p>
      ) : (
        <ul className="stack small" style={{ margin: 0, paddingLeft: 18 }}>
          {ids.map((id) => (
            <li key={id}>{PROVIDER_LABELS[id]}: the goal, the selected files and the included memory</li>
          ))}
        </ul>
      )}
      {footnote === undefined ? null : <p className="small muted">{footnote}</p>}
    </div>
  );
}
