import type { ComponentPropsWithRef, ElementType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { ButtonSize, ButtonVariant } from './Button';
import { cx } from './cx';

interface ButtonLinkOwnProps<C extends ElementType> {
  /**
   * The element or component that renders the anchor. Defaults to a plain `<a>`; pages pass their
   * router's link (`<ButtonLink as={Link} to="/runs">`) so this component stays router-agnostic.
   * Whatever is passed must render a single `<a href>` and forward `className`.
   */
  readonly as?: C;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly icon?: LucideIcon;
  readonly className?: string;
  /** Visible label; it is the link's accessible name, so keep it descriptive ("Review recovery options"). */
  readonly children: ReactNode;
}

export type ButtonLinkProps<C extends ElementType = 'a'> = ButtonLinkOwnProps<C> &
  Omit<ComponentPropsWithRef<C>, keyof ButtonLinkOwnProps<C>>;

/**
 * A navigation link styled like a Button (09 I3 `.btn`). Use it when the action goes somewhere
 * (role `link`), Button when it does something (role `button`). Links cannot be disabled, so there is
 * no `disabled`/`pending`: render a disabled Button or plain text instead. The label is a `<span>` and
 * the icon is decorative, so there is never an interactive element nested inside.
 */
export function ButtonLink<C extends ElementType = 'a'>({
  as,
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  className,
  children,
  ...rest
}: ButtonLinkProps<C>) {
  const Component: ElementType = as ?? 'a';
  return (
    <Component
      {...rest}
      className={cx('btn', variant !== 'secondary' && variant, size !== 'md' && size, className)}
    >
      {Icon ? <Icon aria-hidden="true" /> : null}
      <span>{children}</span>
    </Component>
  );
}
