import { z } from 'zod';
import { PAGE_LIMITS } from '../defaults.js';
import { cursorSchema } from '../primitives.js';
import type { ErrorCode } from '../status.js';

/** IPC channel string: `relay/v1/<resource>.<verb>` (00b §2.3). */
export type ChannelString = `relay/v1/${string}`;
/** Queries are side-effect-free and safe to retry; commands change state. */
export type OpKind = 'query' | 'command';
/** Where the handler lives (`main+runner` = composite in main, 08 H4). */
export type OpRoute = 'main' | 'runner' | 'main+runner';

/** Token bucket (02 §B6). */
export interface RateLimit {
  readonly capacity: number;
  readonly refillPerSec: number;
}

/** One typed IPC operation (02 §B5). */
export interface OperationDef<
  C extends ChannelString = ChannelString,
  K extends OpKind = OpKind,
  R extends OpRoute = OpRoute,
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> {
  readonly channel: C;
  readonly kind: K;
  readonly route: R;
  readonly input: I;
  readonly output: O;
  /** Documented error codes (besides {@link UNIVERSAL_ERROR_CODES}); enforced in dev by the router. */
  readonly errors: readonly ErrorCode[];
  /** True when the op requires an `idempotencyKey` (commands only). */
  readonly idempotent: boolean;
  readonly rateLimit?: RateLimit;
}

/** Any operation definition. */
export type AnyOperationDef = OperationDef;

/** Declares an operation, preserving the literal channel, kind, and route types. */
export function op<
  const C extends ChannelString,
  const K extends OpKind,
  const R extends OpRoute,
  I extends z.ZodType,
  O extends z.ZodType,
>(d: OperationDef<C, K, R, I, O>): OperationDef<C, K, R, I, O> {
  return Object.freeze(d);
}

/**
 * Error codes any op may return without listing them: bad input (router validation), rate limiting, runner loss,
 * a refused sender (`PERMISSION_DENIED untrusted_sender`, router), an unusable database, a missing project folder,
 * and internal errors.
 */
export const UNIVERSAL_ERROR_CODES = [
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'RUNNER_UNAVAILABLE',
  'PERMISSION_DENIED',
  'DATABASE_UNAVAILABLE', // any op can hit a full disk / read-only / damaged database (E2 #3)
  'PROJECT_ROOT_MISSING', // any op that touches project files can find the folder gone (E2 #7)
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

/** Empty input object. */
export const emptyInputSchema = z.object({});

/** Cursor page request (02 §B0: `limit ≤ 100`, opaque cursor). */
export const pageRequestShape = {
  limit: z.number().int().min(1).max(PAGE_LIMITS.maxLimit).default(PAGE_LIMITS.defaultLimit),
  cursor: cursorSchema.optional(),
};

/** Cursor page response `{ items, nextCursor }`. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

/** `{ exported, displayPath? }` result of a composite export with a save dialog (`exported: false` = cancelled). */
export const exportResultSchema = z.object({ exported: z.boolean(), displayPath: z.string().optional() });
