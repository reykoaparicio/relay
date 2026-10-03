import type { ReactNode } from 'react';
import { cx } from './cx';

export interface DisclosureProps {
  /** The always-visible toggle text ("Technical details"). */
  readonly summary: ReactNode;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly className?: string;
}

/**
 * Secondary detail behind a native `<details>` toggle (keyboard and screen-reader operable without script): error
 * codes, field lists, rarely needed columns. The summary says what is inside; nothing in it is tooltip-only.
 */
export function Disclosure({ summary, children, defaultOpen = false, className }: DisclosureProps) {
  return (
    <details className={cx('disclosure', className)} open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
