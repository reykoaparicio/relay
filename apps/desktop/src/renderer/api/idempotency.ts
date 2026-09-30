import { createIdGen, systemClock } from '@relay/contracts';

// One ULID generator per renderer (02 §B0: the renderer sends ULID idempotency keys).
const idGen = createIdGen(systemClock, (n) => crypto.getRandomValues(new Uint8Array(n)));

/** A fresh idempotency key: a bare 26-char ULID (valid for contracts `idempotencyKeySchema`). */
export function newIdempotencyKey(): string {
  const id: string = idGen.next('correlation');
  return id.slice(id.indexOf('_') + 1);
}
