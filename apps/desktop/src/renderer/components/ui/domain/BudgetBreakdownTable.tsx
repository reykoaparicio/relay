import type { BudgetBreakdown, BudgetScope } from '@relay/contracts';
import { formatMoney } from '../../../lib/format/money';
import { Money } from '../Money';

const SCOPE_LABEL: Readonly<Record<BudgetScope, string>> = {
  run: 'Run allowance',
  project: 'Project monthly allowance',
  setup: 'Monthly setup allowance',
};

export interface BudgetBreakdownTableProps {
  readonly breakdown: BudgetBreakdown;
}

/** §9.3 admission arithmetic, with the inequality spelled out: "$3.10 > $3.00 → blocked". */
export function BudgetBreakdownTable({ breakdown: b }: BudgetBreakdownTableProps) {
  const verdict = b.allowed
    ? `${formatMoney(b.total)} ≤ ${formatMoney(b.L)} → allowed`
    : `${formatMoney(b.total)} > ${formatMoney(b.L)} → blocked`;
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
            <th scope="row">Unknown liability</th>
            <td className="num"><Money value={b.U} /></td>
          </tr>
          <tr>
            <td className="sym">N</td>
            <th scope="row">Proposed reservation for the next request</th>
            <td className="num"><Money value={b.N} /></td>
          </tr>
          <tr className="total">
            <td className="sym">=</td>
            <th scope="row">C + R + U + N</th>
            <td className="num"><Money value={b.total} /></td>
          </tr>
        </tbody>
      </table>
      <p className="small">
        <strong className="num">{verdict}</strong>
      </p>
    </div>
  );
}
