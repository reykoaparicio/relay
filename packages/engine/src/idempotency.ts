// 02 §B0 idempotent mutations, shared by every keyed handler: look the key up (a replay returns the stored ids, the
// same key with another request → CONFLICT `idempotency_key_reused`), and record the small result in the same tx as
// the mutation. Callers hash the request ONCE (`requestHash`) and pass the hash to both halves.
import { appError, err, errors, idSchema, invariant, ok } from '@relay/contracts';
import type { IdOf, IdPrefixKey, Result, Sha256 } from '@relay/contracts';
import type { IdempotentResult, Repos } from '@relay/storage';
import type { EngineCtx } from './ports.js';

/** One keyed request: the operation, the caller's idempotency key, and the request hash (computed once). */
export interface IdempotentRequest {
  readonly op: string;
  readonly key: string;
  readonly hash: Sha256;
}

/**
 * The stored result of `req`, or null when the key is new.
 * @returns CONFLICT `idempotency_key_reused` when the key was stored for a different request.
 */
export function storedResult(r: Repos, req: IdempotentRequest): Result<IdempotentResult> | null {
  const stored = r.idempotency.get(req.op, req.key);
  if (stored === undefined) return null;
  if (stored.requestHash !== req.hash) return err(errors.conflict({ reason: 'idempotency_key_reused', op: req.op }));
  return ok(stored.result);
}

/**
 * A stored result id (`name` names it in the error), validated as a `prefix` id. A missing or malformed stored id is
 * corruption (the engine only ever stores ids it minted), never caller input: INTERNAL with
 * `details.reason = 'idempotency_result_invalid'`.
 */
export function replayId<P extends IdPrefixKey>(ctx: Pick<EngineCtx, 'ids'>, value: unknown, prefix: P, name: string): Result<IdOf<P>> {
  const parsed = idSchema(prefix).safeParse(value);
  if (parsed.success) return ok(parsed.data);
  return err(appError('INTERNAL', { correlationId: ctx.ids.next('correlation'), details: { reason: 'idempotency_result_invalid', id: name } }));
}

/**
 * {@link storedResult} + {@link replayId} for the common one-id result: null for a new key, else the stored id (or
 * the CONFLICT / INTERNAL error) and the stored status.
 */
export function replayStoredId<P extends IdPrefixKey>(
  ctx: Pick<EngineCtx, 'ids'>,
  r: Repos,
  req: IdempotentRequest,
  name: string,
  prefix: P,
): Result<{ readonly id: IdOf<P>; readonly status: string | undefined }> | null {
  const stored = storedResult(r, req);
  if (stored === null) return null;
  if (!stored.ok) return stored;
  const id = replayId(ctx, stored.value.ids[name], prefix, name);
  return id.ok ? ok({ id: id.value, status: stored.value.status }) : id;
}

/**
 * Stores `result` for `req` inside the caller's tx (after a fresh {@link storedResult} lookup in that same tx, so the
 * put cannot conflict: the runner is the single writer).
 * @throws invariant when the put conflicts anyway — the tx rolls back rather than lose the record.
 */
export function recordResult(r: Repos, req: IdempotentRequest, result: IdempotentResult): void {
  invariant(r.idempotency.put(req.op, req.key, req.hash, result).ok, `idempotency put failed after a fresh lookup (${req.op})`);
}
