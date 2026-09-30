import { describe, expect, it } from 'vitest';
import { formatHash } from './hash';

describe('formatHash', () => {
  it('truncates a sha256 to the first and last 4 characters', () => {
    const sha = '6f4a' + '0'.repeat(56) + 'b18c';

    expect(formatHash(sha)).toBe('6f4a…b18c');
  });

  it('leaves short values untouched', () => {
    expect(formatHash('abc123')).toBe('abc123');
    expect(formatHash('123456789')).toBe('123456789');
  });
});
