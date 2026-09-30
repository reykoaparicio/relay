import { describe, expect, it } from 'vitest';
import { readRepoFileText } from './styles/read-file.testing';

const INDEX_HTML = 'apps/desktop/src/renderer/index.html';

describe('renderer index.html (10 J1)', () => {
  const html = readRepoFileText(INDEX_HTML);

  it('has no hand-written Content-Security-Policy (the Vite plugin injects it per mode, 08 §H8)', () => {
    expect(html.toLowerCase()).not.toContain('content-security-policy');
  });

  it('starts in the dark theme and mounts #root', () => {
    expect(html).toMatch(/<html[^>]*data-theme="dark"/);
    expect(html).toContain('<div id="root"></div>');
  });
});
