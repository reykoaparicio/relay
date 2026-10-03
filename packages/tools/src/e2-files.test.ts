// E2 file-tool fixes: hard links refused (#13, audit F5), suspected secrets by content (#11, audit F1) in the scan
// preview and at intake (readSelected secretCheck), and the content detector itself.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeRelPath, openProjectRoot, readConfined } from './paths.js';
import { readSelected } from './read.js';
import { scanProject } from './scan.js';
import { SECRET_SCAN_MAX_CHARS, detectSuspectedSecret, unacknowledgedSuspectedSecret } from './secret-scan.js';
import { tempDirs, writeTree } from './testing/temp-dirs.js';

const tmp = tempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

// Built at runtime so this file itself never contains a credential-shaped literal.
const ANT = ['sk', 'ant', 'api03', 'Ab3dEfGh1JkLmN0pQrStUvWxYz0123456789abcd'].join('-');
const GH = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const AWS = ['AKIA', 'ABCDEFGHIJ234567'].join('');
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

async function openRoot(dir: string) {
  const r = await openProjectRoot(dir, { userDataDir: path.join(dir, '..', 'relay-ud-never') });
  if (!r.ok) throw new Error('root refused');
  return r.value;
}

describe('#13 hard links (audit F5)', () => {
  it('a hard link to a file outside the project is excluded by the scan and refused by reads', async () => {
    const outside = await tmp.make('relay-outside-');
    const dir = await tmp.make();
    await writeTree(outside, { 'creds.txt': 'aws_secret=OUTSIDE\n' });
    await writeTree(dir, { 'src/a.ts': 'export const a = 1;\n' });
    await fs.promises.link(path.join(outside, 'creds.txt'), path.join(dir, 'innocent.txt'));
    const root = await openRoot(dir);
    const rel = normalizeRelPath('innocent.txt');
    if (!rel.ok) throw new Error('rel');

    const scan = await scanProject(root);
    const confined = await readConfined(root, rel.value, 1024);
    const selected = await readSelected(root, ['innocent.txt']);

    expect(scan.ok && scan.value.included.map((f) => f.relPath)).toEqual(['src/a.ts']);
    expect(scan.ok && scan.value.excluded).toEqual([{ relPath: 'innocent.txt', reason: 'hard_link', isDirectory: false }]);
    expect(confined.ok || confined.error.details).toMatchObject({ reason: 'excluded', exclusion: 'hard_link' });
    expect(selected.ok || selected.error.details).toMatchObject({ reason: 'hard_link', relPath: 'innocent.txt', denied: [{ relPath: 'innocent.txt', reason: 'hard_link' }] });
    expect(JSON.stringify(selected)).not.toContain('OUTSIDE');
  });

  it('round-3 M2: a hard-linked .gitignore still applies its rules (never "no rules": fail closed), in the scan and in direct reads', async () => {
    const shared = await tmp.make('relay-shared-');
    const dir = await tmp.make();
    await writeTree(shared, { 'shared.gitignore': 'private-notes.md\nsub/hidden.txt\n' });
    await writeTree(dir, { 'a.ts': 'export const a = 1;\n', 'private-notes.md': 'do not send\n', 'sub/hidden.txt': 'nor this\n' });
    await fs.promises.link(path.join(shared, 'shared.gitignore'), path.join(dir, '.gitignore'));
    const root = await openRoot(dir);

    const scan = await scanProject(root);
    const read = await readSelected(root, ['private-notes.md'], { respectGitignore: true });
    const nested = await readSelected(root, ['sub/hidden.txt'], { respectGitignore: true });

    expect(scan.ok && scan.value.included.map((f) => f.relPath)).toEqual(['a.ts']);
    expect(scan.ok && scan.value.excluded).toEqual(expect.arrayContaining([{ relPath: 'private-notes.md', reason: 'gitignored', isDirectory: false }]));
    expect(read.ok).toBe(false);
    expect(nested.ok).toBe(false);
    expect(JSON.stringify([read, nested])).not.toContain('do not send');
    // The .gitignore itself is still never sent: reading it as an input file is refused as a hard link.
    expect((await readSelected(root, ['.gitignore'])).ok).toBe(false);
  });

  it('two hard-linked names inside the project are both refused (the inode is shared; nlink > 1)', async () => {
    const dir = await tmp.make();
    await writeTree(dir, { 'a.txt': 'same\n' });
    await fs.promises.link(path.join(dir, 'a.txt'), path.join(dir, 'b.txt'));

    const scan = await scanProject(await openRoot(dir));

    expect(scan.ok && scan.value.excluded.map((e) => [e.relPath, e.reason])).toEqual([['a.txt', 'hard_link'], ['b.txt', 'hard_link']]);
  });
});

