import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createIdGen } from '@relay/contracts';
import { loadCatalogEntries } from '@relay/providers';
import { openTestDb } from '@relay/storage';
import type { TestDb } from '@relay/storage';
import { createTemplateRegistry } from '@relay/templates';
import { DEFAULT_PROFILES, seedDatabase } from './seed.js';
import { createManualClock } from './testing/manual-timers.js';

let db: TestDb | undefined;
afterEach(async () => {
  await db?.dispose();
  db = undefined;
});

describe('seedDatabase', () => {
  it('seeds the catalog, template v1 (validated, prompts resolvable), and 4 default profiles (incl. Balanced · OpenAI) with capability snapshots', async () => {
    const clock = createManualClock();
    const ids = createIdGen(clock, (n) => new Uint8Array(randomBytes(n)));
    db = await openTestDb({ clock, ids });
    const templates = createTemplateRegistry();

    const first = seedDatabase(db, { catalog: loadCatalogEntries(), templates, ids, clock });

    expect(first).toEqual({ catalogEntries: loadCatalogEntries().length, workflowVersions: 1, profiles: 4 });
    const [wf] = db.repos.workflows.listWorkflows();
    const v1 = wf === undefined ? undefined : db.repos.workflows.getVersion(wf.id, 1);
    expect(v1?.status).toBe('validated');
    for (const s of v1?.spec.steps ?? []) if (s.kind === 'model') expect(v1?.prompts[s.instructionVersion]).toBe(templates.prompt(s.instructionVersion));
    const profiles = db.repos.profiles.list();
    expect(profiles.map((p) => p.name).sort()).toEqual(DEFAULT_PROFILES.map((p) => p.name).sort());
    for (const p of profiles) expect(p.capabilitiesSnapshot.structuredOutput).toBe(true);
    const openai = profiles.find((p) => p.name === 'Balanced · OpenAI');
    expect([openai?.providerId, openai?.modelId, openai?.params.effort, openai?.params.maxOutputTokens]).toEqual(['openai', 'gpt-6.1-sol', 'medium', 8000]);
  });

  it('is idempotent: a second call writes nothing', async () => {
    const clock = createManualClock();
    const ids = createIdGen(clock, (n) => new Uint8Array(randomBytes(n)));
    db = await openTestDb({ clock, ids });
    const o = { catalog: loadCatalogEntries(), templates: createTemplateRegistry(), ids, clock };
    seedDatabase(db, o);
    const counts = () => ({ catalog: db?.repos.catalog.list().length, wf: db?.repos.workflows.listWorkflows().length, profiles: db?.repos.profiles.list().length });
    const before = counts();

    const second = seedDatabase(db, o);

    expect(second).toEqual({ catalogEntries: 0, workflowVersions: 0, profiles: 0 });
    expect(counts()).toEqual(before);
  });

  it('refuses a default profile that fails its capability check', async () => {
    const clock = createManualClock();
    const ids = createIdGen(clock, (n) => new Uint8Array(randomBytes(n)));
    db = await openTestDb({ clock, ids });

    expect(() => seedDatabase(db as TestDb, { catalog: loadCatalogEntries(), templates: createTemplateRegistry(), ids, clock,
      profiles: [{ name: 'Broken', providerId: 'anthropic', modelId: 'no-such-model', params: { maxOutputTokens: 100, refusalFallback: 'off' } }] })).toThrow(/Broken/);
    expect(db.repos.profiles.list()).toEqual([]); // the whole seed tx rolled back
  });
});
