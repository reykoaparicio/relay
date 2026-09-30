import { describe, expect, it } from 'vitest';
import { manifestFixture } from '../test-fixtures.js';
import { contextManifestSchema } from './manifest.js';

describe('contextManifestSchema', () => {
  it('parses a G4-shaped fixture', () => {
    expect(contextManifestSchema.safeParse(manifestFixture()).success).toBe(true);
  });

  it('rejects an unknown omitted reason and a non-sha contextHash', () => {
    const badReason = { ...manifestFixture(), omitted: [{ kind: 'file', ref: 'x', reason: 'too_spicy' }] };
    const badHash = { ...manifestFixture(), contextHash: 'not-a-sha' };

    expect(contextManifestSchema.safeParse(badReason).success).toBe(false);
    expect(contextManifestSchema.safeParse(badHash).success).toBe(false);
  });

  it('rejects absolute file paths', () => {
    const badPath = {
      ...manifestFixture(),
      files: [
        {
          relPath: '/etc/passwd',
          sha256: 'a'.repeat(64),
          sizeBytes: 1,
          tokens: 1,
          included: true,
          reason: 'selected',
        },
      ],
    };

    expect(contextManifestSchema.safeParse(badPath).success).toBe(false);
  });
});
