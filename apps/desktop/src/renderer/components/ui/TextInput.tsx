import type { InputHTMLAttributes, Ref } from 'react';
import { cx } from './cx';

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly type?: 'text' | 'search' | 'url' | 'email' | 'password';
  readonly mono?: boolean;
  readonly ref?: Ref<HTMLInputElement>;
}

/** Controlled text input. Use inside `Field` and spread its control props. */
export function TextInput({ value, onValueChange, type = 'text', mono = false, className, ref, ...rest }: TextInputProps) {
  return (
    <input
      {...rest}
      ref={ref}
      type={type}
      className={cx('input', mono && 'mono', className)}
      value={value}
      onChange={(e) => { onValueChange(e.target.value); }}
    />
  );
}
