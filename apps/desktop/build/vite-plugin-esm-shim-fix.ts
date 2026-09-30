// Works around electron-vite 5's `vite:esm-shim`: it places the CommonJS shim after the LAST regex match of an
// `import … from '…'`, which can be inside a string literal (the bundled fake-provider fixtures contain patch text
// with import lines), corrupting the runner chunk. Rollup's ES output keeps every static import in a leading block,
// so this fix inserts the identical shim right after that block instead.
import type { Plugin, ResolvedConfig } from 'vite';

type RenderChunk = (code: string, chunk: unknown, options: { format: string; sourcemap?: unknown }) => unknown;

const LEADING_TOKEN_RE = /^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|import\s*(?:[\w$*{}\s,]+from\s*)?['"][^'"\n]+['"]\s*;?)/;

/** End offset of the leading block of whitespace, comments, and static import statements. */
export function leadingImportsEnd(code: string): number {
  let i = 0;
  let lastImportEnd = 0;
  for (;;) {
    const m = LEADING_TOKEN_RE.exec(code.slice(i));
    if (m === null || m[0].length === 0) return lastImportEnd;
    i += m[0].length;
    if (m[0].startsWith('import')) lastImportEnd = i;
  }
}

/** Probe code that makes the original plugin reveal its exact shim text. */
const PROBE = 'require("x");';

function shimText(original: RenderChunk): string | null {
  const probed = original(PROBE, {}, { format: 'es' }) as { code?: string } | null;
  if (probed?.code === undefined) return null;
  return probed.code.endsWith(PROBE) ? probed.code.slice(0, -PROBE.length) : null;
}

/** Inserts `shim` after the leading import block when `code` needs it (same trigger as electron-vite). */
export function insertShim(code: string, shim: string): string | null {
  if (code.includes(shim) || !/__filename|__dirname|require\(|require\.resolve\(/.test(code)) return null;
  const at = leadingImportsEnd(code);
  return `${code.slice(0, at)}${shim}${code.slice(at)}`;
}

/** Replaces the shim plugin's renderChunk in every build that includes this plugin. */
export function esmShimFix(): Plugin {
  return {
    name: 'relay:esm-shim-fix',
    configResolved(config: ResolvedConfig) {
      const target = config.plugins.find((p) => p.name === 'vite:esm-shim');
      const original = target?.renderChunk as RenderChunk | undefined;
      if (target === undefined || typeof original !== 'function') return;
      const shim = shimText(original);
      if (shim === null) return;
      const fixed: RenderChunk = (code, _chunk, options) => {
        if (options.format !== 'es') return null;
        const out = insertShim(code, shim);
        return out === null ? null : { code: out, map: null };
      };
      Reflect.set(target, 'renderChunk', fixed);
    },
  };
}
