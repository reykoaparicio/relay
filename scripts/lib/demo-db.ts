// 13 §M3: the one direct DB write of the demo scripts. There is no IPC op that moves a project's root (projects.update
// cannot change it, by design), but a restored snapshot must point the demo project at the sample copy that exists on
// THIS machine. So demo-snapshot binds the demo project to a placeholder (no machine-specific path is committed) and
// demo-reset rebinds it to the restored sample copy. Both touch only the `is_demo = 1` project row, through the
// @relay/storage driver, while no app or runtime has the file open.
import { openNodeSqlite } from '@relay/storage';

/** Root the committed snapshot carries for the demo project until demo-reset rebinds it. */
export const SNAPSHOT_ROOT_PLACEHOLDER = '/relay-demo-sample-root/sample-api';
/** Display path the committed snapshot carries. */
export const SNAPSHOT_DISPLAY_PLACEHOLDER = 'sample-api (rebound by demo:reset)';

/**
 * Points the single demo project of `dbPath` at `rootRealpath`.
 * @throws Error when the DB does not hold exactly one demo project.
 */
export function rebindDemoProject(dbPath: string, rootRealpath: string, rootDisplayPath: string): void {
  const db = openNodeSqlite(dbPath);
  try {
    const row = db.prepare('SELECT count(*) AS n FROM projects WHERE is_demo = 1').get() as { n?: unknown } | undefined;
    const n = Number(row?.n ?? 0);
    if (n !== 1) throw new Error(`expected exactly one demo project in ${dbPath}, found ${String(n)}`);
    db.exec('PRAGMA secure_delete = ON'); // the old root must not linger in freed pages
    db.prepare('UPDATE projects SET root_realpath = ?, root_display_path = ? WHERE is_demo = 1').run(rootRealpath, rootDisplayPath);
  } finally {
    db.close();
  }
}

/**
 * Switches a standalone DB copy to rollback-journal mode (one self-contained file, no -wal/-shm) and VACUUMs it, so no
 * freed page still holds an old value (e.g. the machine-specific root the placeholder replaced). The app switches the
 * file back to WAL when it opens it.
 */
export function makeSelfContained(dbPath: string): void {
  const db = openNodeSqlite(dbPath);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('VACUUM');
  } finally {
    db.close();
  }
}
