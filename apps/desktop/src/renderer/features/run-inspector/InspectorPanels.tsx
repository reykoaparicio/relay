// Events, Ledger, and Context-summary panels of the run inspector (10 J8).
import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Download } from 'lucide-react';
import { microusd, stepStateSchema } from '@relay/contracts';
import type { ContextManifest, LedgerEntryView, RunDetail, RunEvent } from '@relay/contracts';
import { Button, DataTable, Hash, KeyValueList, Money, Skeleton } from '../../components/ui';
import type { DataTableColumn } from '../../components/ui';
import { formatAbsoluteTime, formatTokens, statusPresentation } from '../../lib/format';
import { ActionErrorNotice } from './ActionErrorNotice';
import { stepTitle } from './inspector-model';

// ---------------------------------------------------------------------------------------------------------------
// Events

/** Above this many rows the list is virtualized (keeps long runs responsive, §3.3). */
export const EVENTS_VIRTUALIZE_THRESHOLD = 300;
const EVENT_ROW_PX = 32;

/** One-line, redacted summary of an event payload (no content; payloads are already redacted, 02 B5). */
export function eventSummary(e: RunEvent): string {
  const p = e.payload;
  const stepKey = typeof p['stepKey'] === 'string' ? stepTitle({ stepKey: p['stepKey'] }) : null;
  if (e.type === 'run.status_changed') {
    const to = typeof p['to'] === 'string' ? p['to'] : '';
    return `Run status: ${to.replaceAll('_', ' ')}${typeof p['pauseReason'] === 'string' ? ` (${p['pauseReason'].replaceAll('_', ' ')})` : ''}`;
  }
  if (e.type === 'step.state_changed') {
    const to = stepStateSchema.safeParse(p['to']);
    return `${stepKey ?? 'Step'}: ${to.success ? statusPresentation('step', to.data).label : 'changed'}`;
  }
  if (e.type === 'approval.decided') {
    return `Approval: ${typeof p['decision'] === 'string' ? p['decision'].replaceAll('_', ' ') : 'decided'}`;
  }
  return stepKey === null ? e.type : `${e.type} · ${stepKey}`;
}

function EventRow({ e }: { readonly e: RunEvent }) {
  return (
    <>
      <span className="num subtle">{e.seq}</span>{' '}
      <time className="num subtle" dateTime={new Date(e.at).toISOString()}>
        {formatAbsoluteTime(e.at)}
      </time>{' '}
      <code>{e.type}</code> <span>{eventSummary(e)}</span>
    </>
  );
}