describe('#11 suspected secrets by content (audit F1)', () => {
  it('unacknowledgedSuspectedSecret (the shared preflight/intake predicate) = detectSuspectedSecret unless acknowledged WITH the current content hash', () => {
    const content = `const k = '${GH}';`;
    const hit = { relPath: 'src/k.ts', content, sha256: sha(content) };

    expect(unacknowledgedSuspectedSecret(hit, [])).toEqual(detectSuspectedSecret(hit.content));
    expect(unacknowledgedSuspectedSecret(hit, [{ relPath: 'src/other.ts', sha256: sha(content) }])).not.toBeNull();
    expect(unacknowledgedSuspectedSecret(hit, [{ relPath: 'src/k.ts', sha256: sha(content) }])).toBeNull();
    // Round-3 M4: the same path with a different (older) content hash is flagged again.
    expect(unacknowledgedSuspectedSecret(hit, [{ relPath: 'src/k.ts', sha256: sha('const k = "fixture";') }])).toEqual(detectSuspectedSecret(content));
    const clean = "const api_key = 'abcdefghijklmnopqrstuvwx';";
    expect(unacknowledgedSuspectedSecret({ relPath: 'a.ts', content: clean, sha256: sha(clean) }, [])).toBeNull();
  });

  it('detectSuspectedSecret reports a label and a line, never the value; prose and placeholders are not hits', () => {
    expect(detectSuspectedSecret(`line1\nconst k = "${ANT}";\n`)).toEqual({ label: 'anthropic_key', line: 2 });
    expect(detectSuspectedSecret(`token: ${GH}`)).toEqual({ label: 'github_token', line: 1 });
    expect(detectSuspectedSecret(`\n\n${AWS}`)).toEqual({ label: 'aws_access_key', line: 3 });
    expect(detectSuspectedSecret('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\n')).toMatchObject({ label: 'private_key', line: 1 });
    for (const clean of ['export const apiKey = readFromVault();', 'Set ANTHROPIC_API_KEY in your shell.', 'const sk = "sk-"', '']) {
      expect(detectSuspectedSecret(clean)).toBeNull();
    }
    expect(JSON.stringify(detectSuspectedSecret(`x=${ANT}`))).not.toContain(ANT);
  });

  it('only the first SECRET_SCAN_MAX_CHARS characters are checked (bounded cost)', () => {
    expect(detectSuspectedSecret(`${' '.repeat(SECRET_SCAN_MAX_CHARS)}${ANT}`)).toBeNull();
  });

  it('the scan keeps a suspected secret in `included` with its label (not selected by default is the UI\'s job); detectSecrets:false turns it off', async () => {
    const dir = await tmp.make();
    const big = `${'// filler line\n'.repeat(1_000)}export const KEY = "${ANT}";\n`; // > the 8 KiB sniff window
    await writeTree(dir, { 'src/a.ts': 'export const a = 1;\n', 'src/config.ts': `export const key = '${GH}';\n`, 'src/big.ts': big });
    const root = await openRoot(dir);

    const on = await scanProject(root);
    const off = await scanProject(root, { detectSecrets: false });

    expect(on.ok && on.value.included.map((f) => [f.relPath, f.suspectedSecret ?? null])).toEqual([
      ['src/a.ts', null],
      ['src/big.ts', { label: 'anthropic_key', line: 1_001 }],
      ['src/config.ts', { label: 'github_token', line: 1 }],
    ]);
    expect(off.ok && off.value.included.every((f) => f.suspectedSecret === undefined)).toBe(true);
    // Round-3 M4: a flagged file carries the hash of its bytes (the confirmation binds to it); others do not pay for one.
    expect(on.ok && on.value.included.map((f) => [f.relPath, f.sha256 ?? null])).toEqual([
      ['src/a.ts', null], ['src/big.ts', sha(big)], ['src/config.ts', sha(`export const key = '${GH}';\n`)],
    ]);
  });

  it('intake (secretCheck) refuses an unacknowledged suspected secret with PERMISSION_DENIED suspected_secret, and reads it once acknowledged', async () => {
    const dir = await tmp.make();
    await writeTree(dir, { 'src/a.ts': 'export const a = 1;\n', 'src/config.ts': `export const key = '${GH}';\n` });
    const root = await openRoot(dir);

    const refused = await readSelected(root, ['src/a.ts', 'src/config.ts'], { secretCheck: { acknowledged: [] } });
    const acknowledged = await readSelected(root, ['src/a.ts', 'src/config.ts'], { secretCheck: { acknowledged: [{ relPath: 'src/config.ts', sha256: sha(`export const key = '${GH}';\n`) }] } });
    const staleAck = await readSelected(root, ['src/config.ts'], { secretCheck: { acknowledged: [{ relPath: 'src/config.ts', sha256: sha('export const key = 1;\n') }] } });
    const unchecked = await readSelected(root, ['src/config.ts']);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('PERMISSION_DENIED');
    expect(refused.error.details).toEqual({ reason: 'suspected_secret', relPath: 'src/config.ts',
      denied: [{ relPath: 'src/config.ts', reason: 'suspected_secret', secretLabel: 'github_token', secretLine: 1 }] });
    expect(JSON.stringify(refused.error)).not.toContain(GH);
    expect(acknowledged.ok && acknowledged.value.files.map((f) => f.relPath)).toEqual(['src/a.ts', 'src/config.ts']);
    expect(staleAck.ok || staleAck.error.details?.['reason']).toBe('suspected_secret'); // round-3 M4: hash mismatch
    expect(unchecked.ok).toBe(true);
  });

  it('mixed denials keep the generic `excluded` reason and list each file with its own reason', async () => {
    const dir = await tmp.make();
    await writeTree(dir, { 'src/config.ts': `export const key = '${GH}';\n`, '.env': 'A=1\n' });
    const root = await openRoot(dir);

    const r = await readSelected(root, ['src/config.ts', '.env'], { secretCheck: { acknowledged: [] } });

    expect(r.ok || r.error.details).toMatchObject({ reason: 'excluded', denied: [
      { relPath: 'src/config.ts', reason: 'suspected_secret' }, { relPath: '.env', reason: 'secret' },
    ] });
  });
});
