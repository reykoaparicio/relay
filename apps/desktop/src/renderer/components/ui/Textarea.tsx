import type { Ref, TextareaHTMLAttributes } from 'react';
import { cx } from './cx';

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ value, onValueChange, className, ref, ...rest }: TextareaProps) {
  return (
    <textarea
      {...rest}
      ref={ref}
      className={cx('textarea', className)}
      value={value}
      onChange={(e) => { onValueChange(e.target.value); }}
    />
  );
}
