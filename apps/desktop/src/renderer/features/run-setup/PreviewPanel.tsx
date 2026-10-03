import type { PreviewResult } from '@relay/contracts';
import { ErrorView, FileTree, Skeleton } from '../../components/ui';
import { toViewError } from '../../api/errors';
import { useRetryAction } from '../common/useNextAction';

import { formatBytes } from '../../lib/format/bytes';

/** "11 included · 6 excluded · 1 unreadable · 38.6 KB of 512 KB input cap". */
function previewTotals(p: PreviewResult): string {
  const unreadable = p.unreadable?.length ?? 0;
  return `${String(p.totals.files)} included · ${String(p.excluded.length)} excluded${unreadable === 0 ? '' : ` · ${String(unreadable)} unreadable`} · ${formatBytes(p.totals.bytes)} of ${formatBytes(p.totals.capBytes)} input cap`;
}

export interface PreviewPanelProps {
  readonly data: PreviewResult | undefined;
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly label: string;
}

/** Included-file preview (FR-01): FileTree with excluded reasons as text, and totals against the caps. */
export function PreviewPanel({ data, error, onRetry, label }: PreviewPanelProps) {
  const onAction = useRetryAction(onRetry);
  if (error !== null && error !== undefined)
    return <ErrorView error={toViewError(error)} onAction={onAction} />;
  if (data === undefined) {
    return (
      <div aria-busy="true">
        <Skeleton lines={6} />
      </div>
    );
  }
  return (
    <div className="stack">
      <p className="small num">{previewTotals(data)}</p>
      <div style={{ maxHeight: 320, overflow: 'auto' }}>
        <FileTree included={data.included} excluded={data.excluded} unreadable={data.unreadable} label={label} />
      </div>
    </div>
  );
}
