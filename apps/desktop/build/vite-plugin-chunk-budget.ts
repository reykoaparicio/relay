// PERF-01: fails the build when an entry chunk grows past its byte budget, so an accidental unminified build or a
// heavy dependency landing in the eagerly loaded renderer chunk is caught by `pnpm build`, not by users.
import type { Plugin } from 'vite';

/** Renderer entry-chunk budget (minified, uncompressed). Measured 2026-10-01 at 0.92 MB after PERF-01 (2.11 MB unminified). */
export const RENDERER_ENTRY_BUDGET_BYTES = 1_200_000;

/** The part of a Rollup output chunk the check reads. */
export interface ChunkLike {
  readonly type: 'chunk' | 'asset';
  readonly fileName: string;
  readonly isEntry?: boolean;
  readonly code?: string;
}

/** Entry chunks over `maxBytes` (UTF-8 bytes), as `[fileName, bytes]`. */
export function overBudget(outputs: readonly ChunkLike[], maxBytes: number): [string, number][] {
  const over: [string, number][] = [];
  for (const o of outputs) {
    if (o.type !== 'chunk' || o.isEntry !== true || o.code === undefined) continue;
    const bytes = Buffer.byteLength(o.code, 'utf8');
    if (bytes > maxBytes) over.push([o.fileName, bytes]);
  }
  return over;
}

/** Build-time check: every entry chunk must stay within `maxBytes`. */
export function chunkBudget(maxBytes: number = RENDERER_ENTRY_BUDGET_BYTES): Plugin {
  return {
    name: 'relay:chunk-budget',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const over = overBudget(Object.values(bundle), maxBytes);
        if (over.length > 0) {
          this.error(
            `entry chunk budget exceeded (${String(maxBytes)} bytes): ${over.map(([f, b]) => `${f} = ${String(b)} bytes`).join(', ')}. ` +
              'Lazy-load the new code or raise RENDERER_ENTRY_BUDGET_BYTES deliberately.',
          );
        }
      },
    },
  };
}
