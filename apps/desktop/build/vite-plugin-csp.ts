// 08 H8: generates the renderer's meta CSP per mode (index.html never hand-writes one). Runs `post` so it sees the
// React-Refresh preamble @vitejs/plugin-react injects in dev, and hashes every inline script it finds.
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** CSP mode. */
export type CspMode = 'development' | 'production';

/** The strict production policy (00b §6). `frame-ancestors` is ignored in a meta CSP, so it is never emitted. */
export const PRODUCTION_CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:", // Vite inlines small woff2 files as data: URIs
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

/** The production policy string. */
export const PRODUCTION_CSP = PRODUCTION_CSP_DIRECTIVES.join('; ');

const INLINE_SCRIPT_RE = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

/** `'sha256-…'` sources of every non-empty inline script in `html`. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const m of html.matchAll(INLINE_SCRIPT_RE)) {
    const body = m[1] ?? '';
    if (body.trim() !== '') hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

/** Builds the policy for `mode` (dev adds the inline-script hashes, the localhost dev server, and HMR). */
export function buildCsp(mode: CspMode, html: string): string {
  if (mode === 'production') return PRODUCTION_CSP;
  return PRODUCTION_CSP_DIRECTIVES.map((d) => {
    if (d.startsWith('script-src')) return [d, ...inlineScriptHashes(html), 'http://localhost:*'].join(' ');
    if (d.startsWith('connect-src')) return `${d} ws://localhost:* http://localhost:*`;
    return d;
  }).join('; ');
}

/** Inserts the CSP meta as the first element of `<head>` (before any script). */
export function injectCspMeta(html: string, policy: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, '&quot;')}" />`;
  return html.replace(/<head(\s[^>]*)?>/i, (open) => `${open}\n    ${meta}`);
}

/** Options of {@link relayCsp}. */
export interface RelayCspOptions {
  /** Forces a mode; by default the dev server gets `development` and builds get `production`. */
  readonly mode?: CspMode;
}

/** The Vite plugin. */
export function relayCsp(opts: RelayCspOptions = {}): Plugin {
  return {
    name: 'relay:csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const mode: CspMode = opts.mode ?? (ctx.server === undefined ? 'production' : 'development');
        return injectCspMeta(html, buildCsp(mode, html));
      },
    },
  };
}
