import { describe, expect, it } from 'vitest';
import { OUTPUT_SCHEMAS, catalogEntrySchema } from '@relay/contracts';
import type { OutputSchemaId } from '@relay/contracts';
import { CATALOG_FILES, cheapestCatalogModel, findCatalogEntry, latestCatalogVersion, loadCatalogEntries } from './catalog.js';
import { FAKE_FIXTURES, FAKE_FIXTURE_SCHEMAS } from './fake-fixtures/index.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Official provider pricing pages (R3-37). */
const OFFICIAL_PRICING: Record<string, RegExp> = {
  anthropic: /^https:\/\/(platform\.claude\.com|docs\.anthropic\.com|www\.anthropic\.com|claude\.com)\//,
  openai: /^https:\/\/(openai\.com|platform\.openai\.com)\//,
  gemini: /^https:\/\/(ai\.google\.dev|cloud\.google\.com)\//,
};

describe('loadCatalogEntries', () => {
  it('parses every statically imported catalog file with the contracts schema', () => {
    const entries = loadCatalogEntries();

    expect(CATALOG_FILES.length).toBeGreaterThan(0);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(() => catalogEntrySchema.parse(e)).not.toThrow();
    expect(loadCatalogEntries()).toBe(entries); // memoized
  });

  it('has unique (providerId, modelId) per catalog version', () => {
    const keys = loadCatalogEntries().map((e) => `${e.catalogVersion}|${e.providerId}|${e.modelId}`);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has an https source, ISO dates, and integer prices on every entry', () => {
    for (const e of loadCatalogEntries()) {
      expect(e.source.startsWith('https://')).toBe(true);
      expect(e.sourceRetrievedAt).toMatch(ISO_DATE);
      expect(e.effectiveDate).toMatch(ISO_DATE);
      expect(e.catalogVersion).toMatch(ISO_DATE);
      for (const p of Object.values(e.prices)) expect(Number.isSafeInteger(p)).toBe(true);
    }
  });

  it('uses official provider pricing URLs for non-fake entries and the reserved fake doc URL for the fake', () => {
    for (const e of loadCatalogEntries()) {
      if (e.providerId === 'fake') {
        expect(e.source).toBe('https://relay.invalid/docs/fake-provider');
        expect(e.sourceRetrievedAt).toBe(e.catalogVersion);
        continue;
      }
      expect(e.source).toMatch(OFFICIAL_PRICING[e.providerId]!);
    }
  });

  it('carries the D7 fake prices and the default Anthropic model', () => {
    expect(findCatalogEntry('fake', 'fake-model')?.prices).toMatchObject({ input: 1_000_000, output: 2_000_000 });
    expect(findCatalogEntry('anthropic', 'claude-opus-5-5')?.capabilities).toMatchObject({ supportsRequestLookup: false, supportsTokenCounting: true });
    expect(findCatalogEntry('anthropic', 'claude-haiku-4-5')?.capabilities.effortLevels).toEqual([]);
    expect(findCatalogEntry('anthropic', 'nope')).toBeUndefined();
  });

  it('prices cache writes at 1.25× input for every Anthropic entry', () => {
    for (const e of loadCatalogEntries().filter((x) => x.providerId === 'anthropic')) {
      expect(e.prices.cacheWrite * 4).toBe(e.prices.input * 5);
    }
  });

  it('finds the newest version and the cheapest model of a provider', () => {
    expect(latestCatalogVersion()).toBe('2026-09-25');
    expect(cheapestCatalogModel('anthropic')?.modelId).toBe('claude-haiku-4-5');
    expect(cheapestCatalogModel('gemini')).toBeUndefined();
  });
});

describe('FAKE_FIXTURES', () => {
  it.each(Object.keys(FAKE_FIXTURES))('%s parses with its contracts output schema', (name) => {
    const schemaId = FAKE_FIXTURE_SCHEMAS[name];
    const value = FAKE_FIXTURES[name];

    if (schemaId === 'connection-test') {
      expect(value).toEqual({ ok: true });
      return;
    }
    const result = OUTPUT_SCHEMAS[schemaId as OutputSchemaId].safeParse(value);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('keeps patch changes inside the plan fileScope', () => {
    const plan = FAKE_FIXTURES['plan.v1'] as { fileScope: string[] };
    const patch = FAKE_FIXTURES['patch.v1'] as { files: { relPath: string; unifiedDiff: string }[] };

    for (const f of patch.files) {
      expect(plan.fileScope).toContain(f.relPath);
      expect(f.unifiedDiff.startsWith(`--- a/${f.relPath}\n+++ b/${f.relPath}\n@@ `)).toBe(true);
    }
  });
});
