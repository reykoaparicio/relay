import { describe, expect, it } from 'vitest';
import { formatBytes } from './bytes';

describe('formatBytes', () => {
  it('renders bytes below 1 KiB as whole bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('renders KiB and MiB with one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(39_526)).toBe('38.6 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
