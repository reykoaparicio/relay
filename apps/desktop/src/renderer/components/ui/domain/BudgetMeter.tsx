import { addMicrousd } from '@relay/contracts';
import type { CostSummary, Microusd } from '@relay/contracts';
import { costHasEstimates, estimatedPart, formatMoney, formatMoneyApprox } from '../../../lib/format/money';
import { percentOf, settledExact } from './budget-math';

export interface BudgetMeterProps {
  readonly cost: CostSummary;
  /** What the allowance belongs to, used in the summary: "Run allowance". */
  readonly allowanceLabel?: string;
}

interface Segment {
  readonly key: 'settled' | 'estimated' | 'reserved';
  readonly label: string;
  readonly summaryLabel: string;
  readonly value: Microusd;
  /** The amount is an estimate: "~$0.62". */
  readonly approx: boolean;
}

/**
 * Stacked bar: settled (solid), estimated (hatched), reserved, with a visible text legend carrying every amount (color
 * is never the only signal) and an aria summary. A charge whose exact cost is not available is an estimate (never
 * "unknown"); a remaining amount that depends on an estimate reads "~".
 */
export function BudgetMeter({ cost, allowanceLabel = 'Run allowance' }: BudgetMeterProps) {
  const estimated = estimatedPart(cost);
  const segments: readonly Segment[] = [
    { key: 'settled', label: 'Reported / calculated', summaryLabel: 'reported or calculated', value: settledExact(cost), approx: false },
    { key: 'estimated', label: 'Estimated', summaryLabel: 'estimated', value: estimated, approx: estimated > 0 },
    { key: 'reserved', label: 'Reserved', summaryLabel: 'reserved', value: cost.reserved, approx: false },
  ];
  const used = addMicrousd(...segments.map((s) => s.value));
  // Scale to whichever is larger so an overrun still fits the bar.
  const scale = (used > cost.allowance ? used : cost.allowance);
  const approxRemaining = costHasEstimates(cost);
  const remainingAbs = Math.abs(cost.remaining) as Microusd;
  const remainingAmount = formatMoneyApprox(remainingAbs, approxRemaining);
  const remainingText = cost.remaining < 0 ? `over by ${remainingAmount}` : `${remainingAmount} remaining`;
  const summary = `${allowanceLabel} ${formatMoney(cost.allowance)}: ${segments
    .map((s) => `${formatMoneyApprox(s.value, s.approx)} ${s.summaryLabel}`)
    .join(', ')}, ${remainingText}`;

  return (
    <div className="stack">
      <div className="meter" role="img" aria-label={summary}>
        {segments.map((s) =>
          s.value > 0 ? <span key={s.key} className={s.key} style={{ width: percentOf(s.value, scale) }} /> : null,
        )}
      </div>
      <ul className="meter-legend">
        {segments.map((s) => (
          <li key={s.key}>
            <span className={`swatch ${s.key}`} aria-hidden="true" />
            {s.label} <span className="num">{formatMoneyApprox(s.value, s.approx)}</span>
          </li>
        ))}
        <li>
          <span className="swatch remaining" aria-hidden="true" />
          {cost.remaining < 0 ? 'Over allowance' : 'Remaining'}{' '}
          <span className="num">{remainingAmount}</span>
        </li>
      </ul>
    </div>
  );
}
