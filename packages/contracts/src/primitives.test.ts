import { describe, expect, it } from 'vitest';
import {
  cursorSchema,
  epochMsSchema,
  idempotencyKeySchema,
  monthSchema,
  relPathSchema,
  sha256Schema,
  stepKeySchema,
} from './primitives.js';

describe('relPathSchema', () => {
  it.each(['src/a.ts', 'a/.b/c', 'a..b/c', 'README.md'])('accepts %s', (p) => {
    expect(relPathSchema.safeParse(p).success).toBe(true);
  });

  it.each(['/abs', 'a/../b', '..', 'a\\b', 'a\0b', '', 'x'.repeat(513)])('rejects %j', (p) => {
    expect(relPathSchema.safeParse(p).success).toBe(false);
  });
});

describe('relPathSchema canonical form (B15)', () => {
  it.each([
    '.',
    './a',
    'a/.',
    'a//b',
    'a/',
    'a/./b',
    'a\x01b',
    'a\x1fb',
    'a\x7fb',
    'a\nb',
    ' ',
    'a/ /b',
    '\t/a',
    'a/\t',
  ])('rejects %j', (p) => {
    expect(relPathSchema.safeParse(p).success).toBe(false);
  });

  it.each(['a b/c d.ts', 'src/.env.example', '.github/workflows/ci.yml'])('still accepts %j', (p) => {
    expect(relPathSchema.safeParse(p).success).toBe(true);
  });
});

describe('sha256Schema', () => {
  it('accepts lowercase 64-hex and rejects uppercase or 63 chars', () => {
    expect(sha256Schema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(sha256Schema.safeParse('A'.repeat(64)).success).toBe(false);
    expect(sha256Schema.safeParse('a'.repeat(63)).success).toBe(false);
  });
});

describe('stepKeySchema', () => {
  it('accepts review and finalize; rejects Review, 1step, and 33 chars', () => {
    expect(stepKeySchema.safeParse('review').success).toBe(true);
    expect(stepKeySchema.safeParse('finalize').success).toBe(true);
    expect(stepKeySchema.safeParse('Review').success).toBe(false);
    expect(stepKeySchema.safeParse('1step').success).toBe(false);
    expect(stepKeySchema.safeParse(`a${'b'.repeat(32)}`).success).toBe(false);
    expect(stepKeySchema.safeParse(`a${'b'.repeat(31)}`).success).toBe(true);
  });
});

describe('epochMsSchema', () => {
  it('rejects negatives and floats', () => {
    expect(epochMsSchema.safeParse(0).success).toBe(true);
    expect(epochMsSchema.safeParse(-1).success).toBe(false);
    expect(epochMsSchema.safeParse(1.5).success).toBe(false);
  });
});

describe('small scalar schemas', () => {
  it('validates month, idempotency key, and cursor', () => {
    expect(monthSchema.safeParse('2026-09').success).toBe(true);
    expect(monthSchema.safeParse('2026-13').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('01J9ZZZZZZZZZZZZZZZZZZZZZZ').success).toBe(true);
    expect(cursorSchema.safeParse('').success).toBe(false);
  });
});
