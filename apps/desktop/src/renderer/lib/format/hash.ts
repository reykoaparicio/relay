const HEAD = 4;
const TAIL = 4;

/**
 * Shortens a sha256 for display: "6f4a…b18c". The caller must also expose the full value
 * (title + CopyButton; §5.7 no tooltip-only info), which the `Hash` component does.
 */
export function formatHash(sha: string): string {
  if (sha.length <= HEAD + TAIL + 1) return sha;
  return `${sha.slice(0, HEAD)}…${sha.slice(-TAIL)}`;
}
