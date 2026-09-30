// Deterministic hashing helpers (request fingerprints, idempotency request hashes, workflow content hashes).
import { createHash } from 'node:crypto';
import type { Sha256 } from '@relay/contracts';

/** Lowercase hex SHA-256 of a string (UTF-8) or bytes. */
export function sha256Hex(data: string | Uint8Array): Sha256 {
  return createHash('sha256').update(data).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** JSON with object keys sorted recursively and `undefined` members dropped: same value → same bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** UTF-8 bytes of `s`. */
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Decodes UTF-8 bytes (lenient). */
export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** Idempotency request hash (02 §B0): the canonical input without its `idempotencyKey`. */
export function requestHash(input: Readonly<Record<string, unknown>>): Sha256 {
  return sha256Hex(canonicalJson({ ...input, idempotencyKey: undefined }));
}
