import { epochMs } from '@relay/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultIsPidAlive } from '../pid.js';
import type { FixtureDb } from '../testing/fixtures.js';
import { openFixtureDb } from '../testing/fixtures.js';

const STALE = 10_000;

describe('LeaseRepo', () => {
  let f: FixtureDb | undefined;
  afterEach(async () => {
    await f?.db.dispose();
  });

  const open = async (alive: boolean) => {
    f = await openFixtureDb({ isPidAlive: () => alive });
    return f.db.repos.lease;
  };

  it('acquires with no row and re-acquires for the same owner', async () => {
    const lease = await open(true);

    expect(lease.acquire('a', 1, epochMs(1000), STALE)).toBe('acquired');
    expect(lease.acquire('a', 1, epochMs(1001), STALE)).toBe('acquired');
  });

  it('is held_by_other with a fresh heartbeat and a live pid', async () => {
    const lease = await open(true);
    lease.acquire('a', 1, epochMs(1000), STALE);

    expect(lease.acquire('b', 2, epochMs(2000), STALE)).toBe('held_by_other');
  });

  it('acquires with a fresh heartbeat and a dead pid', async () => {
    const lease = await open(false);
    lease.acquire('a', 1, epochMs(1000), STALE);

    expect(lease.acquire('b', 2, epochMs(1001), STALE)).toBe('acquired');
  });

  it('acquires with a stale heartbeat even when the pid is alive', async () => {
    const lease = await open(true);
    lease.acquire('a', 1, epochMs(1000), STALE);

    expect(lease.acquire('b', 2, epochMs(1000 + STALE + 1), STALE)).toBe('acquired');
  });

  it('ignores a heartbeat and release by a non-owner', async () => {
    const lease = await open(true);
    lease.acquire('a', 1, epochMs(1000), STALE);

    const foreignBeat = lease.heartbeat('b', epochMs(50_000));
    const foreignRelease = lease.release('b');
    const held = lease.acquire('b', 2, epochMs(1000 + STALE), STALE);
    const ownBeat = lease.heartbeat('a', epochMs(20_000));

    expect(foreignBeat).toBe(false);
    expect(foreignRelease).toBe(false);
    expect(held).toBe('held_by_other');
    expect(ownBeat).toBe(true);
    expect(lease.release('a')).toBe(true);
    expect(lease.acquire('b', 2, epochMs(20_001), STALE)).toBe('acquired');
  });

  it('runs inside an already-open transaction without nesting', async () => {
    const lease = await open(true);
    const db = f?.db;

    const r = db?.tx('immediate', (repos) => repos.lease.acquire('a', 1, epochMs(1), STALE));

    expect(r).toBe('acquired');
    expect(lease.acquire('z', 9, epochMs(2), STALE)).toBe('held_by_other');
  });

  it('defaultIsPidAlive treats EPERM as alive and ESRCH as dead', () => {
    const throwing = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };

    expect(defaultIsPidAlive(1, () => true)).toBe(true);
    expect(defaultIsPidAlive(1, throwing('EPERM'))).toBe(true);
    expect(defaultIsPidAlive(1, throwing('ESRCH'))).toBe(false);
    expect(defaultIsPidAlive(1, throwing('EINVAL'))).toBe(true);
    expect(defaultIsPidAlive(process.pid)).toBe(true);
  });
});
