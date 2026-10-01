import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as asar from '@electron/asar';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from './package-temp-dir.js';
import {
  ALLOWLISTED_MARKER,
  findSecretsInText,
  formatFinding,
  KNOWN_TEST_KEYS,
  lineCol,
  newlineOffsets,
  scanBytes,
  scanPath,
  type SecretFinding,
} from './secrets-scan.js';

// Fake, credential-shaped values built at runtime so this source file holds no complete key literal.
const FAKE_ANTHROPIC = ['sk-ant-api03', 'Zq9Xw8Vu7Ts6Rp5On4Ml3Kj2'].join('-');
const FAKE_OPENAI = ['sk-proj', 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8'].join('-');
const FIXTURE_LINE = `SAMPLE_API_TOKEN=${ALLOWLISTED_MARKER}-1234567890`;

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await makeTempDir('scan-test-');
  dirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => removeDir(d)));
});

function expectNoLeak(findings: readonly SecretFinding[], ...secrets: string[]): void {
  const printed = findings.map(formatFinding).join('\n');
  for (const s of secrets) expect(printed).not.toContain(s.slice(8));
}

describe('findSecretsInText', () => {
  it('flags contracts SECRET_PATTERNS matches with a redacted label', () => {
    const hits = findSecretsInText(`{"level":"info","msg":"key ${FAKE_ANTHROPIC} used"}`);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.label).toMatch(/^\[REDACTED:sk-…/);
    expect(hits[0]?.label).not.toContain(FAKE_ANTHROPIC.slice(8));
  });

  it('allows only the literal sk-fixture-DO-NOT-READ marker', () => {
    expect(findSecretsInText(FIXTURE_LINE)).toEqual([]);
    expect(findSecretsInText(`${ALLOWLISTED_MARKER} ${FAKE_OPENAI}`)).toHaveLength(1);
    expect(findSecretsInText('sk-fixture-do-not-read-1234567890abcdef')).toHaveLength(1);
  });

  it('ignores lookalikes: words ending in -sk, minified apiKey property copies', () => {
    expect(findSecretsInText('risk-assessment-module-x1234567890 task-abcdefghijklmnop12')).toEqual([]);
    expect(findSecretsInText('const o={apiKey:t.apiKey},n={apiKey:e.apiKey};')).toEqual([]);
  });

  it('in binary data, finds a provider key behind an alphanumeric record-header byte', () => {
    const record = `\u0003Y${FAKE_ANTHROPIC}`;

    expect(findSecretsInText(record, true)).toHaveLength(1);
    expect(findSecretsInText(record, false)).toEqual([]);
    expect(findSecretsInText('\u0003task-abcdefghij0123456789', true)).toEqual([]);
  });

  it('flags every known e2e test key', () => {
    for (const key of KNOWN_TEST_KEYS) expect(findSecretsInText(`x ${key} y`)).toHaveLength(1);
  });
});

describe('line locations', () => {
  it('maps offsets to 1-based line:col, including offsets on a newline and past the last one', () => {
    const text = 'ab\ncd\n\nef';
    const nl = newlineOffsets(text);

    expect(nl).toEqual([2, 5, 6]);
    expect([0, 1, 2, 3, 6, 7, 8].map((o) => lineCol(nl, o))).toEqual([
      'line 1:1',
      'line 1:2',
      'line 1:3',
      'line 2:1',
      'line 3:1',
      'line 4:1',
      'line 4:2',
    ]);
    expect(lineCol([], 5)).toBe('line 1:6');
  });

  it('locates many hits in a large file in linear time (one newline pass, not one per hit)', () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `const k${String(i)} = "${FAKE_OPENAI}${String(i).padStart(6, '0')}";`);
    const bytes = Buffer.from(lines.join('\n'), 'latin1');

    const start = performance.now();
    const findings = scanBytes(bytes, 'big.js');
    const ms = performance.now() - start;

    expect(findings).toHaveLength(20_000);
    expect(findings[0]?.location).toBe('line 1:13');
    expect(findings[19_999]?.location).toBe('line 20000:17');
    expect(ms).toBeLessThan(2_000);
  });

  it('confirms a candidate with its next char: an authorization value followed by ( is a call, not a key', () => {
    expect(findSecretsInText('authorization: getHeaderValue123456(req)')).toEqual([]);
    expect(findSecretsInText('authorization: abcdefgh12345678wxyz')).toHaveLength(1);
  });
});

