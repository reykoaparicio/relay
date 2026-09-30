import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '../../lib/format/relative-time';

export interface RelativeTimeProps {
  readonly epochMs: number;
  readonly now: number;
  /** Also show the absolute local time as visible text. */
  readonly showAbsolute?: boolean;
}

/** "3 min ago" in a `<time dateTime>` element carrying the absolute instant. */
export function RelativeTime({ epochMs, now, showAbsolute = false }: RelativeTimeProps) {
  const absolute = formatAbsoluteTime(epochMs);
  return (
    <time dateTime={toIsoString(epochMs)} title={absolute}>
      {formatRelativeTime(epochMs, now)}
      {showAbsolute ? <span className="subtle"> ({absolute})</span> : null}
    </time>
  );
}
