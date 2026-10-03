import type { CostCertainty, Microusd } from '@relay/contracts';
import { formatMoney, formatMoneyApprox, isEstimate } from '../../lib/format/money';
import type { MoneyPrecision } from '../../lib/format/money';
import { cx } from './cx';

/** The muted note next to an estimate whose request may never have reached the provider. */
export const MAY_NOT_HAVE_BEEN_CHARGED = 'may not have been charged';

export interface MoneyProps {
  readonly value: Microusd;
  /** An estimated certainty is part of the visible text ("~$0.48 (estimated)"). */
  readonly certainty?: CostCertainty | null;
  /** A total that includes an estimate: "~$0.48" (ignored when `certainty` already marks it estimated). */
  readonly approx?: boolean;
  /** The request may never have reached the provider: adds the muted note "may not have been charged". */
  readonly mayNotHaveBeenCharged?: boolean;
  /** One precision for a table column (`moneyColumnPrecision`); default: per amount. */
  readonly precision?: MoneyPrecision;
  readonly className?: string;
}

export function Money({ value, certainty, approx = false, mayNotHaveBeenCharged = false, precision, className }: MoneyProps) {
  const options = precision === undefined ? {} : { precision };
  const text = isEstimate(certainty) ? formatMoney(value, certainty, options) : formatMoneyApprox(value, approx, options);
  const amount = <span className={cx('num', className)}>{text}</span>;
  if (!mayNotHaveBeenCharged) return amount;
  return (
    <span>
      {amount} <span className="subtle small font-sans">· {MAY_NOT_HAVE_BEEN_CHARGED}</span>
    </span>
  );
}
