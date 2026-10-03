import type { CostCertainty, CostSummary, RunSummary } from '@relay/contracts';
import { Link } from 'react-router';
import { Money } from '../../components/ui';
import { costHasEstimates, trackedTotal } from '../../lib/format/money';

/** Short run label shown in lists ("Run 0024"): the id's last characters, which are unique per run. */
export { runLabel } from '../../lib/format/labels';

/** The weakest certainty of an exact total (FR-09): calculated when any part was calculated, else reported. */
function exactCertainty(cost: CostSummary): CostCertainty {
  return cost.settledCalculated > 0 ? 'calculated' : 'reported';
}

export interface RunCostProps {
  readonly cost: CostSummary;
  /** Links the amount to the run's ledger (§5.2 "every budget value links to the ledger"). */
  readonly ledgerPath?: string;
  /** Show the reserved sub-line. */
  readonly detailed?: boolean;
}

/** The certainty tag's class: one tone per certainty (never a default). */
export function certaintyTagClass(certainty: CostCertainty): string {
  return `tag certainty-${certainty}`;
}

/**
 * Tracked run cost with its certainty as visible text (never color alone). A total that includes any estimate reads
 * "~$0.48" with an "estimated" tag; Relay never shows a charge as unknown.
 */
export function RunCost({ cost, ledgerPath, detailed = false }: RunCostProps) {
  const total = trackedTotal(cost);
  const approx = costHasEstimates(cost);
  const certainty = approx ? 'estimated' : exactCertainty(cost);
  const amount = <Money value={total} approx={approx} />;
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
        {total > 0 ? <span className={certaintyTagClass(certainty)}>{certainty}</span> : null}
      </span>
      {detailed && cost.reserved > 0 ? (
        <span className="subtle whitespace-nowrap font-sans">
          + <Money value={cost.reserved} /> reserved
        </span>
      ) : null}
    </span>
  );
}

/** Runs that are still in progress (not paused or finished). */
export function isActiveRun(r: Pick<RunSummary, 'status'>): boolean {
  return r.status === 'queued' || r.status === 'running' || r.status === 'awaiting_approval' || r.status === 'cancelling';
}
