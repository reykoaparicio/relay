import type { InputHTMLAttributes, Ref } from 'react';
import { cx } from './cx';

export interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max' | 'step'> {
  /** Raw text so partially typed input ("1", "") is preserved; parse on submit. */
  readonly value: string;
  readonly onValueChange: (text: string, parsed: number | null) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly ref?: Ref<HTMLInputElement>;
}

/** Integer input (limits, attempts, seconds). Emits the parsed integer or null when not a whole number. */
export function NumberInput({ value, onValueChange, min, max, step = 1, className, ref, ...rest }: NumberInputProps) {
  return (
    <input
      {...rest}
      ref={ref}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={step}
      className={cx('input mono', className)}
      value={value}
      onChange={(e) => {
        const text = e.target.value;
        const parsed = /^-?\d+$/.test(text.trim()) ? Number.parseInt(text, 10) : null;
        onValueChange(text, parsed);
      }}
    />
  );
}
