export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Visible gutter glyph so additions/deletions are not shown by color alone. */
  readonly glyph: string;
  readonly text: string;
}

/** Splits a unified diff into typed lines. The leading +/-/space is moved into `glyph`. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines = diff.replace(/\n$/, '').split('\n');
  return lines.map((line): DiffLine => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      return { kind: 'meta', glyph: ' ', text: line };
    }
    if (line.startsWith('@@')) return { kind: 'hunk', glyph: '@', text: line };
    if (line.startsWith('+')) return { kind: 'add', glyph: '+', text: line.slice(1) };
    if (line.startsWith('-')) return { kind: 'del', glyph: '−', text: line.slice(1) };
    return { kind: 'context', glyph: ' ', text: line.startsWith(' ') ? line.slice(1) : line };
  });
}
