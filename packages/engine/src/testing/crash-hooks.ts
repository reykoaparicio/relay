// 06 F13 crash-hook grammar (R4-11 / R2-23): RELAY_CRASH_AT=<hook>@<stepKey>[#<n>], e.g. afterStepCommit@plan,
// afterDispatchIntent@review#2. Inert unless RELAY_E2E=1 (H7 and K4's child both gate on it). This is the ONLY
// symbol of src/testing/** re-exported by the engine barrel.
import { RelayError, err, errors, ok, stepKeySchema } from '@relay/contracts';
import type { Result, StepKey } from '@relay/contracts';
import type { CrashHookCtx, EngineTestHooks } from '../ports.js';

/** The five crash points (06 F13 table). */
export const CRASH_HOOK_NAMES = ['beforeReservationTx', 'afterDispatchIntent', 'afterProviderResponse', 'afterStepCommit', 'afterApprovalCommit'] as const;
/** A crash point. */
export type CrashHookName = (typeof CRASH_HOOK_NAMES)[number];

/** A parsed crash spec: crash at the n-th invocation (n ≥ 1) of `hook` whose ctx.stepKey is `stepKey`. */
export interface CrashSpec {
  readonly hook: CrashHookName;
  readonly stepKey: StepKey;
  readonly n: number;
}

/** Exit code of a simulated crash (SIGKILL-like). */
export const CRASH_EXIT_CODE = 137;

const GRAMMAR = /^([A-Za-z]+)@([^#]+)(?:#(\d+))?$/;

function invalid(message: string): Result<CrashSpec> {
  return err(errors.validationFailed([{ path: 'RELAY_CRASH_AT', message, code: 'invalid_crash_spec' }]));
}

/** Parses `<hook>@<stepKey>[#<n>]`; VALIDATION_FAILED on bad input. */
export function parseCrashSpec(value: string): Result<CrashSpec> {
  const m = GRAMMAR.exec(value.trim());
  if (m === null) return invalid('Expected <hook>@<stepKey>[#<n>].');
  const [, hook = '', rawKey = '', rawN] = m;
  if (!(CRASH_HOOK_NAMES as readonly string[]).includes(hook)) return invalid(`Unknown hook "${hook}".`);
  const key = stepKeySchema.safeParse(rawKey);
  if (!key.success) return invalid(`Invalid step key "${rawKey}".`);
  const n = rawN === undefined ? 1 : Number(rawN);
  if (!Number.isSafeInteger(n) || n < 1) return invalid('n must be an integer ≥ 1.');
  return ok({ hook: hook as CrashHookName, stepKey: key.data, n });
}

/**
 * Builds hooks that call `exit(137)` on the n-th invocation of the named hook for the step key.
 * @throws RelayError VALIDATION_FAILED when `value` is not a valid crash spec.
 */
export function parseCrashAt(value: string, o: { readonly exit?: (code: number) => never } = {}): EngineTestHooks {
  const spec = parseCrashSpec(value);
  if (!spec.ok) throw new RelayError(spec.error);
  const exit = o.exit ?? ((code: number): never => process.exit(code));
  let seen = 0;
  const hook = (c: CrashHookCtx): void => {
    if (c.stepKey !== spec.value.stepKey) return;
    seen += 1;
    if (seen === spec.value.n) exit(CRASH_EXIT_CODE);
  };
  return { [spec.value.hook]: hook };
}

/** Hooks from the environment: `undefined` unless RELAY_E2E=1 and RELAY_CRASH_AT is set. */
export function crashHooksFromEnv(env: NodeJS.ProcessEnv, o: { readonly exit?: (code: number) => never } = {}): EngineTestHooks | undefined {
  const value = env['RELAY_CRASH_AT'];
  if (env['RELAY_E2E'] !== '1' || value === undefined || value === '') return undefined;
  return parseCrashAt(value, o);
}
