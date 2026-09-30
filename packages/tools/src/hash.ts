import { createHash } from 'node:crypto';
import type { Sha256 } from '@relay/contracts';

/** Lowercase hex SHA-256 of `bytes` (the digest format of contracts `sha256Schema`). */
export function sha256Hex(bytes: Uint8Array): Sha256 {
  return createHash('sha256').update(bytes).digest('hex');
}
