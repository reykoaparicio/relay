import type { Ref, SelectHTMLAttributes } from 'react';
import { cx } from './cx';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'children'> {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly ref?: Ref<HTMLSelectElement>;
}

/** Native `<select>`: keyboard and screen-reader behavior come from the platform. */
export function Select({ value, onValueChange, options, className, ref, ...rest }: SelectProps) {
  return (
    <select
      {...rest}
      ref={ref}
      className={cx('select', className)}
      value={value}
      onChange={(e) => { onValueChange(e.target.value); }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
