import type { CostCertainty, Microusd } from '@relay/contracts';
import { formatMoney } from '../../lib/format/money';
import type { MoneyPrecision } from '../../lib/format/money';
import { cx } from './cx';

export interface MoneyProps {
  readonly value: Microusd;
  /** Estimated/unknown certainty is part of the visible text ("≈ $0.48 est."). */
  readonly certainty?: CostCertainty | null;
  /** One precision for a table column (`moneyColumnPrecision`); default: per amount. */
  readonly precision?: MoneyPrecision;
  readonly className?: string;
}

export function Money({ value, certainty, precision, className }: MoneyProps) {
  return (
    <span className={cx('num', className)}>
      {formatMoney(value, certainty, precision === undefined ? {} : { precision })}
    </span>
  );
}
