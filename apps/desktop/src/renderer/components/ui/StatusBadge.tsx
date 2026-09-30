import type { PauseReason } from '@relay/contracts';
import { statusPresentation } from '../../lib/format/status-presentation';
import type { StatusKind, StatusKindMap } from '../../lib/format/status-presentation';
import { cx } from './cx';

export interface StatusBadgeProps<K extends StatusKind> {
  readonly kind: K;
  readonly value: StatusKindMap[K];
  readonly pauseReason?: PauseReason | null;
  /** Renders the presentation's `detail` as visible secondary text (§5.7: never tooltip-only). */
  readonly showDetail?: boolean;
  readonly className?: string;
}

/** Icon + text status, never color alone (09 I3 gate, §3.3). */
export function StatusBadge<K extends StatusKind>({ kind, value, pauseReason, showDetail = false, className }: StatusBadgeProps<K>) {
  const p = statusPresentation(kind, value, pauseReason);
  const Icon = p.icon;
  const badge = (
    <span className={cx('badge', p.tone, className)}>
      <Icon aria-hidden="true" className={p.animated ? 'spin' : undefined} />
      {p.label}
    </span>
  );
  if (!showDetail || p.detail === undefined) return badge;
  return (
    <span className="status-with-detail">
      {badge}
      <span className="status-detail">{p.detail}</span>
    </span>
  );
}
