// Scans a retained userData directory for plaintext secrets (§3.3, §18.2): raw bytes of every file (DB, -wal/-shm,
// logs, artifacts, exports, secrets, call log) plus a logical dump of every SQLite table via `node:sqlite`.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SecretHit {
  readonly where: string;
  readonly needle: string;
}

export interface ScanReport {
  readonly filesScanned: string[];
  readonly tablesDumped: string[];
  readonly hits: SecretHit[];
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(abs)));
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

/** Plaintext, UTF-16LE and base64 encodings of each needle. */
function encodings(needle: string): Buffer[] {
  return [Buffer.from(needle, 'utf8'), Buffer.from(needle, 'utf16le'), Buffer.from(Buffer.from(needle).toString('base64'))];
}

function cellText(v: unknown): string {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('latin1');
  return typeof v === 'string' ? v : JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
}

/** Dumps every table of a SQLite database (read-only) as text: `table\trow-json` lines. */
export function dumpSqlite(dbFile: string): { tables: string[]; text: string } {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    const lines: string[] = [];
    for (const t of tables) {
      for (const row of db.prepare(`SELECT * FROM "${t.replaceAll('"', '""')}"`).all()) {
        lines.push(`${t}\t${Object.values(row as Record<string, unknown>).map(cellText).join('\t')}`);
      }
    }
    return { tables, text: lines.join('\n') };
  } finally {
    db.close();
  }
}

/** Scans `dir` for `needles`. `dumpDb` also dumps `relay.sqlite` when present (only when the app is closed). */
export async function scanForSecrets(dir: string, needles: readonly string[], opts: { dumpDb: boolean }): Promise<ScanReport> {
  const files = await listFiles(dir);
  const hits: SecretHit[] = [];
  for (const f of files) {
    const bytes = await readFile(f).catch(() => null);
    if (bytes === null) continue;
    for (const n of needles) if (encodings(n).some((enc) => bytes.includes(enc))) hits.push({ where: path.relative(dir, f), needle: n });
  }
  const tablesDumped: string[] = [];
  const dbFile = path.join(dir, 'relay.sqlite');
  if (opts.dumpDb && (await stat(dbFile).catch(() => null)) !== null) {
    const dump = dumpSqlite(dbFile);
    tablesDumped.push(...dump.tables);
    for (const n of needles) if (dump.text.includes(n)) hits.push({ where: 'relay.sqlite (logical dump)', needle: n });
  }
  return { filesScanned: files.map((f) => path.relative(dir, f)), tablesDumped, hits };
}
