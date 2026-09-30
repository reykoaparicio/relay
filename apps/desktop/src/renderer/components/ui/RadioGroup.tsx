import { useId } from 'react';
import type { ReactNode } from 'react';

export interface RadioOption<V extends string> {
  readonly value: V;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly disabled?: boolean;
}

export interface RadioGroupProps<V extends string> {
  readonly legend: ReactNode;
  readonly name?: string;
  readonly value: V | null;
  readonly onValueChange: (value: V) => void;
  readonly options: ReadonlyArray<RadioOption<V>>;
  readonly error?: ReactNode;
}

/** Native radios in a fieldset/legend; arrow keys move between options natively. */
export function RadioGroup<V extends string>({ legend, name, value, onValueChange, options, error }: RadioGroupProps<V>) {
  const base = useId();
  const groupName = name ?? `radio-${base}`;
  const errorId = `${groupName}-error`;
  const hasError = error !== undefined && error !== null && error !== '';
  return (
    <fieldset className="fieldset field" aria-describedby={hasError ? errorId : undefined}>
      <legend>{legend}</legend>
      <div className="choices">
        {options.map((o) => {
          const id = `${groupName}-${o.value}`;
          const descId = `${id}-desc`;
          return (
            <div className="choice" key={o.value}>
              <input
                type="radio"
                id={id}
                name={groupName}
                value={o.value}
                checked={value === o.value}
                disabled={o.disabled}
                aria-describedby={o.description === undefined ? undefined : descId}
                onChange={() => { onValueChange(o.value); }}
              />
              <span className="body">
                <label className="title" htmlFor={id}>
                  {o.label}
                </label>
                {o.description === undefined ? null : (
                  <span className="subtle" id={descId}>
                    {o.description}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {hasError ? (
        <span className="error" id={errorId}>
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}
