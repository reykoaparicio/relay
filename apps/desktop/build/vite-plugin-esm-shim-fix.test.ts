import { describe, expect, it } from 'vitest';
import { insertShim, leadingImportsEnd } from './vite-plugin-esm-shim-fix.js';

const SHIM = "\nimport __cjs_mod__ from 'node:module';\nconst require = __cjs_mod__.createRequire(import.meta.url);\n";

describe('esm shim fix', () => {
  it('inserts after the leading import block, ignoring import text inside later string literals', () => {
    const code = [
      'import { a } from "node:fs";',
      'import "node:fs/promises";',
      'const patch = "--- a/x\\n import { isoTimestamp } from \'../lib/format.js\';";',
      'require("y");',
    ].join('\n');

    const out = insertShim(code, SHIM);

    expect(leadingImportsEnd(code)).toBe(code.indexOf('\nconst patch'));
    expect(out?.indexOf(SHIM)).toBe(code.indexOf('\nconst patch'));
    expect(out).toContain("from '../lib/format.js';\";");
  });

  it('leaves code without CommonJS syntax untouched', () => {
    expect(insertShim('import x from "y";\nx();', SHIM)).toBeNull();
  });
});
