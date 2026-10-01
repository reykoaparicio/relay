import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_CSP, buildCsp, injectCspMeta, relayCsp } from './vite-plugin-csp.js';

const PREAMBLE = 'import { injectIntoGlobalHook } from "/@react-refresh";\ninjectIntoGlobalHook(window);';
const HTML = `<!doctype html><html><head><meta charset="UTF-8" /><script type="module">${PREAMBLE}</script><script type="module" src="/@vite/client"></script></head><body></body></html>`;

type Handler = (html: string, ctx: { server?: unknown }) => string;
const handlerOf = (p: ReturnType<typeof relayCsp>): Handler => (p.transformIndexHtml as unknown as { handler: Handler }).handler;

describe('relayCsp (H8)', () => {
  it('production meta equals the H8 policy (no localhost, no unsafe-eval, no frame-ancestors)', () => {
    const out = handlerOf(relayCsp({ mode: 'production' }))(HTML, {});

    expect(PRODUCTION_CSP).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
    expect(out).toContain(`<meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`);
    expect(out).not.toMatch(/localhost|unsafe-eval|frame-ancestors/);
    expect(out.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<script'));
  });

  it('dev meta includes the preamble sha256 hash and ws/http localhost', () => {
    const hash = createHash('sha256').update(PREAMBLE, 'utf8').digest('base64');

    const csp = buildCsp('development', HTML);

    expect(csp).toContain(`script-src 'self' 'sha256-${hash}' http://localhost:*`);
    expect(csp).toContain("connect-src 'self' ws://localhost:* http://localhost:*");
    expect(csp).not.toContain('frame-ancestors');
  });

  it('picks the mode from the dev server context by default', () => {
    const h = handlerOf(relayCsp());

    expect(h(HTML, { server: {} })).toContain('localhost');
    expect(h(HTML, {})).not.toContain('localhost');
  });

  it('injects directly after <head>', () => {
    expect(injectCspMeta('<head lang="x"><title>t</title></head>', "default-src 'self'")).toMatch(/^<head lang="x">\n\s+<meta http-equiv/);
  });
});
