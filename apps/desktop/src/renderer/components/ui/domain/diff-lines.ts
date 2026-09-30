export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Visible gutter glyph so additions/deletions are not shown by color alone. */
  readonly glyph: string;
  readonly text: string;
}

/** "@@ -a[,b] +c[,d] @@": an omitted count means 1 line (unified diff format). */
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

interface HunkBudget {
  oldLeft: number;
  newLeft: number;
}

function hunkBudget(line: string): HunkBudget {
  const m = HUNK_HEADER.exec(line);
  // A malformed header has no counts: treat the rest of the section as hunk body (safest for +/- lines).
  if (m === null) return { oldLeft: Number.POSITIVE_INFINITY, newLeft: Number.POSITIVE_INFINITY };
  return { oldLeft: Number(m[1] ?? '1'), newLeft: Number(m[2] ?? '1') };
}

/** Lines that can only be file headers: hunk body lines always start with ' ', '+', '-' or '\'. */
function isGitHeader(line: string): boolean {
  return line.startsWith('diff ') || line.startsWith('index ');
}

/** Body line inside a hunk. The leading +/-/space is moved into `glyph`; the hunk budget is consumed. */
function hunkLine(line: string, budget: HunkBudget): DiffLine {
  if (line.startsWith('+')) {
    budget.newLeft -= 1;
    return { kind: 'add', glyph: '+', text: line.slice(1) };
  }
  if (line.startsWith('-')) {
    budget.oldLeft -= 1;
    return { kind: 'del', glyph: '−', text: line.slice(1) };
  }
  // "\ No newline at end of file" annotates the previous line and does not count.
  if (line.startsWith('\\')) return { kind: 'meta', glyph: ' ', text: line };
  budget.oldLeft -= 1;
  budget.newLeft -= 1;
  return { kind: 'context', glyph: ' ', text: line.startsWith(' ') ? line.slice(1) : line };
}

/** Line outside any hunk: "---"/"+++" here are file headers, not a deleted "-- x" or added "++i;". */
function headerSectionLine(line: string): DiffLine {
  if (line.startsWith('+++') || line.startsWith('---')) return { kind: 'meta', glyph: ' ', text: line };
  if (line.startsWith('+')) return { kind: 'add', glyph: '+', text: line.slice(1) };
  if (line.startsWith('-')) return { kind: 'del', glyph: '−', text: line.slice(1) };
  return { kind: 'context', glyph: ' ', text: line.startsWith(' ') ? line.slice(1) : line };
}

/**
 * Splits a unified diff into typed lines. Hunk line counts decide where each hunk ends, so a body line
 * that happens to start with "---" or "+++" is a deletion/addition, while the same prefix between files
 * (before the first "@@" of a file section) is a file header.
 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines = diff.replace(/\n$/, '').split('\n');
  let budget: HunkBudget | null = null;
  return lines.map((line): DiffLine => {
    if (line.startsWith('@@')) {
      budget = hunkBudget(line);
      return { kind: 'hunk', glyph: '@', text: line };
    }
    if (isGitHeader(line)) {
      budget = null;
      return { kind: 'meta', glyph: ' ', text: line };
    }
    if (budget !== null && (budget.oldLeft > 0 || budget.newLeft > 0 || line.startsWith('\\'))) {
      return hunkLine(line, budget);
    }
    budget = null;
    return headerSectionLine(line);
  });
}
