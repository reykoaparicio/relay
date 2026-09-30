import { z } from 'zod';
import type { AppError } from './errors.js';
import { appErrorSchema } from './errors.js';

/** Engine-internal result (services, repos, adapters). Uses `value`; never crosses a process boundary. */
export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Successful {@link Result}. */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
/** Failed {@link Result}. */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Boundary metadata (cursor pagination, 02 §B0). */
export interface IpcMeta {
  readonly nextCursor?: string | null;
}

/** Boundary result (IPC to the renderer, runner → main). Uses `data`; built only via {@link toIpc}. */
export type IpcEnvelope<T> =
  | { readonly ok: true; readonly data: T; readonly meta?: IpcMeta }
  | { readonly ok: false; readonly error: AppError };

/** Envelope schema (data unchecked here; per-channel output schemas validate `data`). */
export const ipcResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.unknown(),
    meta: z.object({ nextCursor: z.string().nullable().optional() }).optional(),
  }),
  z.object({ ok: z.literal(false), error: appErrorSchema }),
]);

/** Converts an engine {@link Result} (`value`) to a boundary {@link IpcEnvelope} (`data`). The only such conversion. */
export function toIpc<T>(r: Result<T>, meta?: IpcMeta): IpcEnvelope<T> {
  if (!r.ok) {
    return { ok: false, error: r.error };
  }
  return meta === undefined ? { ok: true, data: r.value } : { ok: true, data: r.value, meta };
}
