import { useId } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';

/** Props every control inside a Field must spread (label, hint, and error wiring). */
export interface FieldControlProps {
  readonly id: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: true;
  readonly 'aria-required'?: true;
}

export interface FieldProps {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  /** Shown next to the control (ui-ux-pro-max `error-feedback`) and wired via aria-describedby. */
  readonly error?: ReactNode;
  readonly required?: boolean;
  /** Override the generated control id (e.g. for error-summary anchors). */
  readonly id?: string;
  readonly className?: string;
  readonly children: (control: FieldControlProps) => ReactNode;
}

export function Field({ label, hint, error, required = false, id, className, children }: FieldProps) {
  const generated = useId();
  const controlId = id ?? `field-${generated}`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const hasHint = hint !== undefined && hint !== null;
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  const describedBy = [hasHint ? hintId : null, hasError ? errorId : null].filter(Boolean).join(' ');
  const control: FieldControlProps = {
    id: controlId,
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    ...(hasError ? { 'aria-invalid': true as const } : {}),
    ...(required ? { 'aria-required': true as const } : {}),
  };
  return (
    <div className={className ? `field ${className}` : 'field'}>
      <label htmlFor={controlId}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {children(control)}
      {hasHint ? (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {hasError ? (
        <span className="error" id={errorId}>
          <CircleAlert aria-hidden="true" />
          {error}
        </span>
      ) : null}
    </div>
  );
}
