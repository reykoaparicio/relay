import { z } from 'zod';
import type { Brand } from './brand.js';
import type { EpochMs } from './time.js';

/** Zod schema for {@link EpochMs}: a non-negative integer. */
export const epochMsSchema = z
  .number()
  .int()
  .nonnegative()
  .transform((n) => n as EpochMs);

/** Lowercase hex SHA-256 digest (64 chars). */
export type Sha256 = string;
/** Zod schema for a lowercase hex SHA-256 digest. */
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase hex sha256');

/** Project-relative POSIX path. Syntactic only: confinement (realpath, symlinks, exclusions) is enforced by 05 E1. */
export type RelPath = Brand<string, 'RelPath'>;
/** Maximum length of a {@link RelPath}. */
export const REL_PATH_MAX = 512;
/** Zod schema for {@link RelPath}. */
export const relPathSchema = z
  .string()
  .min(1)
  .max(REL_PATH_MAX)
  .refine((s) => !s.startsWith('/'), 'must be relative (no leading /)')
  .refine((s) => !s.includes('\0'), 'must not contain NUL')
  .refine((s) => !s.includes('\\'), 'POSIX separators only')
  .refine((s) => s.split('/').every((seg) => seg !== '..'), 'must not contain a .. segment')
  .transform((s) => s as RelPath);

/** Workflow step key: 'review', 'plan', 'intake', 'finalize', … (spec §12.4 step `id`). */
export type StepKey = Brand<string, 'StepKey'>;
/** Zod schema for {@link StepKey}. */
export const stepKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/, 'lowercase, starts with a letter, ≤ 32 chars')
  .transform((s) => s as StepKey);

/** Calendar month `YYYY-MM` (ledger project summaries and exports). */
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM');

/** Idempotency key sent with non-idempotent commands (02 §B0; the renderer uses a ULID). */
export const idempotencyKeySchema = z.string().min(10).max(64);

/** Opaque pagination cursor (base64url of `(created_at, id)`, 02 §B0). */
export const cursorSchema = z.string().min(1).max(512);
