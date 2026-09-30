/** `YYYYMMDD-HHmmss` (UTC) for backup directory names (03 §C2, §C7). */
export function backupStamp(ms: number): string {
  const iso = new Date(ms).toISOString(); // 2026-09-30T12:34:56.789Z
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
}
