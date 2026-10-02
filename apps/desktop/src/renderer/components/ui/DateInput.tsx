import type { InputHTMLAttributes, Ref } from 'react';
import { cx } from './cx';

/**
 * Reported by {@link DateInput} while the native picker holds a partly typed or impossible date (`validity.badInput`:
 * the element's value is then '', which would read as "no date"). `parseDateInput` rejects it (undefined), so the
 * form shows its date validation copy instead of silently clearing the date.
 */
export const INCOMPLETE_DATE = 'incomplete';

export interface DateInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  /** `YYYY-MM-DD`, '' (no date) or {@link INCOMPLETE_DATE} (see `dateInputValue` / `parseDateInput` in lib/format/date). */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly ref?: Ref<HTMLInputElement>;
}

/** Controlled native date picker. Use inside `Field` and spread its control props. */
export function DateInput({ value, onValueChange, className, ref, onBlur, ...rest }: DateInputProps) {
  const report = (el: HTMLInputElement) => {
    const next = el.validity.badInput ? INCOMPLETE_DATE : el.value;
    if (next !== value) onValueChange(next);
  };
  return (
    <input
      {...rest}
      ref={ref}
      type="date"
      className={cx('input mono', className)}
      // An incomplete entry is '' in the DOM too: rendering '' leaves the user's partly typed segments alone.
      value={value === INCOMPLETE_DATE ? '' : value}
      onChange={(e) => { report(e.currentTarget); }}
      // A first partial entry changes no value (still ''), so no change event: re-check when the field is left.
      onBlur={(e) => {
        report(e.currentTarget);
        onBlur?.(e);
      }}
    />
  );
}
