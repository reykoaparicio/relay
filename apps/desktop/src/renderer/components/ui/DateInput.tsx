import type { InputHTMLAttributes, Ref } from 'react';
import { cx } from './cx';

export interface DateInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  /** `YYYY-MM-DD` or '' (see `dateInputValue` / `parseDateInput` in lib/format/date). */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly ref?: Ref<HTMLInputElement>;
}

/** Controlled native date picker. Use inside `Field` and spread its control props. */
export function DateInput({ value, onValueChange, className, ref, ...rest }: DateInputProps) {
  return (
    <input
      {...rest}
      ref={ref}
      type="date"
      className={cx('input mono', className)}
      value={value}
      onChange={(e) => { onValueChange(e.target.value); }}
    />
  );
}
