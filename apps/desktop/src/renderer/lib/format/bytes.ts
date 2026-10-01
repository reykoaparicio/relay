const KIB = 1024;

/** "38.6 KB" style sizes for preview totals, file rows, backups and the database size. */
export function formatBytes(n: number): string {
  if (n < KIB) return `${String(n)} B`;
  if (n < KIB * KIB) return `${(n / KIB).toFixed(1)} KB`;
  return `${(n / (KIB * KIB)).toFixed(1)} MB`;
}
