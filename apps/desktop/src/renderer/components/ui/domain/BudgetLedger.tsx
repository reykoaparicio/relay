import type { CostSummary } from '@relay/contracts';
import { Money } from '../Money';
import { stepKeyLabel } from '../../../lib/format/labels';
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
export function BudgetLedger({ cost, byStep, caption = 'Run usage' }: BudgetLedgerProps) {
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
            <td className="num"><Money value={cost.settledReported} /></td>
          </tr>
          <tr>
            <th scope="row">Calculated from usage</th>
            <td className="num"><Money value={cost.settledCalculated} /></td>
          </tr>
          <tr>
            <th scope="row">Estimated</th>
            <td className="num"><Money value={cost.settledEstimated} certainty="estimated" /></td>
          </tr>
          <tr>
            <th scope="row">Reserved (in flight)</th>
            <td className="num"><Money value={cost.reserved} /></td>
          </tr>
          <tr>
            <th scope="row">Unknown liability</th>
            <td className="num"><Money value={cost.unknown} /></td>
          </tr>
          <tr>
            <th scope="row">Allowance</th>
            <td className="num"><Money value={cost.allowance} /></td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            {/* "Over allowance" follows the arithmetic (remaining < 0), not `overrun` (actual > reservation, §9.5). */}
            <th scope="row">{cost.remaining < 0 ? 'Remaining (over allowance)' : 'Remaining'}</th>
            <td className="num"><Money value={cost.remaining} /></td>
          </tr>
        </tfoot>
      </table>
      {cost.overrun ? (
        <p className="small">Actual cost exceeded the reservation for at least one request. The extra is included above.</p>
      ) : null}
      {byStep && byStep.length > 0 ? (
        <table className="ledger">
          <caption>Settled usage by step</caption>
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
            {byStep.map((s) => (
              <tr key={s.stepKey}>
                <th scope="row">{stepKeyLabel(s.stepKey)}</th>
                <td className="num">
                  <Money value={settledExact(s.cost)} />
                </td>
                <td className="num"><Money value={s.cost.settledEstimated} certainty="estimated" /></td>
                <td className="num"><Money value={s.cost.reserved} /></td>
                <td className="num"><Money value={s.cost.unknown} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
