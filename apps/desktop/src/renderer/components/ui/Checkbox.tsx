import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode, Ref } from 'react';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'checked' | 'onChange' | 'type'> {
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly ref?: Ref<HTMLInputElement>;
}

export function Checkbox({ label, checked, onCheckedChange, id, ref, ...rest }: CheckboxProps) {
  const generated = useId();
  const inputId = id ?? `checkbox-${generated}`;
  return (
    <label className="checkbox-row" htmlFor={inputId}>
      <input
        {...rest}
        ref={ref}
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={(e) => { onCheckedChange(e.target.checked); }}
      />
      <span>{label}</span>
    </label>
  );
}
