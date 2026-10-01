import { describe, expect, it } from 'vitest';
import { RENDERER_ENTRY_BUDGET_BYTES, chunkBudget, overBudget } from './vite-plugin-chunk-budget.js';

describe('chunk budget (PERF-01)', () => {
  it('flags only entry chunks over the budget, counting UTF-8 bytes', () => {
    const out = overBudget(
      [
        { type: 'chunk', fileName: 'index.js', isEntry: true, code: 'é'.repeat(6) }, // 12 bytes
        { type: 'chunk', fileName: 'lazy.js', isEntry: false, code: 'x'.repeat(100) },
        { type: 'asset', fileName: 'font.woff2' },
        { type: 'chunk', fileName: 'small.js', isEntry: true, code: 'x' },
      ],
      10,
    );

    expect(out).toEqual([['index.js', 12]]);
  });

  it('fails the build through this.error with the offending file', () => {
    const plugin = chunkBudget(5);
    const hook = plugin.generateBundle as { handler: (this: unknown, o: unknown, b: unknown) => void };
    const errors: string[] = [];

    hook.handler.call({ error: (m: string) => errors.push(m) }, {}, { 'index.js': { type: 'chunk', fileName: 'index.js', isEntry: true, code: 'xxxxxxx' } });

    expect(errors[0]).toMatch(/index\.js = 7 bytes/);
    expect(RENDERER_ENTRY_BUDGET_BYTES).toBe(1_200_000);
  });
});
