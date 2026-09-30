import type { ReactNode } from 'react';

export interface StatTileProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  /** When set, the whole tile is one link whose name is the label, value, and hint text. */
  readonly href?: string;
}

export function StatTile({ label, value, hint, href }: StatTileProps) {
  const body = (
    <>
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {hint === undefined ? null : <span className="hint">{hint}</span>}
    </>
  );
  if (href !== undefined) {
    return (
      <a className="card stat" href={href}>
        {body}
      </a>
    );
  }
  return <div className="card stat">{body}</div>;
}
