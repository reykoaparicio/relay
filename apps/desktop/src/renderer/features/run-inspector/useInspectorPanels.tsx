// The run inspector's step panels (10 J8, SPLIT-01): Output / Context / Attempts / Events / Ledger tabs, and the
// Budget + Context summary row that collapses into tabs below 1280 px (ResponsivePanels).
import type { RunDetail, RunEvent, StepDetail, StepView } from '@relay/contracts';
import { BudgetLedger, Button } from '../../components/ui';
import type { Panel } from '../../components/ui';
import type { useLedger } from '../../hooks/useLedger';
import { runLabel } from '../runs/run-display';
import { ContextSummary, EventsList, LedgerPanel } from './InspectorPanels';
import { attemptSeqsOf } from './inspector-model';
import { AttemptsPanel, ContextPanel } from './RunLevelPanels';
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
  /** Every event of the run (attempt numbers of the ledger's Attempt column). */
  readonly runEvents: readonly RunEvent[];
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
  runEvents,
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
      content: <ContextPanel run={run} detail={detail} />,
    },
    {
      id: 'attempts',
      label: 'Attempts',
      // Keyed by row: the "This step / Whole run" choice starts over for each selected step.
      content: <AttemptsPanel key={selected.id} run={run} step={selected} stepAttempts={detail?.attempts} />,
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
          attemptSeqs={attemptSeqsOf(runEvents)}
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
