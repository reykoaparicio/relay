import { describe, expect, it, vi } from 'vitest';
import { isRelayError } from '@relay/contracts';
import type { StepKey } from '@relay/contracts';
import { CRASH_EXIT_CODE, crashHooksFromEnv, parseCrashAt, parseCrashSpec } from './crash-hooks.js';

const at = (stepKey: string) => ({ stepKey: stepKey as StepKey, purpose: null, attemptSeq: 1 });

describe('crash-hook grammar', () => {
  it('parses <hook>@<stepKey> with n defaulting to 1, and #n', () => {
    expect(parseCrashSpec('afterStepCommit@plan')).toEqual({ ok: true, value: { hook: 'afterStepCommit', stepKey: 'plan', n: 1 } });
    expect(parseCrashSpec('afterDispatchIntent@review#2')).toEqual({ ok: true, value: { hook: 'afterDispatchIntent', stepKey: 'review', n: 2 } });
  });

  it.each(['nope@plan', 'afterStepCommit@Plan!', 'afterStepCommit@plan#0', 'afterStepCommit', '', 'afterStepCommit@plan#x'])('rejects %j', (bad) => {
    const r = parseCrashSpec(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
  });

  it('calls exit(137) on the n-th matching invocation only', () => {
    const exit = vi.fn();
    const hooks = parseCrashAt('afterDispatchIntent@review#2', { exit: exit as unknown as (c: number) => never });

    hooks.afterDispatchIntent?.(at('plan'));
    hooks.afterDispatchIntent?.(at('review'));
    expect(exit).not.toHaveBeenCalled();
    hooks.afterDispatchIntent?.(at('review'));
    hooks.afterDispatchIntent?.(at('review'));

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(CRASH_EXIT_CODE);
    expect(Object.keys(hooks)).toEqual(['afterDispatchIntent']);
  });

  it('parseCrashAt throws a RelayError on bad input', () => {
    let thrown: unknown;
    try {
      parseCrashAt('bogus');
    } catch (e) {
      thrown = e;
    }
    expect(isRelayError(thrown)).toBe(true);
  });

  it('crashHooksFromEnv is inert without RELAY_E2E=1', () => {
    const exit = (() => undefined) as unknown as (c: number) => never;
    expect(crashHooksFromEnv({ RELAY_CRASH_AT: 'afterStepCommit@plan' }, { exit })).toBeUndefined();
    expect(crashHooksFromEnv({ RELAY_E2E: '1' }, { exit })).toBeUndefined();
    expect(Object.keys(crashHooksFromEnv({ RELAY_E2E: '1', RELAY_CRASH_AT: 'afterStepCommit@plan' }, { exit }) ?? {})).toEqual(['afterStepCommit']);
  });
});
