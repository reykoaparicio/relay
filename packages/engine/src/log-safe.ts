// B6: every error or message the engine logs goes through contracts redaction (§11.4 "no secrets in logs").
import { redactDeep, redactString } from '@relay/contracts';
import type { Logger } from './ports.js';

/**
 * A log-safe rendering of `err`: its message (or string form), secret-looking substrings redacted, and every exact
 * occurrence of a `known` secret (e.g. the resolved API key, whatever its shape) replaced.
 */
export function logSafe(err: unknown, known: readonly string[] = []): string {
  let text = err instanceof Error ? err.message : String(err);
  for (const secret of known) if (secret.length > 0) text = text.split(secret).join('[REDACTED]');
  return redactString(text);
}

/** Wraps a logger so every event name and field passes through `redactDeep` (defense in depth over {@link logSafe}). */
export function redactingLogger(inner: Logger): Logger {
  const wrap = (f: Logger['info']): Logger['info'] => (event, fields) => {
    if (fields === undefined) f(redactString(event));
    else f(redactString(event), redactDeep({ ...fields }));
  };
  return { debug: wrap(inner.debug.bind(inner)), info: wrap(inner.info.bind(inner)), warn: wrap(inner.warn.bind(inner)), error: wrap(inner.error.bind(inner)) };
}
