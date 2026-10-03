import { memo, useMemo } from 'react';
import type { AttemptView } from '@relay/contracts';
import { formatDuration } from '../../../lib/format/duration';
import { ATTEMPT_PURPOSE_LABELS, PROVIDER_LABELS, stepKeyLabel } from '../../../lib/format/labels';
import { formatTokens, formatTokensExact } from '../../../lib/format/tokens';
import { DataTable } from '../DataTable';
import { Disclosure } from '../Disclosure';
import { KeyValueList } from '../KeyValueList';
import type { DataTableColumn } from '../DataTable';
import { Money } from '../Money';
import { StatusBadge } from '../StatusBadge';

export interface AttemptsTableProps {
  readonly attempts: readonly AttemptView[];
  readonly caption?: string;
  /**
   * Run-level view (attempts of several steps): the Step column names the step too ("Implement · Retry"), using this
   * display name per step key (E1 `stepMeta`, else the key label). Omitted → the purpose only (one step's attempts).
   */
  readonly stepNameFor?: (stepKey: string) => string;
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

/** Short purpose text for the narrow Step column ("Repair", not "Review input · Schema repair"). */
const PURPOSE_SHORT: Readonly<Record<AttemptView['purpose'], string>> = {
  initial: 'Initial',
  transport_retry: 'Retry',
  schema_repair: 'Repair',
  user_retry: 'Your retry',
  reconcile: 'Reconcile',
};

/**
 * Provider time and app time (§3.3 / R3-20, shown separately) behind a per-attempt "Timing" toggle. Its accessible name
 * says which attempt ("Timing for attempt #2"): a list of identical "Timing" toggles gives no context.
 */
function Timing({ a }: { readonly a: AttemptView }) {
  return (
    <Disclosure
      summary={
        <>
          <span>Timing</span>
          <span className="sr-only"> for attempt #{a.seq}</span>
        </>
      }
      className="attempt-timing"
    >
      <KeyValueList
        className="small"
        items={[
          { id: 'provider', term: 'Provider time', value: durationCell(a.providerLatencyMs) },
          { id: 'app', term: 'App time', value: durationCell(attemptAppTimeMs(a)) },
        ]}
      />
    </Disclosure>
  );
}

function columnsFor(stepNameFor: ((stepKey: string) => string) | undefined): ReadonlyArray<DataTableColumn<AttemptView>> {
  return [
    {
      key: 'seq',
      header: 'Attempt',
      cell: (a) => (
        <span className="stack" style={{ gap: 2 }}>
          <span className="num">#{a.seq}</span>
          <Timing a={a} />
        </span>
      ),
    },
    {
      key: 'step',
      header: 'Step',
      nowrap: true,
      cell: (a) => {
        const name = stepNameFor?.(a.stepKey);
        return (
          <span title={`${name ?? stepKeyLabel(a.stepKey)} · ${ATTEMPT_PURPOSE_LABELS[a.purpose]}`}>
            {name === undefined ? PURPOSE_SHORT[a.purpose] : `${name} · ${PURPOSE_SHORT[a.purpose]}`}
          </span>
        );
      },
    },
    {
      key: 'model',
      header: 'Model',
      cell: (a) => (
        <span className="stack" style={{ gap: 0 }}>
          <span>{PROVIDER_LABELS[a.providerId]}</span>
          <span className="mono subtle whitespace-nowrap">{a.modelId}</span>
        </span>
      ),
    },
    { key: 'state', header: 'Dispatch state', cell: (a) => <StatusBadge kind="attempt" value={a.state} /> },
    {
      key: 'tokens',
      header: 'Tokens in / out',
      numeric: true,
      // One column for both counts keeps the table inside the step panel (the cost column is never cut off).
      cell: (a) => (
        <span className="stack" style={{ gap: 2, alignItems: 'flex-end' }}>
          <span>
            <span className="sr-only">In: </span>
            <Tokens n={inputTokens(a)} basis={tokenBasis(a)} />
          </span>
          <span>
            <span className="sr-only">Out: </span>
            <Tokens n={a.usage?.outputTokens ?? null} basis={tokenBasis(a)} />
          </span>
        </span>
      ),
    },
    {
      key: 'cost',
      header: 'Cost',
      numeric: true,
      cell: (a) => (a.cost === null ? <span className="subtle">none</span> : <Money value={a.cost.microusd} certainty={a.cost.certainty} />),
    },
  ];
}

/** The single-step columns (no step name), shared by every instance. */
const COLUMNS = columnsFor(undefined);

function AttemptsTableView({ attempts, caption = 'Attempts for this run', stepNameFor }: AttemptsTableProps) {
  const columns = useMemo(() => (stepNameFor === undefined ? COLUMNS : columnsFor(stepNameFor)), [stepNameFor]);
  return (
    <div className="stack">
      <DataTable
        caption={caption}
        columns={columns}
        rows={attempts}
        getRowKey={(a) => a.id}
        emptyState={<p className="subtle">No attempts yet. Nothing has been sent to a provider.</p>}
      />
      <p className="subtle">
        Token counts are provider-reported unless marked <span className="tag">est.</span> Each retry is a new attempt;
        earlier attempts are never overwritten. Timing shows provider time and app time separately.
      </p>
    </div>
  );
}

/** Memoized (PERF-02): re-renders only when its props change, not on every parent tick. */
export const AttemptsTable = memo(AttemptsTableView);
