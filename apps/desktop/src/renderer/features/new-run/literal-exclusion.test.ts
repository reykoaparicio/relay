import { describe, expect, it } from 'vitest';
import { literalExclusionPattern } from './UnreadableFileActions';

describe('literalExclusionPattern', () => {
  it('leaves a plain path unchanged', () => {
    expect(literalExclusionPattern('src/db/client.ts')).toBe('src/db/client.ts');
  });

  it('escapes glob syntax so the pattern matches only that file', () => {
    expect(literalExclusionPattern('src/a[b].ts')).toBe('src/a\\[b\\].ts');
    expect(literalExclusionPattern('src/*.ts')).toBe('src/\\*.ts');
    expect(literalExclusionPattern('src/what?.ts')).toBe('src/what\\?.ts');
    expect(literalExclusionPattern('src/x{1,2}.ts')).toBe('src/x\\{1,2\\}.ts');
    expect(literalExclusionPattern('src/!neg.ts')).toBe('src/\\!neg.ts');
    expect(literalExclusionPattern('src/@(a)+.ts')).toBe('src/\\@\\(a\\)\\+.ts');
  });
});
