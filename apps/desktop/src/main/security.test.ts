import { describe, expect, it, vi } from 'vitest';
import type { TrustedOrigin } from './ipc/router.js';
import { DEV_HEADER_CSP, applySessionPolicy, guardWebContents } from './security.js';
import type { SessionLike, WebContentsLike } from './security.js';

const FILE_URL = 'file:///app/out/renderer/index.html';
const DEV_URL = 'http://localhost:5173';
const PACKAGED: TrustedOrigin = { isPackaged: true, rendererFileUrl: FILE_URL, devServerUrl: undefined };
const DEV: TrustedOrigin = { isPackaged: false, rendererFileUrl: FILE_URL, devServerUrl: DEV_URL };

type HeadersListener = Parameters<SessionLike['webRequest']['onHeadersReceived']>[0];
type RequestHandler = Parameters<SessionLike['setPermissionRequestHandler']>[0];

function fakeSession() {
  const s = {
    request: null as RequestHandler | null,
    check: null as (() => boolean) | null,
    headers: null as HeadersListener | null,
  };
  const session: SessionLike = {
    setPermissionRequestHandler: (h) => {
      s.request = h;
    },
    setPermissionCheckHandler: (h) => {
      s.check = h;
    },
    webRequest: {
      onHeadersReceived: (l) => {
        s.headers = l;
      },
    },
  };
  return { session, s };
}

/** Runs the registered header listener for `url` and returns what it passed to the callback. */
function headersFor(listener: HeadersListener, url: string, responseHeaders?: Record<string, string[]>) {
  let out: { responseHeaders?: Record<string, string[]> } | undefined;
  listener(responseHeaders === undefined ? { url } : { url, responseHeaders }, (r) => {
    out = r;
  });
  return out;
}

function fakeWebContents() {
  const listeners = new Map<string, (e: { preventDefault(): void }, url?: string) => void>();
  let openHandler: (() => { action: 'deny' }) | null = null;
  const wc = {
    on: (event: string, l: (e: { preventDefault(): void }, url?: string) => void) => {
      listeners.set(event, l);
    },
    setWindowOpenHandler: (h: () => { action: 'deny' }) => {
      openHandler = h;
    },
  } as unknown as WebContentsLike;
  /** Fires `event` and reports whether the guard called preventDefault. */
  const fire = (event: string, url?: string): boolean => {
    const preventDefault = vi.fn();
    const l = listeners.get(event);
    if (l === undefined) throw new Error(`no ${event} listener`);
    l({ preventDefault }, url);
    return preventDefault.mock.calls.length > 0;
  };
  return { wc, fire, openHandler: () => openHandler };
}

describe('applySessionPolicy (H8)', () => {
  it.each(['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal'])('denies the %s permission request', (permission) => {
    const { session, s } = fakeSession();
    applySessionPolicy(session, PACKAGED);
    const cb = vi.fn();

    s.request?.({}, permission, cb);

    expect(cb).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('answers every permission check with false', () => {
    const { session, s } = fakeSession();
    applySessionPolicy(session, DEV);

    expect(s.check?.()).toBe(false);
  });

  it('packaged: installs no header CSP (production uses the generated meta CSP)', () => {
    const { session, s } = fakeSession();

    applySessionPolicy(session, PACKAGED);
    applySessionPolicy(session, { ...PACKAGED, devServerUrl: DEV_URL }); // a stray dev URL is ignored when packaged

    expect(s.headers).toBeNull();
  });

  it('unpackaged without a dev server URL installs no header CSP', () => {
    const { session, s } = fakeSession();

    applySessionPolicy(session, { ...DEV, devServerUrl: '' });

    expect(s.headers).toBeNull();
  });

  it('dev: adds the dev CSP (incl. frame-ancestors) to dev-server responses and keeps existing headers', () => {
    const { session, s } = fakeSession();
    applySessionPolicy(session, DEV);
    if (s.headers === null) throw new Error('no header listener');

    const out = headersFor(s.headers, `${DEV_URL}/index.html`, { 'X-Existing': ['1'] });

    expect(out?.responseHeaders).toEqual({ 'X-Existing': ['1'], 'Content-Security-Policy': [DEV_HEADER_CSP] });
    expect(DEV_HEADER_CSP).toContain("frame-ancestors 'none'");
    expect(DEV_HEADER_CSP).toContain("object-src 'none'");
  });

  it('dev: leaves responses from other origins untouched', () => {
    const { session, s } = fakeSession();
    applySessionPolicy(session, DEV);
    if (s.headers === null) throw new Error('no header listener');

    expect(headersFor(s.headers, 'https://example.com/x.js', { A: ['b'] })).toEqual({ responseHeaders: { A: ['b'] } });
    expect(headersFor(s.headers, 'http://localhost:9999/x.js')).toEqual({});
  });
});

describe('guardWebContents (H8)', () => {
  it('packaged: allows navigation only to the renderer entry (any #fragment)', () => {
    const { wc, fire } = fakeWebContents();
    guardWebContents(wc, PACKAGED);

    expect(fire('will-navigate', `${FILE_URL}#/runs`)).toBe(false);
    expect(fire('will-navigate', 'https://evil.example/')).toBe(true);
    expect(fire('will-navigate', 'file:///tmp/evil/index.html')).toBe(true);
    expect(fire('will-navigate', `${DEV_URL}/`)).toBe(true);
  });

  it('dev: allows the dev server origin but blocks other localhost ports and origins', () => {
    const { wc, fire } = fakeWebContents();
    guardWebContents(wc, DEV);

    expect(fire('will-navigate', `${DEV_URL}/#/settings`)).toBe(false);
    expect(fire('will-navigate', 'http://localhost:9999/')).toBe(true);
    expect(fire('will-navigate', 'https://example.com/')).toBe(true);
  });

  it('denies every window.open', () => {
    const { wc, openHandler } = fakeWebContents();
    guardWebContents(wc, PACKAGED);

    expect(openHandler()?.()).toEqual({ action: 'deny' });
  });

  it('prevents attaching any webview', () => {
    const { wc, fire } = fakeWebContents();
    guardWebContents(wc, DEV);

    expect(fire('will-attach-webview')).toBe(true);
  });
});
