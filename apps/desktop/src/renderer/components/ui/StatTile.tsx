import type { ReactNode } from 'react';

export interface StatTileProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  /** Short qualifier shown beside the label, e.g. the month ("September"). Part of the link name when `href` is set. */
  readonly labelAside?: ReactNode;
  /**
   * When set, the label, value, and hint form one link whose name is their text. Without
   * `secondaryAction` the whole tile is that link.
   */
  readonly href?: string;
  /**
   * A secondary control (usually a link such as "Open usage ledger"), rendered after the tile body and
   * OUTSIDE the primary `href` link, so links are never nested.
   */
  readonly secondaryAction?: ReactNode;
}

// The `{' '}` text nodes between the parts keep the link's accessible name word-separated
// ("Active runs 1 Waiting…", not "Active runs1Waiting…"); whitespace between flex items is not rendered.
export function StatTile({ label, value, hint, labelAside, href, secondaryAction }: StatTileProps) {
  const body = (
    <>
      {labelAside === undefined ? (
        <span className="label">{label}</span>
      ) : (
        <span className="label-row">
          <span className="label">{label}</span>{' '}
          <span className="label-aside">{labelAside}</span>
        </span>
      )}{' '}
      <span className="value">{value}</span>
      {hint === undefined ? null : <>{' '}<span className="hint">{hint}</span></>}
    </>
  );
  if (secondaryAction === undefined) {
    if (href !== undefined) {
      return (
        <a className="card stat" href={href}>
          {body}
        </a>
      );
    }
    return <div className="card stat">{body}</div>;
  }
  return (
    <div className="card stat">
      {href === undefined ? body : <a className="stat-main" href={href}>{body}</a>}
      <div className="stat-secondary">{secondaryAction}</div>
    </div>
  );
}
