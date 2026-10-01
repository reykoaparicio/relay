// Secret scanner for `check:secrets` (13 §M2, §3.3, §18.2). Candidates come from the contracts SECRET_PATTERNS and are
// confirmed with looksLikeSecret, plus the literal e2e test keys in plaintext / UTF-16LE / base64. Findings carry a
// path, a location and a redacted label only; the matched secret is never returned or printed.
import { copyFile, lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as asar from '@electron/asar';
import { looksLikeSecret, redactedLabel, redactString, SECRET_PATTERNS } from '@relay/contracts';
import { makeTempDir, removeDir } from './package-temp-dir.js';

/** The only allowlisted text (13 §M2): the obviously fake fixture marker. Nothing else is exempt. */
export const ALLOWLISTED_MARKER = 'sk-fixture-DO-NOT-READ';

/** Keys the e2e suite types into the app (tests/e2e/flows.ts, provider-settings.spec.ts). Never valid credentials. */
export const KNOWN_TEST_KEYS: readonly string[] = [
  'sk-ant-e2e-ABCDEFGHIJKLMNOP',
  'sk-ant-e2e-SETTINGS-KEYCHAIN-QRSTUVWX',
  'sk-proj-e2e-SETTINGS-SESSION-YZ123456',
];

/**
 * Upstream Electron binaries inside a packaged `.app`: vendor code, not ours (our code is in app.asar). Scanning
 * hundreds of MB of machine code only yields noise.
 */
const VENDOR_DIRS: readonly string[] = [`Contents${path.sep}Frameworks`, `Contents${path.sep}MacOS`];

export interface SecretFinding {
  /** File path (asar members: `<archive>:<member>`). */
  readonly file: string;
  /** `line L:C`, `byte N`, or `table.column row N`. */
  readonly location: string;
  /** Redacted label such as `[REDACTED:sk-…WXYZ]`. Never the secret. */
  readonly label: string;
}

export interface ScanSummary {
  readonly findings: SecretFinding[];
  readonly filesScanned: number;
  readonly tablesScanned: number;
  readonly skipped: string[];
}

interface Hit {
  readonly offset: number;
  readonly label: string;
}

/** Replaces each literal allowlisted marker with same-length spaces, so offsets stay valid and nothing else is exempt. */
export function maskAllowlisted(text: string): string {
  return text.replaceAll(ALLOWLISTED_MARKER, ' '.repeat(ALLOWLISTED_MARKER.length));
}

/** The redacted form of a match; falls back to a bare marker if redaction ever left something secret-shaped. */
function safeLabel(match: string): string {
  const label = redactString(match);
  return looksLikeSecret(label) ? '[REDACTED]' : label;
}

/**
 * Binary records (SQLite pages, WAL frames) put a length/type byte right before a value, and that byte is often
 * alphanumeric, which defeats the patterns' `(?<![A-Za-z0-9])` guard. In binary data a key is therefore also tried
 * from each distinctive provider prefix regardless of the preceding byte; the bare `sk-` prefix only with ≥ 32 token
 * chars (real legacy keys are ~48), so prose like "task-…" stays clean.
 */
const BINARY_ANCHOR_RE = /(?<=[A-Za-z0-9])(?:sk-ant-|sk-proj-|sk-svcacct-|github_pat_|gh[pousr]_|AIza|sk-(?=[A-Za-z0-9_-]{32}))/g;
const ANCHORED_PATTERNS: readonly RegExp[] = SECRET_PATTERNS.map((re) => new RegExp(`^(?:${re.source})`, re.flags.replace('g', '')));
const ANCHOR_WINDOW = 4096;

function anchoredHit(masked: string, at: number): Hit | null {
  // Slicing makes `at` the string start, so the lookbehind sees no preceding byte.
  const window = masked.slice(at, at + ANCHOR_WINDOW);
  for (const re of ANCHORED_PATTERNS) {
    const m = re.exec(window);
    if (m !== null && looksLikeSecret(m[0])) return { offset: at, label: safeLabel(m[0]) };
  }
  return null;
}

/** Pattern hits in `text` (already decoded), deduplicated by offset. `binary` adds the prefix-anchored pass above. */
export function findSecretsInText(text: string, binary = false): Hit[] {
  const masked = maskAllowlisted(text);
  const hits = new Map<number, Hit>();
  for (const re of SECRET_PATTERNS) {
    // matchAll clones the regex, so the shared global pattern's lastIndex is never touched.
    for (const m of masked.matchAll(re)) {
      if (hits.has(m.index) || !looksLikeSecret(m[0])) continue;
      hits.set(m.index, { offset: m.index, label: safeLabel(m[0]) });
    }
  }
  if (binary) {
    for (const m of masked.matchAll(BINARY_ANCHOR_RE)) {
      const hit = hits.has(m.index) ? null : anchoredHit(masked, m.index);
      if (hit !== null) hits.set(m.index, hit);
    }
  }
  for (const key of KNOWN_TEST_KEYS) {
    for (let i = masked.indexOf(key); i !== -1; i = masked.indexOf(key, i + 1)) {
      if (!hits.has(i)) hits.set(i, { offset: i, label: `[REDACTED:test-key ${redactedLabel(key)}]` });
    }
  }
  return [...hits.values()].sort((a, b) => a.offset - b.offset);
}

/** Known test keys hidden in UTF-16LE or base64 (patterns only see single-byte text). */
function findEncodedTestKeys(bytes: Buffer): Hit[] {
  const hits: Hit[] = [];
  for (const key of KNOWN_TEST_KEYS) {
    const forms: [string, Buffer][] = [
      ['utf16le', Buffer.from(key, 'utf16le')],
      ['base64', Buffer.from(Buffer.from(key).toString('base64'))],
    ];
    for (const [enc, needle] of forms) {
      const i = bytes.indexOf(needle);
      if (i !== -1) hits.push({ offset: i, label: `[REDACTED:test-key ${redactedLabel(key)} ${enc}]` });
    }
  }
  return hits;
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

function lineCol(text: string, offset: number): string {
  let line = 1;
  let start = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
    line += 1;
    start = i + 1;
  }
  return `line ${String(line)}:${String(offset - start + 1)}`;
}

/** Scans raw bytes (latin1 keeps one char per byte, so binary files and WAL frames scan safely). */
export function scanBytes(bytes: Buffer, file: string): SecretFinding[] {
  const text = bytes.toString('latin1');
  const binary = isBinary(bytes);
  const where = (o: number): string => (binary ? `byte ${String(o)}` : lineCol(text, o));
  return [...findSecretsInText(text, binary), ...findEncodedTestKeys(bytes)].map((h) => ({ file, location: where(h.offset), label: h.label }));
}

function cellText(v: unknown): string {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('latin1');
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return v.toString();
  return '';
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Scans every column of every table listed in sqlite_master of an opened database. */
function scanOpenDb(db: DatabaseSync, file: string): { findings: SecretFinding[]; tables: number } {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  const findings: SecretFinding[] = [];
  for (const { name } of tables) {
    let row = 0;
    const stmt = db.prepare(`SELECT * FROM ${quoteIdent(name)}`);
    stmt.setReadBigInts(true); // Chromium's own databases hold 64-bit integers beyond Number.MAX_SAFE_INTEGER
    for (const r of stmt.iterate()) {
      row += 1;
      for (const [col, value] of Object.entries(r as Record<string, unknown>)) {
        for (const h of findSecretsInText(cellText(value), value instanceof Uint8Array)) {
          findings.push({ file, location: `${name}.${col} row ${String(row)}`, label: h.label });
        }
      }
    }
  }
  return { findings, tables: tables.length };
}

const SQLITE_SIDECARS = ['', '-wal', '-shm', '-journal'] as const;

/**
 * Scans a SQLite database logically. Opening a WAL database (even read-only) can create `-wal`/`-shm` files, so the
 * database and its sidecars are copied to a private temp dir first and opened read-only there: the scanned directory
 * is never modified, and committed WAL frames are still part of the logical view.
 */
export async function scanSqlite(file: string): Promise<{ findings: SecretFinding[]; tables: number }> {
  const tmp = await makeTempDir('sqlite-');
  try {
    const copy = path.join(tmp, 'db.sqlite');
    for (const ext of SQLITE_SIDECARS) await copyFile(`${file}${ext}`, `${copy}${ext}`).catch((err: unknown) => {
      if (ext === '') throw err;
    });
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      return scanOpenDb(db, file);
    } finally {
      db.close();
    }
  } finally {
    await removeDir(tmp);
  }
}

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

interface AsarNode {
  readonly files?: Record<string, AsarNode>;
  readonly link?: string;
  readonly unpacked?: boolean;
}

function asarMembers(node: AsarNode, prefix: string, out: string[]): string[] {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${name}`;
    if (child.files !== undefined) asarMembers(child, p, out);
    else if (child.link === undefined && child.unpacked !== true) out.push(p); // unpacked members are scanned on disk
  }
  return out;
}

/** Scans every packed member of an asar archive. Returns the number of members scanned. */
/** Packed file members of an asar archive (`/out/main/index.js`, …): no dirs, links or unpacked members. */
export function listAsarFiles(file: string): string[] {
  return asarMembers(asar.getRawHeader(file).header, '', []);
}

export function scanAsar(file: string): { findings: SecretFinding[]; members: number } {
  const members = listAsarFiles(file);
  const findings = members.flatMap((m) => scanBytes(asar.extractFile(file, m.slice(1)), `${file}:${m}`));
  return { findings, members: members.length };
}

async function listFiles(root: string, skipped: string[]): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(root, e.name);
    if (e.isDirectory()) {
      if (VENDOR_DIRS.some((v) => abs.endsWith(v))) skipped.push(abs);
      else out.push(...(await listFiles(abs, skipped)));
    } else if (e.isFile()) {
      out.push(abs);
    } // symlinks are never followed
  }
  return out;
}

/** Fail closed: a file that cannot be scanned is reported, not ignored. */
function unreadable(file: string, err: unknown): SecretFinding {
  const reason = err instanceof Error ? err.message.split('\n')[0] ?? 'error' : 'error';
  return { file, location: 'whole file', label: `[UNSCANNABLE: ${safeLabel(reason)}]` };
}

async function scanFile(file: string, acc: { findings: SecretFinding[]; tables: number; files: number }): Promise<void> {
  acc.files += 1;
  try {
    if (file.endsWith('.asar')) {
      // Members are scanned one by one (precise locations); a raw pass over the archive would only duplicate them.
      const r = scanAsar(file);
      acc.findings.push(...r.findings);
      acc.files += r.members;
      return;
    }
    // Raw bytes for every other file (including *.sqlite free pages and *.sqlite-wal frames), plus the logical DB pass
    // for *.sqlite and any other file with the SQLite header (Chromium's own databases in userData).
    const bytes = await readFile(file);
    acc.findings.push(...scanBytes(bytes, file));
    if (file.endsWith('.sqlite') || bytes.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
      const r = await scanSqlite(file);
      acc.findings.push(...r.findings);
      acc.tables += r.tables;
    }
  } catch (err) {
    acc.findings.push(unreadable(file, err));
  }
}

/** Scans every regular file under `root` (or `root` itself when it is a file). */
export async function scanPath(root: string): Promise<ScanSummary> {
  const skipped: string[] = [];
  const st = await lstat(root);
  const files = st.isDirectory() ? await listFiles(root, skipped) : [root];
  const acc = { findings: [] as SecretFinding[], tables: 0, files: 0 };
  for (const f of files) await scanFile(f, acc);
  return { findings: acc.findings, filesScanned: acc.files, tablesScanned: acc.tables, skipped };
}

/** One printable line per finding: path, location, redacted label. */
export function formatFinding(f: SecretFinding): string {
  return `${f.file}  ${f.location}  ${f.label}`;
}
