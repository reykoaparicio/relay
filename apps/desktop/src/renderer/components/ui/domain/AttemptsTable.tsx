import { memo } from 'react';
import type { AttemptView } from '@relay/contracts';
import { formatDuration } from '../../../lib/format/duration';
import { ATTEMPT_PURPOSE_LABELS, PROVIDER_LABELS, stepKeyLabel } from '../../../lib/format/labels';
import { formatTokens, formatTokensExact } from '../../../lib/format/tokens';
import { DataTable } from '../DataTable';
import type { DataTableColumn } from '../DataTable';
import { Money } from '../Money';
import { StatusBadge } from '../StatusBadge';

export interface AttemptsTableProps {
  readonly attempts: readonly AttemptView[];
  readonly caption?: string;
}

function inputTokens(a: AttemptView): number | null {
  if (a.usage === null) return null;
  return a.usage.uncachedInputTokens + a.usage.cacheReadInputTokens + a.usage.cacheWriteInputTokens;
}

/** Usage is provider-reported unless the attempt's cost is estimated or the usage was cut short. */
function tokenBasis(a: AttemptView): string {
  if (a.usage?.partial === true) return 'partial';
  return a.cost?.certainty === 'estimated' ? 'est.' : 'reported';
}

/**
 * Compact count ("12.4k") with the exact count reachable without hover (00b §5: nothing tooltip-only):
 * screen readers hear the exact number in the disclosure's name, and keyboard or pointer users open it.
 */
function Tokens({ n, basis }: { readonly n: number | null; readonly basis: string }) {
  if (n === null) return <span className="subtle">none</span>;
  const compact = formatTokens(n);
  const exact = formatTokensExact(n);
  const tag = <span className="tag">{basis}</span>;
  if (compact === exact) {
    return (
      <span>
        <span className="num">{exact}</span> {tag}
      </span>
    );
  }
  return (
    <span className="tokens">
      <details className="token-exact">
        <summary>
          <span className="num" aria-hidden="true">{compact}</span>
          <span className="sr-only">{`${exact} tokens`}</span>
        </summary>
        <span className="num">{`${exact} exact`}</span>
      </details>{' '}
      {tag}
    </span>
  );
}

/**
 * App time (R3-20): the attempt's total elapsed time (`appElapsedMs`, reserve → finish) minus provider time
 * (`providerLatencyMs`, first byte → finish) — the same split as the streaming attempt card. With no provider time
 * (no first byte), the whole elapsed time is app time.
 */
export function attemptAppTimeMs(a: Pick<AttemptView, 'appElapsedMs' | 'providerLatencyMs'>): number | null {
  if (a.appElapsedMs === null) return null;
  return a.providerLatencyMs === null ? a.appElapsedMs : Math.max(0, a.appElapsedMs - a.providerLatencyMs);
}

function durationCell(ms: number | null) {
  return <span className="num">{ms === null ? '–' : formatDuration(ms)}</span>;
}

const COLUMNS: ReadonlyArray<DataTableColumn<AttemptView>> = [
  { key: 'seq', header: 'Attempt', cell: (a) => <span className="num">#{a.seq}</span> },
  { key: 'step', header: 'Step', cell: (a) => `${stepKeyLabel(a.stepKey)} · ${ATTEMPT_PURPOSE_LABELS[a.purpose]}` },
  {
    key: 'model',
    header: 'Model',
    cell: (a) => (
      <span className="stack" style={{ gap: 0 }}>
        <span>{PROVIDER_LABELS[a.providerId]}</span>
        <span className="mono subtle">{a.modelId}</span>
      </span>
    ),
  },
  { key: 'state', header: 'Dispatch state', cell: (a) => <StatusBadge kind="attempt" value={a.state} /> },
  { key: 'in', header: 'Tokens in', numeric: true, cell: (a) => <Tokens n={inputTokens(a)} basis={tokenBasis(a)} /> },
  { key: 'out', header: 'Tokens out', numeric: true, cell: (a) => <Tokens n={a.usage?.outputTokens ?? null} basis={tokenBasis(a)} /> },
  {
    key: 'cost',
    header: 'Cost',
    numeric: true,
    cell: (a) => (a.cost === null ? <span className="subtle">none</span> : <Money value={a.cost.microusd} certainty={a.cost.certainty} />),
  },
  // §3.3 / R3-20: provider time and app time are shown separately.
  {
    key: 'provider-latency',
    header: 'Provider time',
    numeric: true,
    cell: (a) => durationCell(a.providerLatencyMs),
  },
  {
    key: 'app-time',
    header: 'App time',
    numeric: true,
    cell: (a) => durationCell(attemptAppTimeMs(a)),
  },
];

function AttemptsTableView({ attempts, caption = 'Attempts for this run' }: AttemptsTableProps) {
  return (
    <div className="stack">
      <DataTable
        caption={caption}
        columns={COLUMNS}
        rows={attempts}
        getRowKey={(a) => a.id}
        emptyState={<p className="subtle">No attempts yet. Nothing has been sent to a provider.</p>}
      />
      <p className="subtle">
        Token counts are provider-reported unless marked <span className="tag">est.</span> Each retry is a new attempt;
        earlier attempts are never overwritten.
      </p>
    </div>
  );
}

/** Memoized (PERF-02): re-renders only when its props change, not on every parent tick. */
export const AttemptsTable = memo(AttemptsTableView);
