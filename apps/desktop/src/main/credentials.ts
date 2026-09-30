// 08 H5: the credentials vault (§3.3, §18.2, RLY-007). Keys live only in main: OS-protected files (safeStorage) or a
// session Map. Never logged, never in process.env, never sent to the renderer or the runner's env.
//
// Electron 44 safeStorage API (verified against node_modules/electron/electron.d.ts, 44.5.1): `encryptStringAsync
// (string) → Promise<Buffer>`, `decryptStringAsync(Buffer) → Promise<{ result, shouldReEncrypt }>`,
// `isAsyncEncryptionAvailable() → Promise<boolean>`; sync `encryptString`/`decryptString`/`isEncryptionAvailable`;
// `getSelectedStorageBackend()` (Linux). `isTemporarilyUnavailable` does NOT exist in 44's typings, so it is
// feature-detected like the async variants; when absent there is no temporary-unavailability signal.
import { readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { err, errors, ok, redactedLabel, vaultFileSchema } from '@relay/contracts';
import type { AppError, CredentialStorageMode, IdGen, ProviderId, Result } from '@relay/contracts';

/** Electron `safeStorage`, with the async variants optional (feature-detected). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?: () => string;
  isAsyncEncryptionAvailable?: () => Promise<boolean>;
  encryptStringAsync?: (plainText: string) => Promise<Buffer>;
  decryptStringAsync?: (encrypted: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>;
  isTemporarilyUnavailable?: () => boolean;
}

/** Secure-storage availability. */
export interface VaultStatus {
  readonly available: boolean;
  readonly backend: string;
  readonly reason?: 'basic_text' | 'unavailable';
}

/** What `save` persisted (the runner records it as a `provider_credential_refs` row). */
export interface SavedCredential {
  readonly storageMode: CredentialStorageMode;
  /** `secrets/crd_<ULID>.bin`, relative to userData; null for session keys. */
  readonly vaultFile: string | null;
  readonly redactedLabel: string;
}

/** The vault (08 H5). */
export interface CredentialVault {
  status(): Promise<VaultStatus>;
  save(providerId: ProviderId, apiKey: string, mode: CredentialStorageMode): Promise<Result<SavedCredential>>;
  /** Used only to answer the runner's `credential.request`. */
  get(providerId: ProviderId): Promise<Result<string>>;
  remove(providerId: ProviderId): Promise<void>;
  /** True when a session-only key is held in memory for `providerId`. */
  hasSession(providerId: ProviderId): boolean;
  sessionLabel(providerId: ProviderId): string | null;
  /** Deletes a vault file by its relative path (validated). */
  deleteVaultFile(vaultFile: string): Promise<void>;
  /** Rolls back one `save` (the runner failed to record its ref): deletes that file or that session entry. */
  discard(providerId: ProviderId, saved: SavedCredential): Promise<void>;
}

/** Dependencies of {@link createCredentialVault}. */
export interface VaultDeps {
  readonly safeStorage: SafeStorageLike;
  readonly userDataDir: string;
  readonly platform: NodeJS.Platform;
  readonly ids: IdGen;
  /** The provider's OS-protected vault file from the runner's credential refs (DB is the source of truth). */
  readonly lookupVaultFile: (providerId: ProviderId) => Promise<string | null>;
}

const SECRET_FILE_MODE = 0o600;

function temporarilyUnavailable(): AppError {
  return { ...errors.secureStorageUnavailable(), retryable: true };
}

function backendName(s: SafeStorageLike, platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'keychain';
  if (platform === 'win32') return 'dpapi';
  return s.getSelectedStorageBackend?.() ?? 'unknown';
}

/** Creates the vault. */
export function createCredentialVault(deps: VaultDeps): CredentialVault {
  const s = deps.safeStorage;
  const session = new Map<ProviderId, string>();
  const hasAsync = typeof s.encryptStringAsync === 'function' && typeof s.decryptStringAsync === 'function';

  const encrypt = async (plain: string): Promise<Buffer> =>
    hasAsync && s.encryptStringAsync !== undefined ? s.encryptStringAsync(plain) : s.encryptString(plain);
  const decrypt = async (buf: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> =>
    hasAsync && s.decryptStringAsync !== undefined ? s.decryptStringAsync(buf) : { result: s.decryptString(buf), shouldReEncrypt: false };

  const status = async (): Promise<VaultStatus> => {
    const backend = backendName(s, deps.platform);
    // basic_text uses a hard-coded password: treated as unavailable (no silent downgrade, 08 H5).
    if (deps.platform === 'linux' && backend === 'basic_text') return { available: false, backend, reason: 'basic_text' };
    const available =
      hasAsync && typeof s.isAsyncEncryptionAvailable === 'function' ? await s.isAsyncEncryptionAvailable() : s.isEncryptionAvailable();
    return available ? { available, backend } : { available, backend, reason: 'unavailable' };
  };

  const absVault = (vaultFile: string): string | null => {
    const parsed = vaultFileSchema.safeParse(vaultFile);
    return parsed.success ? join(deps.userDataDir, ...parsed.data.split('/')) : null;
  };

  const writeSecret = async (file: string, apiKey: string): Promise<void> => {
    await writeFile(file, await encrypt(apiKey), { mode: SECRET_FILE_MODE, flag: 'w' });
    await chmod(file, SECRET_FILE_MODE);
  };

  const saveProtected = async (apiKey: string): Promise<Result<SavedCredential>> => {
    const st = await status();
    if (!st.available) return err(errors.secureStorageUnavailable());
    if (s.isTemporarilyUnavailable?.() === true) return err(temporarilyUnavailable());
    const vaultFile = `secrets/${deps.ids.next('credentialRef')}.bin`;
    const file = absVault(vaultFile);
    if (file === null) return err(errors.secureStorageUnavailable());
    await writeSecret(file, apiKey);
    return ok({ storageMode: 'os_protected', vaultFile, redactedLabel: redactedLabel(apiKey) });
  };

  const readProtected = async (providerId: ProviderId): Promise<Result<string>> => {
    const vaultFile = await deps.lookupVaultFile(providerId);
    const file = vaultFile === null ? null : absVault(vaultFile);
    if (file === null) return err(errors.authRequired(providerId));
    let buf: Buffer;
    try {
      buf = await readFile(file);
    } catch {
      return err(errors.authRequired(providerId));
    }
    if (!(await status()).available) return err(errors.secureStorageUnavailable());
    if (s.isTemporarilyUnavailable?.() === true) return err(temporarilyUnavailable());
    const { result, shouldReEncrypt } = await decrypt(buf);
    if (shouldReEncrypt) await writeSecret(file, result);
    return ok(result);
  };

  const deleteVaultFile = async (vaultFile: string): Promise<void> => {
    const file = absVault(vaultFile);
    if (file !== null) await rm(file, { force: true });
  };

  return {
    status,
    deleteVaultFile,
    async save(providerId, apiKey, mode) {
      const key = apiKey.trim();
      if (mode === 'session') {
        session.set(providerId, key);
        return ok({ storageMode: 'session', vaultFile: null, redactedLabel: redactedLabel(key) });
      }
      const saved = await saveProtected(key);
      if (saved.ok) session.delete(providerId);
      return saved;
    },
    async get(providerId) {
      const held = session.get(providerId);
      return held !== undefined ? ok(held) : readProtected(providerId);
    },
    async remove(providerId) {
      session.delete(providerId);
      const vaultFile = await deps.lookupVaultFile(providerId).catch(() => null);
      if (vaultFile !== null) await deleteVaultFile(vaultFile);
    },
    async discard(providerId, saved) {
      if (saved.vaultFile !== null) await deleteVaultFile(saved.vaultFile);
      else session.delete(providerId);
    },
    hasSession: (providerId) => session.has(providerId),
    sessionLabel(providerId) {
      const held = session.get(providerId);
      return held === undefined ? null : redactedLabel(held);
    },
  };
}
