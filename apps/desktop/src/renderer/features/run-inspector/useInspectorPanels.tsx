// The run inspector's step panels (10 J8, SPLIT-01): Output / Context / Attempts / Events / Ledger tabs, and the
// Budget + Context summary row that collapses into tabs below 1280 px (ResponsivePanels).
import type { RunDetail, RunEvent, StepDetail, StepView } from '@relay/contracts';
import { AttemptsTable, BudgetLedger, Button, ContextManifestView, Skeleton } from '../../components/ui';
import type { Panel } from '../../components/ui';
import type { useLedger } from '../../hooks/useLedger';
import { runLabel } from '../runs/run-display';
import { ContextSummary, EventsList, LedgerPanel } from './InspectorPanels';
import { stepTitle } from './inspector-model';
import { StepOutputTab } from './StepOutput';
import type { StepOutputTabProps } from './StepOutput';
import type { useLedgerExport } from './useRunExports';

/** Stable empty prop for the memoized BudgetLedger while the summary loads. */
const NO_STEP_COSTS: readonly never[] = [];

export interface InspectorPanelsInput {
  /** Undefined while the run loads: no panels yet (the hook is still called, before the page's early returns). */
  readonly run: RunDetail | undefined;
  readonly projectId: string;
  readonly selected: StepView | undefined;
  readonly detail: StepDetail | undefined;
  readonly detailError: unknown;
  /** The selected step's events and the run-level ones (`stepEventsOf`). */
  readonly selectedEvents: { readonly events: readonly RunEvent[]; readonly runLevel: readonly RunEvent[] };
  readonly eventsLoaded: boolean;
  readonly ledger: ReturnType<typeof useLedger>;
  readonly ledgerExport: ReturnType<typeof useLedgerExport>;
  readonly approval: StepOutputTabProps['approval'];
  readonly setTab: (id: string) => void;
}

export interface InspectorPanels {
  readonly tabs: Panel[];
  readonly secondary: Panel[];
}

/** The panels of the selected step (the page passes them to ResponsivePanels). */
export function useInspectorPanels({
  run,
  projectId,
  selected,
  detail,
  detailError,
  selectedEvents,
  eventsLoaded,
  ledger,
  ledgerExport,
  approval,
  setTab,
}: InspectorPanelsInput): InspectorPanels | null {
  if (run === undefined || selected === undefined) return null;
  const entries = ledger.entries.data?.pages.flatMap((p) => p.items);
  const tabs: Panel[] = [
    {
      id: 'output',
      label: 'Output',
      content: (
        <StepOutputTab run={run} projectId={projectId} step={selected} detail={detail} detailError={detailError} approval={approval} />
      ),
    },
    {
      id: 'context',
      label: 'Context',
      content:
        detail === undefined ? (
          <Skeleton lines={4} />
        ) : detail.manifest === null ? (
          <p className="subtle">No context was sent for this step. Only the items in a manifest are ever sent to a provider.</p>
        ) : (
          <div className="stack">
            <p className="subtle">Immutable manifest for this request. Only these items were sent to providers.</p>
            <ContextManifestView manifest={detail.manifest} />
          </div>
        ),
    },
    {
      id: 'attempts',
      label: 'Attempts',
      content:
        detail === undefined ? <Skeleton lines={4} /> : <AttemptsTable attempts={detail.attempts} caption={`Attempts for ${stepTitle(selected)}`} />,
    },
    {
      id: 'events',
      label: 'Events',
      content: <EventsList events={selectedEvents.events} runLevel={selectedEvents.runLevel} loaded={eventsLoaded} />,
    },
    {
      id: 'ledger',
      label: 'Ledger',
      content: (
        <LedgerPanel
          runLabel={runLabel(run.id)}
          entries={entries}
          error={ledger.entries.error}
          hasMore={ledger.entries.hasNextPage}
          loadingMore={ledger.entries.isFetchingNextPage}
          onLoadMore={() => {
            void ledger.entries.fetchNextPage();
          }}
          onExport={() => {
            ledgerExport.mutate();
          }}
          exporting={ledgerExport.isPending}
          exportError={ledgerExport.error}
          exportedTo={ledgerExport.data?.exported === true ? (ledgerExport.data.displayPath ?? 'the chosen file') : null}
        />
      ),
    },
  ];
  const secondary: Panel[] = [
    {
      id: 'budget',
      label: 'Budget',
      content: (
        <div className="stack">
          <BudgetLedger cost={run.cost} byStep={ledger.summary.data?.byStep ?? NO_STEP_COSTS} caption={`${runLabel(run.id)} tracked usage`} />
          <div className="actions">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setTab('ledger');
              }}
            >
              Per-attempt ledger entries
            </Button>
          </div>
        </div>
      ),
    },
    {
      id: 'summary',
      label: 'Context summary',
      content: (
        <ContextSummary
          run={run}
          manifest={detail === undefined ? undefined : detail.manifest}
          onInspect={() => {
            setTab('context');
          }}
        />
      ),
    },
  ];
  return { tabs, secondary };
}
