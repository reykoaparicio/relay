import type { Logger } from './types.js';

/** Logger that drops everything (default when none is injected). */
export const NOOP_LOGGER: Logger = Object.freeze({ warn: () => undefined });

/**
 * Invokes an engine hook so that it can never break a provider call (04 §D1, R4-27): a throw (or a rejected promise)
 * is logged as `{ hook, errorName }` at warn — never the arguments — and swallowed.
 */
export function safeHook(name: string, fn: (() => unknown) | undefined, logger: Logger): void {
  if (fn === undefined) return;
  const report = (err: unknown): void => {
    logger.warn('provider.hook_failed', { hook: name, errorName: err instanceof Error ? err.name : typeof err });
  };
  try {
    const out = fn();
    if (out instanceof Promise) out.catch(report);
  } catch (err) {
    report(err);
  }
}
