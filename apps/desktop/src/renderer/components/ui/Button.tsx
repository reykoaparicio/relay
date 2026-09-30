import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Async action in flight: disables the button, sets aria-busy, and swaps the icon for a spinner. */
  readonly pending?: boolean;
  readonly icon?: LucideIcon;
  readonly children: ReactNode;
  readonly ref?: Ref<HTMLButtonElement>;
}

/** Real `<button>` (09 I3 `.btn`). The label never changes while pending (no content jump). */
export function Button({
  variant = 'secondary',
  size = 'md',
  pending = false,
  icon: Icon,
  disabled,
  className,
  type = 'button',
  children,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={cx('btn', variant !== 'secondary' && variant, size !== 'md' && size, className)}
      disabled={disabled === true || pending}
      aria-busy={pending || undefined}
    >
      {pending ? <span className="spinner" aria-hidden="true" /> : Icon ? <Icon aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}
