import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { catalogFileSchema } from '@relay/contracts';
import { CATALOG_FILES, latestCatalogVersion } from './catalog.js';

// A shipped catalog version is immutable (04 §D2): seeding inserts with ON CONFLICT DO NOTHING, so an edited file
// would leave the same version key with different rows depending on when a DB was first seeded (impr bug-hunt
// finding 3). Any change, even a capability or a note, is a NEW version file. To ship one: add the file, its import
// in catalog.ts, and its hash below. Never change an existing hash.
const SHIPPED_SHA256: Readonly<Record<string, string>> = {
  '2026-09-25.json': '1006ea8ee312876e5f55ad2a7d58e8a35a938586770d2c98ee83869eec869c57',
  '2026-10-02.json': '2209ba3eeb07e4fd2f1fa9300a1cea98479a05106f1c22e20eed80425562ff69',
};

/** Not a shipped catalog version (fake-adapter test data). */
const NOT_SHIPPED = new Set(['test-fixture.json']);

const CATALOG_DIR = fileURLToPath(new URL('../catalog/', import.meta.url));

/** SHA-256 of the file with CRLF normalized to LF, so a Windows checkout hashes the same as the committed bytes. */
function sha256(name: string): string {
  const text = readFileSync(`${CATALOG_DIR}${name}`, 'utf8').replaceAll('\r\n', '\n');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const shipped = readdirSync(CATALOG_DIR)
  .filter((f) => f.endsWith('.json') && !NOT_SHIPPED.has(f))
  .sort();

describe('released catalog files are immutable', () => {
  it('every catalog file is listed with its hash (a new version adds a line; nothing else changes)', () => {
    expect(shipped).toEqual(Object.keys(SHIPPED_SHA256).sort());
  });

  it.each(Object.entries(SHIPPED_SHA256))('%s is byte-identical to its release', (name, hash) => {
    expect(sha256(name)).toBe(hash);
  });

  it('each file is named after its catalogVersion and bundled in catalog.ts, oldest first', () => {
    const bundled = CATALOG_FILES.map((raw) => catalogFileSchema.parse(raw).catalogVersion);

    expect(bundled).toEqual(shipped.map((f) => f.replace(/\.json$/, '')));
    expect(latestCatalogVersion()).toBe(bundled.at(-1));
  });
});
