import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FixtureDb } from '../testing/fixtures.js';
import { CAPABILITIES, newId, openFixtureDb } from '../testing/fixtures.js';
import type { ProfileUpsert } from '../types.js';

describe('ProfileRepo', () => {
  let f: FixtureDb;

  beforeEach(async () => {
    f = await openFixtureDb();
  });
  afterEach(async () => {
    await f.db.dispose();
  });

  const profile = (o: Partial<ProfileUpsert> = {}): ProfileUpsert => ({
    id: newId('profile'),
    name: 'Economy',
    providerId: 'anthropic',
    modelId: 'claude-haiku-4-5',
    params: { maxOutputTokens: 8000, refusalFallback: 'off' },
    capabilitiesSnapshot: { ...CAPABILITIES, effortLevels: [] },
    catalogVersion: '2026-09-25',
    ...o,
  });

  it('persists the capability snapshot and catalog version, and bumps revision on update', () => {
    const p = profile();

    const created = f.db.repos.profiles.upsert(p);
    const updated = f.db.repos.profiles.upsert({ ...p, catalogVersion: '2026-10-01', capabilitiesSnapshot: { ...CAPABILITIES, effortLevels: ['low'] } }, 1);

    expect(created.ok && created.value.revision).toBe(1);
    expect(updated.ok && updated.value.revision).toBe(2);
    expect(updated.ok && updated.value.catalogVersion).toBe('2026-10-01');
    expect(updated.ok && updated.value.capabilitiesSnapshot.effortLevels).toEqual(['low']);
    expect(f.db.repos.profiles.getByName('Economy')?.id).toBe(p.id);
  });

  it('returns CONFLICT for a stale expectedRevision and NOT_FOUND for a missing profile', () => {
    const p = profile();
    f.db.repos.profiles.upsert(p);
    f.db.repos.profiles.upsert(p, 1);

    const stale = f.db.repos.profiles.upsert(p, 1);
    const missing = f.db.repos.profiles.upsert(profile({ name: 'Other' }), 3);

    expect(!stale.ok && stale.error.code).toBe('CONFLICT');
    expect(!missing.ok && missing.error.code).toBe('NOT_FOUND');
  });

  it('maps a duplicate name to CONFLICT, lists by name, and deletes', () => {
    const a = profile({ name: 'Balanced' });
    f.db.repos.profiles.upsert(a);
    f.db.repos.profiles.upsert(profile({ name: 'Capable' }));

    const dup = f.db.repos.profiles.upsert(profile({ name: 'Balanced' }));

    expect(!dup.ok && dup.error.code).toBe('CONFLICT');
    expect(f.db.repos.profiles.list().map((x) => x.name)).toEqual(['Balanced', 'Capable']);
    expect(f.db.repos.profiles.delete(a.id)).toBe(true);
    expect(f.db.repos.profiles.get(a.id)).toBeUndefined();
    expect(f.db.repos.profiles.getByName('nope')).toBeUndefined();
  });
});
