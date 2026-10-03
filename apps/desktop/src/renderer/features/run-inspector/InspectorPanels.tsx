// Events, Ledger, and Context-summary panels of the run inspector (10 J8).
import { memo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Download } from 'lucide-react';
import { approvalDecisionSchema, microusd, pauseReasonSchema, runStatusSchema, stepStateSchema } from '@relay/contracts';
import type { ContextManifest, CostCertainty, LedgerEntryView, RunDetail, RunEvent, RunEventType } from '@relay/contracts';
import { Button, DataTable, Hash, KeyValueList, Money, Skeleton } from '../../components/ui';
import type { DataTableColumn } from '../../components/ui';
import {
  APPROVAL_DECISION_LABELS,
  formatAbsoluteTime,
  formatClockTime,
  formatMoney,
  formatTokens,
  statusPresentation,
  toIsoString,
} from '../../lib/format';
import { ActionErrorNotice } from './ActionErrorNotice';
import { stepTitle } from './inspector-model';

// ---------------------------------------------------------------------------------------------------------------
// Events

/** Above this many rows the list is virtualized (keeps long runs responsive, §3.3). */
export const EVENTS_VIRTUALIZE_THRESHOLD = 300;
const EVENT_ROW_PX = 32;

function payloadMoney(p: Readonly<Record<string, unknown>>, key: string): string | null {
  const v = p[key];
  return typeof v === 'number' && Number.isInteger(v) ? formatMoney(microusd(v)) : null;
}

