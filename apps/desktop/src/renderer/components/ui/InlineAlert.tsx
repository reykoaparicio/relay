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
  /**
   * Live-region behaviour (default `'off'`: a banner that is part of the page is read in place, not announced).
   * `'assertive'` (role="alert") only for an alert answering the user's own submit, e.g. a failed command or form;
   * `'polite'` (role="status") for a rare update the user is waiting on. Run status is announced by `useRunEvents`
   * through the single app live region, never by a banner.
   */
  readonly live?: InlineAlertLive;
}

export type InlineAlertLive = 'off' | 'polite' | 'assertive';

const LIVE_ROLE: Readonly<Record<InlineAlertLive, 'alert' | 'status' | undefined>> = {
  off: undefined,
  polite: 'status',
  assertive: 'alert',
};

/** A tinted banner (09 I3 `.banner`). Silent by default; see `live`. */
export function InlineAlert({ tone, title, children, actions, className, live = 'off' }: InlineAlertProps) {
  const Icon = TONE_ICON[tone];
  return (
    <div className={cx('banner', tone, className)} role={LIVE_ROLE[live]}>
      <Icon aria-hidden="true" />
      <div className="body">
        <strong>{title}</strong>
        {children === undefined ? null : <div className="stack small">{children}</div>}
        {actions === undefined ? null : <div className="actions">{actions}</div>}
      </div>
    </div>
  );
}
