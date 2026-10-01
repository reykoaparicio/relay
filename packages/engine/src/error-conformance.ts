// 02 §B5 error-code conformance: every error a runner handler returns must be declared by its operation (`op.errors`)
// or be universal (`UNIVERSAL_ERROR_CODES`). The engine logs a violation; the test harness throws on one.
import { UNIVERSAL_ERROR_CODES, getRunnerOperation } from '@relay/contracts';
import type { ErrorCode, IpcEnvelope } from '@relay/contracts';

/**
 * The code of `result` when it is an error that `channel`'s operation does not declare, else null (success, a declared
 * or universal code, or an unknown channel — which `handle` itself answers with the universal VALIDATION_FAILED).
 */
export function undeclaredErrorCode(channel: string, result: IpcEnvelope<unknown>): ErrorCode | null {
  if (result.ok) return null;
  const def = getRunnerOperation(channel);
  if (def === undefined) return null;
  const code = result.error.code;
  return def.errors.includes(code) || (UNIVERSAL_ERROR_CODES as readonly ErrorCode[]).includes(code) ? null : code;
}