/** Plain-language summary per event type (exhaustive: a new contracts type is a compile error here). */
const EVENT_SUMMARY: { readonly [T in RunEventType]: (p: Readonly<Record<string, unknown>>, step: string | null) => string } = {
  'run.created': () => 'Run created',
  'run.status_changed': (p) => {
    const to = runStatusSchema.safeParse(p['to'] ?? p['status']);
    const reason = pauseReasonSchema.safeParse(p['pauseReason']);
    return to.success ? `Run: ${statusPresentation('run', to.data, reason.success ? reason.data : null).label}` : 'Run status changed';
  },
  'run.config_revised': () => 'Run configuration revised',
  'step.state_changed': (p, step) => {
    const to = stepStateSchema.safeParse(p['to']);
    return `${step ?? 'Step'}: ${to.success ? statusPresentation('step', to.data).label : 'changed'}`;
  },
  'attempt.created': (p, step) =>
    `${step ?? 'Step'}: request prepared${typeof p['seq'] === 'number' ? ` (attempt #${String(p['seq'])})` : ''}`,
  'attempt.dispatching': (_p, step) => `${step ?? 'Step'}: request sent to the provider`,
  'attempt.stream_progress': (_p, step) => `${step ?? 'Step'}: receiving output`,
  'attempt.settled': (_p, step) => `${step ?? 'Step'}: request finished`,
  'attempt.unknown': (_p, step) => `${step ?? 'Step'}: request may not have completed (cost estimated)`,
  'ledger.reserved': (p) => {
    const n = payloadMoney(p, 'N');
    return n === null ? 'Budget reserved for the request' : `Budget reserved: ${n}`;
  },
  'ledger.settled': () => 'Cost recorded in the ledger',
  'ledger.blocked': () => 'Budget check stopped the next request',
  'ledger.overrun': (p) => {
    const n = payloadMoney(p, 'N');
    const x = payloadMoney(p, 'X');
    return n === null || x === null ? 'Cost exceeded the reservation' : `Cost exceeded the reservation: ${x} vs ${n} reserved`;
  },
  'approval.requested': () => 'Approval requested',
  'approval.decided': (p) => {
    const d = approvalDecisionSchema.safeParse(p['decision']);
    return d.success ? `Approval: ${APPROVAL_DECISION_LABELS[d.data]}` : 'Approval decided';
  },
  'artifact.created': (_p, step) => (step === null ? 'Output saved' : `${step}: output saved`),
  'artifact.write_failed': (_p, step) => (step === null ? 'An output could not be saved' : `${step}: output could not be saved`),
  'memory.suggested': () => 'Memory suggestion proposed',
  'context.assembled': (_p, step) => (step === null ? 'Context assembled' : `${step}: context assembled`),
  'error.recorded': (p) => (typeof p['userMessage'] === 'string' ? `Problem recorded: ${p['userMessage']}` : 'Problem recorded'),
  'run.limits_raised': () => 'Run limits raised',
  'report.created': (p) => (p['refreshed'] === true ? 'Run report updated with the settled cost' : 'Run report created'),
  'run.snapshot_preserved': () => 'Context snapshot preserved',
};

/** One-line, redacted summary of an event payload (no content; payloads are already redacted, 02 B5). */
export function eventSummary(e: RunEvent): string {
  const p = e.payload;
  const step = typeof p['stepKey'] === 'string' ? stepTitle({ stepKey: p['stepKey'] }) : null;
  return EVENT_SUMMARY[e.type](p, step);
}

/** "#28 · 5:24 PM  Approval requested"; the raw event type and full date are in the tooltip. */
function EventRow({ e }: { readonly e: RunEvent }) {
  return (
    <span title={`${e.type} · ${formatAbsoluteTime(e.at)}`}>
      <span className="num subtle">
        #{e.seq} ·{' '}
        <time dateTime={toIsoString(e.at)}>{formatClockTime(e.at)}</time>
      </span>{' '}
      <span>{eventSummary(e)}</span>
    </span>
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
function EventsListView({ events, runLevel = [], loaded }: EventsListProps) {
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

/** Memoized (PERF-02): re-renders only when its props change, not on every parent tick. */
export const EventsList = memo(EventsListView);

// ---------------------------------------------------------------------------------------------------------------
// Ledger (run-scoped)

/** Certainty as the Budget card words it (FR-09). */
const CERTAINTY_TEXT: Readonly<Record<CostCertainty, string>> = {
  reported: 'Reported',
  calculated: 'Calculated',
  estimated: 'Estimated',
  // Legacy certainty: a charge without an exact cost is an estimate (never shown as unknown).
  unknown: 'Estimated',
};

/** Entry types in words (exhaustive over contracts LEDGER_ENTRY_TYPES). Legacy "unknown" moves read as estimates. */
const ENTRY_TYPE_TEXT: Readonly<Record<LedgerEntryView['type'], string>> = {
  allowance_set: 'allowance set',
  allowance_change: 'allowance change',
  reserve: 'reserve',
  release: 'release',
  settle: 'settle',
  move_to_unknown: 'estimate counted',
  resolve_unknown: 'estimate resolved',
};

/** Buckets in words (exhaustive over contracts LEDGER_BUCKETS). */
const BUCKET_TEXT: Readonly<Record<LedgerEntryView['bucket'], string>> = {
  allowance: 'allowance',
  reserved: 'reserved',
  settled: 'settled',
  unknown: 'estimated',
};

function ledgerColumns(attemptSeqs: ReadonlyMap<string, number>): ReadonlyArray<DataTableColumn<LedgerEntryView>> {
  return [
    {
      key: 'created',
      header: 'Created',
      nowrap: true,
      // Entries of one run share a day: the time only, with the full date in the tooltip and `dateTime`.
      cell: (e) => (
        <time className="num" dateTime={toIsoString(e.createdAt)} title={formatAbsoluteTime(e.createdAt)}>
          {formatClockTime(e.createdAt)}
        </time>
      ),
    },
    { key: 'step', header: 'Step', nowrap: true, cell: (e) => (e.stepKey === null ? '—' : stepTitle({ stepKey: e.stepKey })) },
    {
      key: 'attempt',
      header: 'Attempt',
      nowrap: true,
      cell: (e) => {
        if (e.attemptId === null) return '—';
        const seq = attemptSeqs.get(e.attemptId);
        return seq === undefined ? (
          <span className="mono" title={e.attemptId}>
            …{e.attemptId.slice(-6)}
          </span>
        ) : (
          <span className="num" title={e.attemptId}>
            #{seq}
          </span>
        );
      },
    },
    { key: 'type', header: 'Type', nowrap: true, cell: (e) => ENTRY_TYPE_TEXT[e.type] },
    { key: 'bucket', header: 'Bucket', cell: (e) => BUCKET_TEXT[e.bucket] },
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
    { key: 'certainty', header: 'Certainty', nowrap: true, cell: (e) => (e.certainty === null ? '—' : CERTAINTY_TEXT[e.certainty]) },
    { key: 'catalog', header: 'Price catalog', nowrap: true, cell: (e) => (e.priceCatalogVersion === null ? '—' : <span className="mono">{e.priceCatalogVersion}</span>) },
  ];
}

export interface LedgerPanelProps {
  readonly runLabel: string;
  readonly entries: readonly LedgerEntryView[] | undefined;
  /** Attempt number per attempt id (`attemptSeqsOf` of the run's events): the Attempt column reads "#2". */
  readonly attemptSeqs: ReadonlyMap<string, number>;
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
          Export ledger (CSV)…
        </Button>
      </div>
      {p.exportedTo === null ? null : (
        <p className="small" role="status">
          Ledger exported to <span className="mono">{p.exportedTo}</span>.
        </p>
      )}
      <ActionErrorNotice error={p.exportError} />
      {p.error !== null && p.error !== undefined ? (
        <ActionErrorNotice error={p.error} />
      ) : p.entries === undefined ? (
        <Skeleton lines={5} />
      ) : (
        <DataTable
          caption={`Ledger entries for ${p.runLabel}, oldest first`}
          columns={ledgerColumns(p.attemptSeqs)}
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
