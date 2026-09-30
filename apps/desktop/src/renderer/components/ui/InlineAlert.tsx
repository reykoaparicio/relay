import type { ReactNode } from 'react';
import { CircleCheck, CircleQuestionMark, CircleX, Info, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { StatusTone } from '../../lib/format/status-presentation';
import { cx } from './cx';

const TONE_ICON: Record<StatusTone, LucideIcon> = {
  neutral: Info,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleX,
  unknown: CircleQuestionMark,
};

export interface InlineAlertProps {
  readonly tone: StatusTone;
  readonly title: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}

/** `role="alert"` for danger (interrupts), `role="status"` otherwise (09 I3 `.banner`). */
export function InlineAlert({ tone, title, children, actions, className }: InlineAlertProps) {
  const Icon = TONE_ICON[tone];
  return (
    <div className={cx('banner', tone, className)} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon aria-hidden="true" />
      <div className="body">
        <strong>{title}</strong>
        {children === undefined ? null : <div className="stack small">{children}</div>}
        {actions === undefined ? null : <div className="actions">{actions}</div>}
      </div>
    </div>
  );
}
