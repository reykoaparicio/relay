import { addMicrousd } from '@relay/contracts';
import type { CostSummary, Microusd } from '@relay/contracts';
import { formatMoney } from '../../../lib/format/money';
import { percentOf, settledExact } from './budget-math';

export interface BudgetMeterProps {
  readonly cost: CostSummary;
  /** What the allowance belongs to, used in the summary: "Run allowance". */
  readonly allowanceLabel?: string;
}

interface Segment {
  readonly key: 'settled' | 'estimated' | 'reserved' | 'unknown';
  readonly label: string;
  readonly summaryLabel: string;
  readonly value: Microusd;
}

/**
 * Stacked bar: settled (solid), estimated (hatched), reserved, unknown (hatched purple), with a
 * visible text legend carrying every amount (color is never the only signal) and an aria summary.
 */
export function BudgetMeter({ cost, allowanceLabel = 'Run allowance' }: BudgetMeterProps) {
  const segments: readonly Segment[] = [
    { key: 'settled', label: 'Reported / calculated', summaryLabel: 'reported or calculated', value: settledExact(cost) },
    { key: 'estimated', label: 'Estimated', summaryLabel: 'estimated', value: cost.settledEstimated },
    { key: 'reserved', label: 'Reserved', summaryLabel: 'reserved', value: cost.reserved },
    { key: 'unknown', label: 'Unknown', summaryLabel: 'unknown', value: cost.unknown },
  ];
  const used = addMicrousd(...segments.map((s) => s.value));
  // Scale to whichever is larger so an overrun still fits the bar.
  const scale = (used > cost.allowance ? used : cost.allowance);
  const remainingAbs = Math.abs(cost.remaining) as Microusd;
  const remainingText = cost.remaining < 0 ? `over by ${formatMoney(remainingAbs)}` : `${formatMoney(remainingAbs)} remaining`;
  const summary = `${allowanceLabel} ${formatMoney(cost.allowance)}: ${segments
    .map((s) => `${formatMoney(s.value)} ${s.summaryLabel}`)
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
            {s.label} <span className="num">{formatMoney(s.value)}</span>
          </li>
        ))}
        <li>
          <span className="swatch remaining" aria-hidden="true" />
          {cost.remaining < 0 ? 'Over allowance' : 'Remaining'}{' '}
          <span className="num">{formatMoney(remainingAbs)}</span>
        </li>
      </ul>
    </div>
  );
}
