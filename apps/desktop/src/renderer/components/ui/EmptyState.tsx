import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface EmptyStateProps {
  readonly title: string;
  readonly body?: ReactNode;
  readonly actions?: ReactNode;
  readonly icon?: LucideIcon;
  readonly headingLevel?: 2 | 3;
}

export function EmptyState({ title, body, actions, icon: Icon, headingLevel = 2 }: EmptyStateProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className="empty-state">
      {Icon ? <Icon aria-hidden="true" width={24} height={24} className="muted" /> : null}
      <Heading>{title}</Heading>
      {body === undefined ? null : <div className="muted">{body}</div>}
      {actions === undefined ? null : <div className="actions">{actions}</div>}
    </div>
  );
}
