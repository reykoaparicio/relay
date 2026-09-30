import { z } from 'zod';
import { idSchema } from '../ids.js';
import { epochMsSchema } from '../primitives.js';
import { credentialStorageModeSchema, errorCodeSchema, providerIdSchema } from '../status.js';

/** Maximum length of a redacted key label ("sk-…a1F9"). */
export const REDACTED_LABEL_MAX = 40;

/** Vault file of an OS-protected key, relative to userData (never the key itself; §12.2). */
export const vaultFileSchema = z.string().regex(/^secrets\/crd_[0-9A-HJKMNP-TV-Z]{26}\.bin$/, 'must be secrets/crd_<ULID>.bin');

/** §12.2 ProviderCredentialRef: metadata only; the raw credential is never here. */
export const credentialRefSchema = z.object({
  id: idSchema('credentialRef'),
  providerId: providerIdSchema,
  storageMode: credentialStorageModeSchema,
  vaultFile: vaultFileSchema.nullable(),
  redactedLabel: z.string().max(REDACTED_LABEL_MAX),
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
});
/** Credential reference. */
export type CredentialRef = z.infer<typeof credentialRefSchema>;

/** Provider connection state shown in Settings → Providers (FR-02: redacted only). */
export const providerStatusSchema = z.object({
  providerId: providerIdSchema,
  displayName: z.string(),
  connected: z.boolean(),
  storage: z.enum(['os_protected', 'session', 'none']),
  redactedLabel: z.string().max(REDACTED_LABEL_MAX).nullable(),
  lastTest: z.object({ at: epochMsSchema, ok: z.boolean(), code: errorCodeSchema.optional() }).nullable(),
});
/** Provider status. */
export type ProviderStatus = z.infer<typeof providerStatusSchema>;
