import type { BudgetBreakdown, BudgetScope } from '@relay/contracts';
import { microusd } from '@relay/contracts';
import { formatMoney, formatMoneyPair } from '../../../lib/format/money';
import { Money } from '../Money';

const SCOPE_LABEL: Readonly<Record<BudgetScope, string>> = {
  run: 'Run allowance',
  project: 'Project monthly allowance',
  setup: 'Monthly setup allowance',
};

export interface BudgetBreakdownTableProps {
  readonly breakdown: BudgetBreakdown;
}

/**
 * §9.3 admission arithmetic, with the inequality spelled out: "$3.10 > $3.00 → blocked". When both sides
 * round to the same cents, the verdict adds decimals ("$3.004 > $3.000") so it never reads "$3.00 > $3.00".
 */
export function BudgetBreakdownTable({ breakdown: b }: BudgetBreakdownTableProps) {
  const [total, limit] = formatMoneyPair(b.total, b.L);
  const verdict = b.allowed ? `${total} ≤ ${limit} → allowed` : `${total} > ${limit} → blocked`;
  const over = b.allowed ? null : formatMoney(microusd(b.total - b.L));
  return (
    <div className="stack">
      <table className="arith">
        <caption className="sr-only">Admission check: C + R + U + N must not exceed L</caption>
        <tbody>
          <tr>
            <td className="sym">L</td>
            <th scope="row">{SCOPE_LABEL[b.scope]}</th>
            <td className="num"><Money value={b.L} /></td>
          </tr>
          <tr>
            <td className="sym">C</td>
            <th scope="row">Settled tracked usage</th>
            <td className="num"><Money value={b.C} /></td>
          </tr>
          <tr>
            <td className="sym">R</td>
            <th scope="row">Existing reservations</th>
            <td className="num"><Money value={b.R} /></td>
          </tr>
          <tr>
            <td className="sym">U</td>
            <th scope="row">Estimated charges not yet confirmed</th>
            <td className="num"><Money value={b.U} approx={b.U > 0} /></td>
          </tr>
          <tr>
            <td className="sym">N</td>
            <th scope="row">Proposed reservation for the next request</th>
            <td className="num"><Money value={b.N} /></td>
          </tr>
          <tr className="total">
            <td className="sym">=</td>
            <th scope="row">
              C + R + U + N{over === null ? null : <span className="subtle"> (exceeds L by <span className="num">{over}</span>)</span>}
            </th>
            <td className="num"><Money value={b.total} /></td>
          </tr>
        </tbody>
      </table>
      <p className="small">
        <strong className="num">{verdict}</strong>
      </p>
      <p className="subtle small">
        L = allowance · C = settled usage · R = reservations in flight · U = estimated charges not yet confirmed · N = reservation for the
        next request. A request starts only when C + R + U + N ≤ L.
      </p>
    </div>
  );
}
