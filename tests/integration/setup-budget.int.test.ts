// 11 §K5 / §17.1 "Setup call over allowance" (@m4, F18): providers.test is admitted against the setup allowance over
// this month's scope='setup' entries; blocked → BUDGET_BLOCKED and testConnection is never called; under the allowance
// → reserve + settle with attempt_id NULL.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETUP_ALLOWANCE_MICROUSD } from '@relay/contracts';
import { createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { queryAll } from '../helpers/sqlite-inspect.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

const setupRows = (x: Harness) => queryAll(x.dbPath, "SELECT type, bucket, delta_microusd AS delta, attempt_id AS attemptId, run_id AS runId FROM ledger_entries WHERE scope = 'setup' ORDER BY rowid");

describe('setup budget @m4', () => {
  it('under the allowance: reserve + settle with attempt_id NULL, testConnection called once @m4', async () => {
    h = await createHarness();
    const spy = vi.spyOn(h.providers.get('anthropic'), 'testConnection');

    const res = await h.call('relay/v1/providers.test', { providerId: 'anthropic' });

    expect(res.ok && res.data.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const rows = setupRows(h);
    expect(rows.map((r) => r['type'])).toEqual(['reserve', 'release', 'settle']);
    expect(rows.every((r) => r['attemptId'] === null && r['runId'] === null)).toBe(true);
  });

  it('allowance exhausted by prior setup entries → BUDGET_BLOCKED and testConnection is NOT called @m4', async () => {
    h = await createHarness();
    const x = h;
    x.db.tx('immediate', (r) => r.ledger.append([
      { scope: 'setup', type: 'reserve', bucket: 'reserved', deltaMicrousd: SETUP_ALLOWANCE_MICROUSD },
    ]));
    x.db.tx('immediate', (r) => r.ledger.append([
      { scope: 'setup', type: 'release', bucket: 'reserved', deltaMicrousd: -SETUP_ALLOWANCE_MICROUSD },
      { scope: 'setup', type: 'settle', bucket: 'settled', deltaMicrousd: SETUP_ALLOWANCE_MICROUSD, certainty: 'calculated' },
    ]));
    const spy = vi.spyOn(x.providers.get('anthropic'), 'testConnection');
    const before = setupRows(x).length;

    const res = await x.call('relay/v1/providers.test', { providerId: 'anthropic' });

    expect(res.ok ? null : res.error.code).toBe('BUDGET_BLOCKED');
    expect(res.ok ? null : res.error.details).toEqual(expect.objectContaining({ scope: 'setup', allowed: false, C: SETUP_ALLOWANCE_MICROUSD, L: SETUP_ALLOWANCE_MICROUSD }));
    expect(spy).not.toHaveBeenCalled();
    expect(x.calls()).toHaveLength(0);
    expect(setupRows(x)).toHaveLength(before); // nothing reserved
  });
});
