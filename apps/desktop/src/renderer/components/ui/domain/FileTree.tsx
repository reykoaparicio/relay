import { File, FileX } from 'lucide-react';
import type { ExclusionReason } from '@relay/contracts';
import { EXCLUSION_REASON_LABELS } from '../../../lib/format/labels';

export interface FileTreeIncluded {
  readonly relPath: string;
  readonly sizeBytes: number;
}

export interface FileTreeExcluded {
  readonly relPath: string;
  readonly reason: ExclusionReason;
}

export interface FileTreeProps {
  readonly included: readonly FileTreeIncluded[];
  readonly excluded: readonly FileTreeExcluded[];
  readonly label?: string;
}

const KIB = 1024;

function formatBytes(n: number): string {
  if (n < KIB) return `${String(n)} B`;
  if (n < KIB * KIB) return `${(n / KIB).toFixed(1)} KB`;
  return `${(n / (KIB * KIB)).toFixed(1)} MB`;
}

type Row = { readonly kind: 'in'; readonly entry: FileTreeIncluded } | { readonly kind: 'out'; readonly entry: FileTreeExcluded };

/** File preview (05 E2): included files and excluded ones with the reason as visible text. */
export function FileTree({ included, excluded, label = 'Project files' }: FileTreeProps) {
  const rows: Row[] = [
    ...included.map((entry): Row => ({ kind: 'in', entry })),
    ...excluded.map((entry): Row => ({ kind: 'out', entry })),
  ].sort((a, b) => a.entry.relPath.localeCompare(b.entry.relPath));
  return (
    <ul className="tree" aria-label={label}>
      {rows.map((row) => {
        const depth = row.entry.relPath.split('/').length - 1;
        const style = { paddingLeft: `${String(8 + depth * 16)}px` };
        if (row.kind === 'in') {
          return (
            <li key={`in:${row.entry.relPath}`} style={style}>
              <File aria-hidden="true" />
              <span className="path">{row.entry.relPath}</span>
              <span className="why">{formatBytes(row.entry.sizeBytes)}</span>
            </li>
          );
        }
        return (
          <li key={`out:${row.entry.relPath}`} className="excluded" style={style}>
            <FileX aria-hidden="true" />
            <span className="path">{row.entry.relPath}</span>
            <span className="why">Excluded: {EXCLUSION_REASON_LABELS[row.entry.reason]}</span>
          </li>
        );
      })}
    </ul>
  );
}
