import { addMicrousd } from '@relay/contracts';
import type { CostCertainty, CostSummary, Microusd, RunSummary } from '@relay/contracts';
import { Link } from 'react-router';
import { Money, StatusBadge } from '../../components/ui';

/** Short run label shown in lists ("Run 0024"): the id's last characters, which are unique per run. */
export function runLabel(runId: string): string {
  return `Run ${runId.slice(-4)}`;
}

/** Settled total (reported + calculated + estimated). */
function settledTotal(cost: CostSummary): Microusd {
  return addMicrousd(cost.settledReported, cost.settledCalculated, cost.settledEstimated);
}

/** The weakest certainty present in the settled total (FR-09): any estimate makes the total an estimate. */
function settledCertainty(cost: CostSummary): CostCertainty {
  if (cost.settledEstimated > 0) return 'estimated';
  if (cost.settledCalculated > 0) return 'calculated';
  return 'reported';
}

export interface RunCostProps {
  readonly cost: CostSummary;
  /** Links the amount to the run's ledger (§5.2 "every budget value links to the ledger"). */
  readonly ledgerPath?: string;
  /** Show reserved/unknown sub-lines. */
  readonly detailed?: boolean;
}

/** The certainty tag's class: one tone per certainty, so an unknown charge gets the unknown tone (never a default). */
export function certaintyTagClass(certainty: CostCertainty): string {
  return `tag certainty-${certainty}`;
}

/** Tracked run cost with its certainty as visible text (never color alone). */
export function RunCost({ cost, ledgerPath, detailed = false }: RunCostProps) {
  const total = settledTotal(cost);
  const certainty = settledCertainty(cost);
  const amount = <Money value={total} certainty={certainty === 'estimated' ? 'estimated' : null} />;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        {ledgerPath === undefined ? (
          amount
        ) : (
          <Link to={ledgerPath}>
            {amount}
            <span className="sr-only">, open the ledger</span>
          </Link>
        )}
        {total > 0 && certainty !== 'estimated' ? (
          <span className={certaintyTagClass(certainty)}>{certainty}</span>
        ) : null}
      </span>
      {detailed && cost.reserved > 0 ? (
        <span className="subtle whitespace-nowrap font-sans">
          + <Money value={cost.reserved} /> reserved
        </span>
      ) : null}
      {cost.unknown > 0 ? (
        <span className="subtle inline-flex items-center gap-1 whitespace-nowrap font-sans">
          <StatusBadge kind="certainty" value="unknown" /> up to <Money value={cost.unknown} />
        </span>
      ) : null}
    </span>
  );
}

/** Runs that are still in progress (not paused or finished). */
export function isActiveRun(r: Pick<RunSummary, 'status'>): boolean {
  return r.status === 'queued' || r.status === 'running' || r.status === 'awaiting_approval' || r.status === 'cancelling';
}
