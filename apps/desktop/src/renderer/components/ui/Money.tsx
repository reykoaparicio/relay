import type { CostCertainty, Microusd } from '@relay/contracts';
import { formatMoney } from '../../lib/format/money';
import { cx } from './cx';

export interface MoneyProps {
  readonly value: Microusd;
  /** Estimated/unknown certainty is part of the visible text ("≈ $0.48 est."). */
  readonly certainty?: CostCertainty | null;
  readonly className?: string;
}

export function Money({ value, certainty, className }: MoneyProps) {
  return <span className={cx('num', className)}>{formatMoney(value, certainty)}</span>;
}
