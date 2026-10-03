import { describe, expect, it } from 'vitest';
import { DATABASE_UNAVAILABLE_MESSAGES, errors } from '@relay/contracts';
import type { RunnerFatal } from '@relay/contracts';
import { AppErrorException } from './client';
import { errorTitle, fatalOffersRestore, isDatabaseBusy, isProjectRootMissing, nextActionTarget, runnerFatalText } from './errors';
import { queryRetryDelay, shouldRetryQuery } from './query-client';

const fatal = (reason: string | null, code: RunnerFatal['code'] = 'DATABASE_UNAVAILABLE'): RunnerFatal =>
  ({ code, reason, message: 'Recorded message.', at: 1 }) as RunnerFatal;

describe('api/errors (R2)', () => {
  it('restart_runner is handled in place (app.restartRunner), not a navigation', () => {
    expect(nextActionTarget('restart_runner')).toEqual({ kind: 'handler', action: 'restart_runner' });
    expect(nextActionTarget('report_bug')).toEqual({ kind: 'navigate', to: '/settings/diagnostics' });
  });

  it('runner fatals in plain words: curated database messages, a crash loop sentence, else the recorded message', () => {
    expect(runnerFatalText(fatal('db_corrupt'))).toBe(DATABASE_UNAVAILABLE_MESSAGES.db_corrupt);
    expect(runnerFatalText(fatal('schema_too_new'))).toBe(DATABASE_UNAVAILABLE_MESSAGES.schema_too_new);
    expect(runnerFatalText(fatal('restart_limit', 'RUNNER_UNAVAILABLE'))).toMatch(/stopped several times in a row/);
    expect(runnerFatalText(fatal(null, 'INTERNAL'))).toBe('Recorded message.');
  });

  it('a restore is offered only for a damaged or newer database', () => {
    expect(['db_corrupt', 'integrity_check_failed', 'schema_too_new'].map((r) => fatalOffersRestore(fatal(r)))).toEqual([true, true, true]);
    expect(['disk_full', 'db_readonly', 'database_busy', 'restart_limit'].map((r) => fatalOffersRestore(fatal(r)))).toEqual([false, false, false, false]);
    expect(fatalOffersRestore(null)).toBe(false);
    expect(fatalOffersRestore(fatal(null))).toBe(false);
  });

  it('database_busy is recognised, worded plainly, and retried sooner and more often than other retryable errors', () => {
    const busy = new AppErrorException({ ...errors.databaseUnavailable('database_busy'), nextAction: 'wait' });
    const other = new AppErrorException(errors.databaseUnavailable('disk_full'));
    const rate = new AppErrorException(errors.rateLimited(null));
    expect(isDatabaseBusy(busy)).toBe(true);
    expect(isDatabaseBusy(other)).toBe(false);
    expect(errorTitle(busy.appError)).toBe('The database is in use by another program. Relay will retry.');
    expect(shouldRetryQuery(5, busy)).toBe(true);
    expect(shouldRetryQuery(6, busy)).toBe(false);
    expect(shouldRetryQuery(2, rate)).toBe(false);
    expect(shouldRetryQuery(0, other)).toBe(false);
    expect([0, 1, 2, 3, 4].map((n) => queryRetryDelay(n, busy))).toEqual([500, 1000, 2000, 4000, 4000]);
    expect(queryRetryDelay(1, rate)).toBe(2000);
  });

  it('PROJECT_ROOT_MISSING is recognised and titled "Project folder not found"', () => {
    const e = new AppErrorException(errors.projectRootMissing());
    expect(isProjectRootMissing(e)).toBe(true);
    expect(errorTitle(e.appError)).toBe('Project folder not found');
  });
});
