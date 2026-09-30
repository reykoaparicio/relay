/**
 * Minimal strict unified-diff applier for fixture checks (11 §K6 `fixtures.int.test.ts`, FR-10 checks). Every context
 * and removed line must match exactly at the hunk's position (no fuzz), mirroring how the engine's F8 validation
 * rejects a patch that does not apply cleanly.
 */

export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses the hunks of a single-file unified diff. @throws Error on a malformed header. */
export function parseHunks(diff: string): Hunk[] {
  const lines = diff.split('\n');
  const hunks: Hunk[] = [];
  let current: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    const m = HUNK_RE.exec(line);
    if (m !== null) {
      current = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (current === null) continue;
    // Stop once the header's line counts are satisfied (a trailing '' after the final newline is not a context line).
    const olds = current.lines.filter((l) => !l.startsWith('+')).length;
    const news = current.lines.filter((l) => !l.startsWith('-')).length;
    if (olds >= current.oldLines && news >= current.newLines) continue;
    if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) current.lines.push(line);
    else if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    else if (line === '') current.lines.push(' '); // an empty context line whose leading space was stripped
  }
  return hunks;
}

/** Applies `diff` to `content`; returns the new content or `null` when any hunk does not apply exactly. */
export function applyUnifiedDiff(content: string, diff: string): string | null {
  const src = content.split('\n');
  const out: string[] = [];
  let cursor = 0; // index into src
  for (const h of parseHunks(diff)) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    if (start < cursor) return null;
    out.push(...src.slice(cursor, start));
    let i = start;
    let removedOrKept = 0;
    for (const l of h.lines) {
      const body = l.slice(1);
      if (l.startsWith('+')) {
        out.push(body);
        continue;
      }
      if (src[i] !== body) return null;
      if (l.startsWith(' ')) out.push(body);
      i += 1;
      removedOrKept += 1;
    }
    if (removedOrKept !== h.oldLines) return null;
    cursor = i;
  }
  out.push(...src.slice(cursor));
  return out.join('\n');
}
