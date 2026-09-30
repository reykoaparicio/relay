import { formatHash } from '../../lib/format/hash';
import { CopyButton } from './CopyButton';

export interface HashProps {
  readonly value: string;
  /** What the hash identifies, used in the copy button name: "Copy full plan hash". */
  readonly label?: string;
}

/** Short hash + full value in `title` and a copy button (no tooltip-only info, §5.7). */
export function Hash({ value, label = 'hash' }: HashProps) {
  return (
    <span className="hash-group">
      <code className="hash" title={value}>
        {formatHash(value)}
      </code>
      <CopyButton value={value} label={`Copy full ${label}`} />
    </span>
  );
}
