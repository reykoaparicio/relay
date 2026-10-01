import { mkdir, mkdtemp, readFile, readdir, rename as fsRename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdGen, epochMs } from '@relay/contracts';
import type { ProviderId } from '@relay/contracts';
import { createCredentialVault } from './credentials.js';
import type { SafeStorageLike } from './credentials.js';

vi.mock('electron', () => ({}));

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
const P: ProviderId = 'anthropic';
const enc = (s: string) => Buffer.from(`ENC:${Buffer.from(s).toString('base64')}`);
const dec = (b: Buffer) => Buffer.from(b.toString().slice(4), 'base64').toString();

function syncStorage(available = true): SafeStorageLike {
  return { isEncryptionAvailable: () => available, encryptString: enc, decryptString: dec };
}

describe('credential vault (H5)', () => {
  let dir = '';
  let refs: Map<ProviderId, string>;
  const ids = createIdGen({ now: () => epochMs(1_700_000_000_000) }, (n) => new Uint8Array(n).map(() => Math.floor(Math.random() * 256)));
  const make = (safeStorage: SafeStorageLike, platform: NodeJS.Platform = 'darwin', rename?: (from: string, to: string) => Promise<void>) =>
    createCredentialVault({
      safeStorage, userDataDir: dir, platform, ids, lookupVaultFile: (p) => Promise.resolve(refs.get(p) ?? null),
      ...(rename === undefined ? {} : { rename }),
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-vault-'));
    await mkdir(join(dir, 'secrets'));
    refs = new Map();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fails closed with SECURE_STORAGE_UNAVAILABLE when encryption is unavailable (never plaintext)', async () => {
    const v = make(syncStorage(false));

    const r = await v.save(P, KEY, 'os_protected');

    expect(!r.ok && r.error.code).toBe('SECURE_STORAGE_UNAVAILABLE');
    expect(!r.ok && r.error.nextAction).toBe('use_session_key');
    expect(await readdir(join(dir, 'secrets'))).toEqual([]);
  });

  it('treats the Linux basic_text backend as unavailable', async () => {
    const v = make({ ...syncStorage(true), getSelectedStorageBackend: () => 'basic_text' }, 'linux');

    expect(await v.status()).toEqual({ available: false, backend: 'basic_text', reason: 'basic_text' });
    expect((await v.save(P, KEY, 'os_protected')).ok).toBe(false);
  });

  it('keeps session keys in memory only', async () => {
    const v = make(syncStorage());

    const r = await v.save(P, KEY, 'session');

    expect(r.ok && r.value).toEqual({ storageMode: 'session', vaultFile: null, redactedLabel: 'sk-…6789' });
    expect(await readdir(join(dir, 'secrets'))).toEqual([]);
    expect(await v.get(P)).toEqual({ ok: true, value: KEY });
    expect(v.hasSession(P)).toBe(true);
  });

  it('writes an encrypted 0600 file (sync fallback when the async API is absent) and decrypts it; remove deletes it', async () => {
    const v = make(syncStorage());

    const r = await v.save(P, KEY, 'os_protected');

    expect(r.ok).toBe(true);
    if (!r.ok || r.value.vaultFile === null) return;
    const file = join(dir, r.value.vaultFile);
    expect(r.value.vaultFile).toMatch(/^secrets\/crd_[0-9A-Z]{26}\.bin$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file)).toString()).not.toContain(KEY);
    refs.set(P, r.value.vaultFile);
    expect(await v.get(P)).toEqual({ ok: true, value: KEY });
    await v.remove(P);
    expect(await readdir(join(dir, 'secrets'))).toEqual([]);
    expect((await v.get(P)).ok).toBe(false);
  });

  it('uses the async API when present and rewrites the file when shouldReEncrypt', async () => {
    let generation = 0;
    const storage: SafeStorageLike = {
      ...syncStorage(),
      encryptString: () => {
        throw new Error('sync path must not be used');
      },
      isAsyncEncryptionAvailable: () => Promise.resolve(true),
      encryptStringAsync: (s) => Promise.resolve(Buffer.concat([Buffer.from(`G${String(++generation)}`), enc(s)])),
      decryptStringAsync: (b) => Promise.resolve({ result: dec(b.subarray(2)), shouldReEncrypt: b.subarray(0, 2).toString() === 'G1' }),
    };
    const v = make(storage);
    const r = await v.save(P, KEY, 'os_protected');
    if (!r.ok || r.value.vaultFile === null) throw new Error('save failed');
    refs.set(P, r.value.vaultFile);

    expect(await v.get(P)).toEqual({ ok: true, value: KEY });

    expect((await readFile(join(dir, r.value.vaultFile))).subarray(0, 2).toString()).toBe('G2');
  });

  it('reports a temporarily unavailable keychain as retryable SECURE_STORAGE_UNAVAILABLE', async () => {
    const v = make({ ...syncStorage(), isTemporarilyUnavailable: () => true });

    const r = await v.save(P, KEY, 'os_protected');

    expect(!r.ok && r.error).toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE', retryable: true });
  });

  it('F3: a keychain that refuses to encrypt (denied/locked) → SECURE_STORAGE_UNAVAILABLE/use_session_key, nothing written', async () => {
    const denied = make({ ...syncStorage(), encryptString: () => { throw new Error('User interaction is not allowed.'); } });
    const deniedAsync = make({
      ...syncStorage(), isAsyncEncryptionAvailable: () => Promise.resolve(true),
      encryptStringAsync: () => Promise.reject(new Error('keychain locked')), decryptStringAsync: () => Promise.reject(new Error('x')),
    });

    for (const v of [denied, deniedAsync]) {
      const r = await v.save(P, KEY, 'os_protected');
      expect(!r.ok && r.error).toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE', nextAction: 'use_session_key' });
    }
    expect(await readdir(join(dir, 'secrets'))).toEqual([]);
  });

  it('F3: a failed vault write → SECURE_STORAGE_UNAVAILABLE (not INTERNAL), no plaintext and no temp file left', async () => {
    await rm(join(dir, 'secrets'), { recursive: true }); // the write itself fails (ENOENT)
    const noDir = await make(syncStorage()).save(P, KEY, 'os_protected');
    await mkdir(join(dir, 'secrets'));
    const noRename = await make(syncStorage(), 'darwin', () => Promise.reject(new Error('EIO'))).save(P, KEY, 'os_protected');

    expect(!noDir.ok && noDir.error.code).toBe('SECURE_STORAGE_UNAVAILABLE');
    expect(!noRename.ok && noRename.error).toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE', nextAction: 'use_session_key' });
    expect(await readdir(join(dir, 'secrets'))).toEqual([]);
  });

  it('F4: a crash between the temp write and the rename during re-encrypt leaves the old vault file intact', async () => {
    let crash = false;
    const storage: SafeStorageLike = {
      ...syncStorage(),
      isAsyncEncryptionAvailable: () => Promise.resolve(true),
      encryptStringAsync: (x) => Promise.resolve(Buffer.concat([Buffer.from(crash ? 'G2' : 'G1'), enc(x)])),
      decryptStringAsync: (b) => Promise.resolve({ result: dec(b.subarray(2)), shouldReEncrypt: true }),
    };
    const v = make(storage, 'darwin', (from, to) => (crash ? Promise.reject(new Error('process killed')) : fsRename(from, to)));
    const r = await v.save(P, KEY, 'os_protected');
    if (!r.ok || r.value.vaultFile === null) throw new Error('save failed');
    refs.set(P, r.value.vaultFile);
    const file = join(dir, r.value.vaultFile);
    const before = await readFile(file);
    crash = true;

    expect(await v.get(P)).toEqual({ ok: true, value: KEY }); // the re-encrypt failure never fails the read

    expect((await readFile(file)).equals(before)).toBe(true);
    expect(await readdir(join(dir, 'secrets'))).toEqual([r.value.vaultFile.slice('secrets/'.length)]);
  });

  it('F5: pruneUnreferenced deletes unreferenced vault files but never in-flight ones or foreign files', async () => {
    const v = make(syncStorage());
    const kept = await v.save(P, KEY, 'os_protected');
    const orphan = await v.save('openai', KEY, 'os_protected');
    const inFlight = await v.save('gemini', KEY, 'os_protected');
    if (!kept.ok || !orphan.ok || !inFlight.ok || kept.value.vaultFile === null) throw new Error('save failed');
    v.commit(P, kept.value);
    v.commit('openai', orphan.value);
    await writeFile(join(dir, 'secrets', 'README'), 'not a vault file');
    // Near misses of the credentialRef id pattern (contracts `idBodyPattern`): lowercase, a non-ULID letter, wrong prefix.
    const foreign = ['crd_01j0000000000000000000000a.bin', 'crd_01J000000000000000000000UA.bin', 'prf_01J0000000000000000000000A.bin'];
    for (const f of foreign) await writeFile(join(dir, 'secrets', f), 'foreign');

    await v.pruneUnreferenced(new Set([kept.value.vaultFile]));

    const left = (await readdir(join(dir, 'secrets'))).sort();
    expect(left).toEqual(['README', ...foreign, kept.value.vaultFile, inFlight.value.vaultFile].map((f) => f?.replace('secrets/', '') ?? '').sort());
  });

  it('answers AUTH_REQUIRED when nothing is stored', async () => {
    expect(await make(syncStorage()).get(P)).toMatchObject({ ok: false, error: { code: 'AUTH_REQUIRED' } });
  });
});