describe('scanPath', () => {
  it('reports path, line location and label for a secret in a log, and nothing for the fixture marker', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'logs'));
    await writeFile(path.join(dir, 'logs', 'main.jsonl'), `{"a":1}\n{"msg":"${FAKE_ANTHROPIC}"}\n`);
    await writeFile(path.join(dir, 'export.md'), `${FIXTURE_LINE}\n`);

    const s = await scanPath(dir);

    expect(s.findings).toHaveLength(1);
    expect(s.findings[0]?.file).toBe(path.join(dir, 'logs', 'main.jsonl'));
    expect(s.findings[0]?.location).toBe('line 2:9');
    expectNoLeak(s.findings, FAKE_ANTHROPIC);
  });

  it('scans every table and column of a *.sqlite read-only', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'relay.sqlite');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE a (id INTEGER PRIMARY KEY, note TEXT, big INTEGER); CREATE TABLE "odd ""name""" (blobby BLOB)');
    // A 64-bit integer beyond Number.MAX_SAFE_INTEGER (Chromium databases hold these) must not abort the scan.
    db.prepare('INSERT INTO a (note, big) VALUES (?, ?), (?, ?)').run('clean', 13435333968325197n, FIXTURE_LINE, 1);
    db.prepare('INSERT INTO "odd ""name""" VALUES (?)').run(Buffer.from(`Bearer ${FAKE_OPENAI}`));
    db.close();

    const s = await scanPath(dir);

    expect(s.tablesScanned).toBe(2);
    expect(s.findings.map((f) => f.location)).toContain('odd "name".blobby row 1');
    expect(s.findings.some((f) => f.location.startsWith('a.'))).toBe(false);
    expectNoLeak(s.findings, FAKE_OPENAI);
  });

  it('finds a secret that exists only in the -wal file', async () => {
    const src = await tempDir();
    const dst = await tempDir();
    const db = new DatabaseSync(path.join(src, 'relay.sqlite'));
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (v TEXT)');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.prepare('INSERT INTO t VALUES (?)').run(FAKE_ANTHROPIC);
    // Copy while the writer is open: the row lives only in WAL frames, not in the main file.
    for (const ext of ['', '-wal', '-shm']) await copyFile(path.join(src, `relay.sqlite${ext}`), path.join(dst, `relay.sqlite${ext}`));
    db.close();

    const s = await scanPath(dst);

    const walHits = s.findings.filter((f) => f.file.endsWith('.sqlite-wal'));
    expect(walHits.length).toBeGreaterThanOrEqual(1);
    expect(walHits[0]?.location).toMatch(/^byte \d+$/);
    expect(s.findings.some((f) => f.file.endsWith('relay.sqlite') && f.location.startsWith('byte'))).toBe(false);
    expectNoLeak(s.findings, FAKE_ANTHROPIC);
  });

  it('never modifies the scanned dir (no -wal/-shm created by opening a WAL database)', async () => {
    const dir = await tempDir();
    const db = new DatabaseSync(path.join(dir, 'relay.sqlite'));
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('clean')");
    db.close();
    const before = (await readdir(dir)).sort();

    const s = await scanPath(dir);

    expect(s.tablesScanned).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(before);
  });

  it('finds known test keys stored as UTF-16LE or base64', async () => {
    const dir = await tempDir();
    const key = KNOWN_TEST_KEYS[0] ?? '';
    await writeFile(path.join(dir, 'a.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(key, 'utf16le')]));
    await writeFile(path.join(dir, 'b.txt'), Buffer.from(key).toString('base64'));

    const s = await scanPath(dir);

    expect(s.findings.map((f) => path.basename(f.file)).sort()).toEqual(['a.bin', 'b.txt']);
    expectNoLeak(s.findings, key);
  });

  it('scans members of an asar archive', async () => {
    const src = await tempDir();
    const out = await tempDir();
    await mkdir(path.join(src, 'out', 'main'), { recursive: true });
    await writeFile(path.join(src, 'out', 'main', 'index.js'), `const k="${FAKE_OPENAI}";`);
    await writeFile(path.join(src, 'package.json'), '{}');
    const archive = path.join(out, 'app.asar');
    await asar.createPackage(src, archive);

    const s = await scanPath(out);

    expect(s.findings.map((f) => f.file)).toContain(`${archive}:/out/main/index.js`);
    expectNoLeak(s.findings, FAKE_OPENAI);
  });

  it('fails closed on a *.sqlite it cannot open', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'broken.sqlite'), 'not a database');

    const s = await scanPath(dir);

    expect(s.findings.map((f) => f.label)).toEqual([expect.stringMatching(/^\[UNSCANNABLE/)]);
  });

  it('skips the Electron vendor binaries of a packaged .app', async () => {
    const dir = await tempDir();
    const fw = path.join(dir, 'Relay.app', 'Contents', 'Frameworks');
    await mkdir(fw, { recursive: true });
    await writeFile(path.join(fw, 'blob'), FAKE_OPENAI);

    const s = await scanPath(dir);

    expect(s.findings).toEqual([]);
    expect(s.skipped).toEqual([fw]);
  });
});
