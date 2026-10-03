import { File, FileX, TriangleAlert } from 'lucide-react';
import type { ExclusionReason } from '@relay/contracts';
import { formatBytes } from '../../../lib/format/bytes';
import { exclusionReasonText, suspectedSecretText, UNREADABLE_FILE_TEXT } from '../../../lib/format/labels';

export interface FileTreeIncluded {
  readonly relPath: string;
  readonly sizeBytes: number;
  /** E2 #11: the content looks like a credential (label and line only; never the value). Not selected by default. */
  readonly suspectedSecret?: true | undefined;
  readonly secretLabel?: string | undefined;
  readonly secretLine?: number | undefined;
}

export interface FileTreeExcluded {
  readonly relPath: string;
  readonly reason: ExclusionReason;
}

export interface FileTreeProps {
  readonly included: readonly FileTreeIncluded[];
  readonly excluded: readonly FileTreeExcluded[];
  readonly label?: string;
  /** E2 #8: entries that exist but cannot be read (permissions); listed, never selectable. */
  readonly unreadable?: readonly string[] | undefined;
}


type Row =
  | { readonly kind: 'in'; readonly entry: FileTreeIncluded }
  | { readonly kind: 'out'; readonly entry: FileTreeExcluded }
  | { readonly kind: 'unreadable'; readonly entry: { readonly relPath: string } };

/**
 * File preview (05 E2): included files, excluded ones with the reason as visible text, and unreadable ones. A file
 * that looks like it holds a secret says so (and that it is not selected by default), in words.
 */
export function FileTree({ included, excluded, label = 'Project files', unreadable = [] }: FileTreeProps) {
  const rows: Row[] = [
    ...included.map((entry): Row => ({ kind: 'in', entry })),
    ...excluded.map((entry): Row => ({ kind: 'out', entry })),
    ...unreadable.map((relPath): Row => ({ kind: 'unreadable', entry: { relPath } })),
  ].sort((a, b) => a.entry.relPath.localeCompare(b.entry.relPath));
  return (
    <ul className="tree" aria-label={label}>
      {rows.map((row) => {
        const depth = row.entry.relPath.split('/').length - 1;
        const style = { paddingLeft: `${String(8 + depth * 16)}px` };
        if (row.kind === 'in' && row.entry.suspectedSecret === true) {
          return (
            <li key={`in:${row.entry.relPath}`} style={style}>
              <TriangleAlert aria-hidden="true" />
              <span className="path">{row.entry.relPath}</span>
              <span className="why">
                {suspectedSecretText(row.entry.secretLabel, row.entry.secretLine)}. Not selected by default.
              </span>
            </li>
          );
        }
        if (row.kind === 'in') {
          return (
            <li key={`in:${row.entry.relPath}`} style={style}>
              <File aria-hidden="true" />
              <span className="path">{row.entry.relPath}</span>
              <span className="why">{formatBytes(row.entry.sizeBytes)}</span>
            </li>
          );
        }
        if (row.kind === 'unreadable') {
          return (
            <li key={`unreadable:${row.entry.relPath}`} className="excluded" style={style}>
              <FileX aria-hidden="true" />
              <span className="path">{row.entry.relPath}</span>
              <span className="why">{UNREADABLE_FILE_TEXT}</span>
            </li>
          );
        }
        return (
          <li key={`out:${row.entry.relPath}`} className="excluded" style={style}>
            <FileX aria-hidden="true" />
            <span className="path">{row.entry.relPath}</span>
            <span className="why">Excluded: {exclusionReasonText(row.entry.reason)}</span>
          </li>
        );
      })}
    </ul>
  );
}
