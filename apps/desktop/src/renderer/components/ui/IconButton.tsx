import type { ButtonHTMLAttributes, Ref } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';
import type { ButtonVariant } from './Button';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  /** Required accessible name: icon-only buttons are unlabeled otherwise (ui-ux-pro-max `aria-labels`). */
  readonly label: string;
  readonly icon: LucideIcon;
  readonly variant?: ButtonVariant;
  readonly size?: 'sm' | 'md';
  readonly ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  label,
  icon: Icon,
  variant = 'ghost',
  size = 'md',
  className,
  type = 'button',
  ref,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      aria-label={label}
      className={cx('btn icon-btn', variant !== 'secondary' && variant, size === 'sm' && 'sm', className)}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}
