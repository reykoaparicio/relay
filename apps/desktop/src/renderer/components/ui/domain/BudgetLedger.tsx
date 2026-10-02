import { memo, useId } from 'react';
import type { CostSummary } from '@relay/contracts';
import { Money } from '../Money';
import { TableScroll } from '../TableScroll';
import { stepKeyLabel } from '../../../lib/format/labels';
import { moneyColumnPrecision } from '../../../lib/format/money';
import { settledExact } from './budget-math';

export interface StepCost {
  readonly stepKey: string;
  readonly cost: CostSummary;
}

export interface BudgetLedgerProps {
  readonly cost: CostSummary;
  readonly byStep?: readonly StepCost[];
  readonly caption?: string;
}

/** Tracked usage by certainty (FR-09) plus allowance and remaining. "Tracked by Relay" (§9.1). */
function BudgetLedgerView({ cost, byStep, caption = 'Run usage' }: BudgetLedgerProps) {
  const stepCaptionId = useId();
  // One precision per column (sub-cent amounts keep 4 dp, and then the whole column does).
  const p = moneyColumnPrecision([
    cost.settledReported,
    cost.settledCalculated,
    cost.settledEstimated,
    cost.reserved,
    cost.unknown,
    cost.allowance,
    cost.remaining,
  ]);
  const steps = byStep ?? [];
  const stepP = {
    settled: moneyColumnPrecision(steps.map((s) => settledExact(s.cost))),
    estimated: moneyColumnPrecision(steps.map((s) => s.cost.settledEstimated)),
    reserved: moneyColumnPrecision(steps.map((s) => s.cost.reserved)),
    unknown: moneyColumnPrecision(steps.map((s) => s.cost.unknown)),
  };
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
            <td className="num"><Money value={cost.settledEstimated} certainty="estimated" precision={p} /></td>
          </tr>
          <tr>
            <th scope="row">Reserved (in flight)</th>
            <td className="num"><Money value={cost.reserved} precision={p} /></td>
          </tr>
          <tr>
            <th scope="row">Unknown liability</th>
            <td className="num"><Money value={cost.unknown} precision={p} /></td>
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
            <td className="num"><Money value={cost.remaining} precision={p} /></td>
          </tr>
        </tfoot>
      </table>
      {cost.overrun ? (
        <p className="small">Actual cost exceeded the reservation for at least one request. The extra is included above.</p>
      ) : null}
      {steps.length > 0 ? (
        <TableScroll labelledBy={stepCaptionId}>
          <table className="ledger">
            <caption id={stepCaptionId}>Settled usage by step. The Estimated column holds estimates (est.).</caption>
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col" className="num">Settled</th>
                <th scope="col" className="num">Estimated</th>
                <th scope="col" className="num">Reserved</th>
                <th scope="col" className="num">Unknown</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => (
                <tr key={s.stepKey}>
                  <th scope="row">{stepKeyLabel(s.stepKey)}</th>
                  <td className="num"><Money value={settledExact(s.cost)} precision={stepP.settled} /></td>
                  {/* The column header carries the certainty; "≈ $0.00 est." per cell wrapped in a narrow card. */}
                  <td className="num"><Money value={s.cost.settledEstimated} precision={stepP.estimated} /></td>
                  <td className="num"><Money value={s.cost.reserved} precision={stepP.reserved} /></td>
                  <td className="num"><Money value={s.cost.unknown} precision={stepP.unknown} /></td>
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
