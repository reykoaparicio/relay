import { memo, useId } from 'react';
import type { CostSummary, RunDetail } from '@relay/contracts';
import { Money } from '../Money';
import { TableScroll } from '../TableScroll';
import { stepName } from '../../../lib/format/labels';
import { costHasEstimates, estimatedPart, formatMoneyApprox, moneyColumnPrecision, trackedTotal } from '../../../lib/format/money';
import { settledExact } from './budget-math';

export interface StepCost {
  readonly stepKey: string;
  readonly cost: CostSummary;
}

export interface BudgetLedgerProps {
  readonly cost: CostSummary;
  readonly byStep?: readonly StepCost[];
  readonly caption?: string;
  /** The run's step names (`RunDetail.stepMeta`): the step rows use the workflow's names. */
  readonly stepMeta?: RunDetail['stepMeta'];
}

/** Tracked usage by certainty (FR-09) plus allowance and remaining. "Tracked by Relay" (§9.1). */
function BudgetLedgerView({ cost, byStep, caption = 'Run usage', stepMeta }: BudgetLedgerProps) {
  const stepCaptionId = useId();
  const steps = byStep ?? [];
  // One precision for the whole card, summary and step table alike: sub-cent step amounts put every amount at 4 dp, so
  // the step rows visibly add up to the summary ("$0.0042 + … = $0.0378", never "… = $0.04").
  const estimated = estimatedPart(cost);
  const total = trackedTotal(cost);
  // Totals that include any estimate read "~$0.48" (never as exact); a charge is never shown as unknown.
  const approx = costHasEstimates(cost);
  const p = moneyColumnPrecision([
    cost.settledReported,
    cost.settledCalculated,
    estimated,
    total,
    cost.reserved,
    cost.allowance,
    cost.remaining,
    ...steps.flatMap((s) => [settledExact(s.cost), estimatedPart(s.cost), s.cost.reserved]),
  ]);
  return (
    <div className="stack">
      <table className="ledger">
        <caption>{`${caption}. Tracked by Relay; your provider invoice may differ.`}</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Bucket</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Reported by provider</th>
            <td className="num"><Money value={cost.settledReported} precision={p} /></td>
          </tr>
          <tr>
            <th scope="row">Calculated from usage</th>
            <td className="num"><Money value={cost.settledCalculated} precision={p} /></td>
          </tr>
          <tr>
            <th scope="row">Estimated</th>
            <td className="num"><Money value={estimated} certainty={estimated > 0 ? 'estimated' : null} precision={p} /></td>
          </tr>
          <tr>
            <th scope="row">Reserved (in flight)</th>
            <td className="num"><Money value={cost.reserved} precision={p} /></td>
          </tr>
          <tr>
            <th scope="row">Tracked total</th>
            <td className="num"><Money value={total} approx={approx} precision={p} /></td>
          </tr>
          <tr>
            <th scope="row">Allowance</th>
            <td className="num"><Money value={cost.allowance} precision={p} /></td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            {/* "Over allowance" follows the arithmetic (remaining < 0), not `overrun` (actual > reservation, §9.5). */}
            <th scope="row">{cost.remaining < 0 ? 'Remaining (over allowance)' : 'Remaining'}</th>
            <td className="num"><Money value={cost.remaining} approx={approx} precision={p} /></td>
          </tr>
        </tfoot>
      </table>
      {cost.overrun ? (
        <p className="small">Actual cost exceeded the reservation for at least one request. The extra is included above.</p>
      ) : null}
      {steps.length > 0 ? (
        <TableScroll labelledBy={stepCaptionId}>
          <table className="ledger">
            <caption id={stepCaptionId}>Settled usage by step. Amounts marked ~ are estimates.</caption>
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col" className="num">Settled</th>
                <th scope="col" className="num">Estimated</th>
                <th scope="col" className="num">Reserved</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => (
                <tr key={s.stepKey}>
                  <th scope="row">{stepName(s.stepKey, stepMeta)}</th>
                  <td className="num"><Money value={settledExact(s.cost)} precision={p} /></td>
                  {/* The column header names the certainty; each non-zero estimate reads "~$0.62" (a full label per cell wraps in a narrow card). */}
                  <td className="num">{formatMoneyApprox(estimatedPart(s.cost), estimatedPart(s.cost) > 0, { precision: p })}</td>
                  <td className="num"><Money value={s.cost.reserved} precision={p} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : null}
    </div>
  );
}

/** Memoized (PERF-02): re-renders only when its props change, not on every parent tick. */
export const BudgetLedger = memo(BudgetLedgerView);