function VirtualEvents({ events, label }: { readonly events: readonly RunEvent[]; readonly label: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns fresh functions by design
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => EVENT_ROW_PX,
    overscan: 20,
  });
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be keyboard reachable
    <div ref={scrollRef} style={{ maxHeight: 480, overflowY: 'auto' }} tabIndex={0} role="region" aria-label={`${label}, scrollable`}>
      <ol style={{ height: virtualizer.getTotalSize(), position: 'relative', listStyle: 'none', margin: 0, padding: 0 }}>
        {virtualizer.getVirtualItems().map((item) => {
          const e = events[item.index];
          if (e === undefined) return null;
          return (
            <li
              key={item.key}
              className="small"
              style={{ position: 'absolute', top: 0, left: 0, right: 0, height: EVENT_ROW_PX, transform: `translateY(${String(item.start)}px)` }}
            >
              <EventRow e={e} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function EventItems({ events, label }: { readonly events: readonly RunEvent[]; readonly label: string }) {
  if (events.length > EVENTS_VIRTUALIZE_THRESHOLD) return <VirtualEvents events={events} label={label} />;
  return (
    <ol className="stack small" aria-label={label} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {events.map((e) => (
        <li key={e.id}>
          <EventRow e={e} />
        </li>
      ))}
    </ol>
  );
}

export interface EventsListProps {
  /** Events whose payload names the selected row (`stepRunId` / `stepRunIds[]`), oldest first. */
  readonly events: readonly RunEvent[];
  /** Legacy events naming only the step key: listed apart, since they may belong to any row of that step. */
  readonly runLevel?: readonly RunEvent[];
  readonly loaded: boolean;
}

/** Events of the selected step row, oldest first, plus a separate run-level group for legacy step-key-only events. */
export function EventsList({ events, runLevel = [], loaded }: EventsListProps) {
  if (!loaded && events.length === 0 && runLevel.length === 0) return <Skeleton lines={4} />;
  return (
    <div className="stack">
      {events.length === 0 ? (
        <p className="subtle">No events for this step yet.</p>
      ) : (
        <EventItems events={events} label="Events for this step" />
      )}
      {runLevel.length === 0 ? null : (
        <div className="stack">
          <h3 className="section-label">Run-level events</h3>
          <p className="subtle small">
            These older events name the step but not a specific attempt, so they may belong to any attempt of this step.
          </p>
          <EventItems events={runLevel} label="Run-level events" />
        </div>
      )}
      <p className="subtle small">Payloads are redacted. No hidden model reasoning is recorded or shown.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Ledger (run-scoped)

const LEDGER_COLUMNS: ReadonlyArray<DataTableColumn<LedgerEntryView>> = [
  {
    key: 'created',
    header: 'Created',
    cell: (e) => (
      <time className="num whitespace-nowrap" dateTime={new Date(e.createdAt).toISOString()}>
        {formatAbsoluteTime(e.createdAt)}
      </time>
    ),
  },
  { key: 'step', header: 'Step', cell: (e) => (e.stepKey === null ? '—' : stepTitle({ stepKey: e.stepKey })) },
  { key: 'attempt', header: 'Attempt', cell: (e) => (e.attemptId === null ? '—' : <span className="mono">…{e.attemptId.slice(-6)}</span>) },
  { key: 'type', header: 'Type', cell: (e) => e.type.replaceAll('_', ' ') },
  { key: 'bucket', header: 'Bucket', cell: (e) => e.bucket },
  {
    key: 'delta',
    header: 'Delta',
    numeric: true,
    cell: (e) => (
      <span className="num whitespace-nowrap">
        {e.deltaMicrousd > 0 ? '+' : e.deltaMicrousd < 0 ? '−' : ''}
        <Money value={microusd(Math.abs(e.deltaMicrousd))} />
      </span>
    ),
  },
  { key: 'certainty', header: 'Certainty', cell: (e) => e.certainty ?? '—' },
  { key: 'catalog', header: 'Price catalog', cell: (e) => (e.priceCatalogVersion === null ? '—' : <span className="mono">{e.priceCatalogVersion}</span>) },
];

export interface LedgerPanelProps {
  readonly runLabel: string;
  readonly entries: readonly LedgerEntryView[] | undefined;
  readonly error: unknown;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => void;
  readonly onExport: () => void;
  readonly exporting: boolean;
  readonly exportError: unknown;
  readonly exportedTo: string | null;
}

/** Append-only ledger of the run, oldest first, with "Export ledger (CSV)" → `ledger.export({ runId })`. */
export function LedgerPanel(p: LedgerPanelProps) {
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <p className="subtle">
          Append-only ledger for {p.runLabel}. Corrections are new entries; nothing is edited in place. Tracked by Relay; your
          provider invoice may differ.
        </p>
        <Button icon={Download} pending={p.exporting} onClick={p.onExport}>
          Export ledger (CSV)
        </Button>
      </div>
      {p.exportedTo === null ? null : (
        <p className="small" role="status">
          Ledger exported to <span className="mono">{p.exportedTo}</span>.
        </p>
      )}
      <ActionErrorNotice error={p.exportError} fallback="The ledger is unchanged; retry the export." />
      {p.error !== null && p.error !== undefined ? (
        <ActionErrorNotice error={p.error} />
      ) : p.entries === undefined ? (
        <Skeleton lines={5} />
      ) : (
        <DataTable
          caption={`Ledger entries for ${p.runLabel}, oldest first`}
          columns={LEDGER_COLUMNS}
          rows={p.entries}
          getRowKey={(e) => e.id}
          emptyState={<p className="subtle">No ledger entries yet.</p>}
        />
      )}
      {p.hasMore ? (
        <div className="actions">
          <Button pending={p.loadingMore} onClick={p.onLoadMore}>
            Load more entries
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Context summary (bottom row / narrow tab)

export function ContextSummary({
  run,
  manifest,
  onInspect,
}: {
  readonly run: RunDetail;
  readonly manifest: ContextManifest | null | undefined;
  readonly onInspect: () => void;
}) {
  if (manifest === undefined) return <Skeleton lines={3} />;
  if (manifest === null) {
    return (
      <div className="stack small">
        <p>This step sent no context to a provider.</p>
        {run.contextHash === null ? null : (
          <p>
            Run snapshot <Hash value={run.contextHash} label="context hash" />
          </p>
        )}
      </div>
    );
  }
  const included = manifest.files.filter((f) => f.included).length;
  const memory = manifest.memory.filter((m) => m.included).length;
  return (
    <div className="stack">
      <KeyValueList
        items={[
          {
            id: 'files',
            term: 'Source files',
            value: `${String(included)}${manifest.omitted.length > 0 ? ` (${String(manifest.omitted.length)} omitted)` : ''}`,
          },
          { id: 'memory', term: 'Approved memory records', value: String(memory) },
          { id: 'snapshot', term: 'Snapshot', value: <Hash value={manifest.contextHash} label="context hash" /> },
          { id: 'tokens', term: 'Input tokens', value: `${formatTokens(manifest.tokens.estimatedInput)} est.` },
        ]}
      />
      <div className="actions">
        <Button size="sm" variant="ghost" onClick={onInspect}>
          Inspect sources
        </Button>
      </div>
    </div>
  );
}
