import type { ReactNode } from 'react';
import { cx } from './cx';

export interface CardProps {
  readonly as?: 'section' | 'article' | 'div';
  /** Id of the heading that names this landmark (use CardHeader's `titleId`). */
  readonly labelledBy?: string;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Card({ as: Tag = 'section', labelledBy, className, children }: CardProps) {
  return (
    <Tag className={cx('card', className)} aria-labelledby={labelledBy}>
      {children}
    </Tag>
  );
}

export interface CardHeaderProps {
  readonly title: ReactNode;
  readonly titleId?: string;
  readonly level?: 2 | 3;
  readonly actions?: ReactNode;
}

export function CardHeader({ title, titleId, level = 2, actions }: CardHeaderProps) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className="card-header">
      <Heading id={titleId}>{title}</Heading>
      {actions === undefined ? null : <div className="actions">{actions}</div>}
    </div>
  );
}
