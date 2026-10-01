import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NOTICES_PLACEHOLDER,
  THIRD_PARTY_NOTICES_ID,
  findPackageRoot,
  groupNotices,
  packageRootOf,
  packageRootsOfBundle,
  readPackageNotice,
  thirdPartyNotices,
} from './vite-plugin-third-party-notices.js';
import type { NoticesFs, PackageNotice, ThirdPartyNotices } from './vite-plugin-third-party-notices.js';

const PNPM = '/repo/node_modules/.pnpm';

describe('packageRootOf', () => {
  it.each([
    [`${PNPM}/react@19.3.0/node_modules/react/cjs/react.production.js`, `${PNPM}/react@19.3.0/node_modules/react`],
    [`${PNPM}/@radix-ui+react-dialog@1.1.23_x/node_modules/@radix-ui/react-dialog/dist/index.mjs`, `${PNPM}/@radix-ui+react-dialog@1.1.23_x/node_modules/@radix-ui/react-dialog`],
    ['/repo/node_modules/zod/v4/core/util.js', '/repo/node_modules/zod'],
    ['/repo/node_modules/a/node_modules/b/index.js', '/repo/node_modules/a/node_modules/b'], // nested: the owner is b
    [`\0${PNPM}/use-sync-external-store@1.6.0/node_modules/use-sync-external-store/shim/index.js?commonjs-proxy`, `${PNPM}/use-sync-external-store@1.6.0/node_modules/use-sync-external-store`],
    [`${PNPM}/@fontsource+fira-sans@5.3.0/node_modules/@fontsource/fira-sans/files/fira-sans-latin-400-normal.woff2`, `${PNPM}/@fontsource+fira-sans@5.3.0/node_modules/@fontsource/fira-sans`],
  ])('%s → its package root', (id, root) => {
    expect(packageRootOf(id, '/')).toBe(root);
  });

  it.each([
    '/repo/apps/desktop/src/renderer/main.tsx',
    '/repo/packages/contracts/src/index.ts', // workspace packages are Relay's own code
    '\0vite/preload-helper.js',
    'virtual:third-party-notices',
    '/repo/node_modules/.vite/deps/react.js',
    '/repo/node_modules/@scope',
  ])('%s → null', (id) => {
    expect(packageRootOf(id, '/')).toBeNull();
  });
});

function memFs(files: Record<string, string>): NoticesFs {
  return {
    readFileSync: (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    readdirSync: (dir) => {
      const names = Object.keys(files).filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/'));
      if (names.length === 0) throw new Error(`ENOENT ${dir}`);
      return names.map((f) => f.slice(dir.length + 1));
    },
    existsSync: (p) => p in files,
  };
}

const MIT = 'MIT License\r\n\r\nCopyright (c) Example   \r\n';

describe('readPackageNotice', () => {
  const fs = memFs({
    '/nm/a/package.json': JSON.stringify({ name: 'a', version: '1.0.0', license: 'MIT' }),
    '/nm/a/LICENSE': MIT,
    '/nm/b/package.json': JSON.stringify({ name: 'b', version: '2.0.0', license: { type: 'ISC' } }),
    '/nm/b/LICENCE.md': 'ISC text',
    '/nm/b/COPYING': 'more terms',
    '/nm/c/package.json': JSON.stringify({ name: 'c', version: '3.0.0', licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }),
    '/nm/c/index.js': '',
  });

  it('reads name, version, SPDX license and the normalized LICENSE text', () => {
    expect(readPackageNotice('/nm/a', fs)).toEqual({ name: 'a', version: '1.0.0', license: 'MIT', text: 'MIT License\n\nCopyright (c) Example' });
  });

  it('joins several license files (LICENCE/COPYING spellings) and reads object-form licenses', () => {
    expect(readPackageNotice('/nm/b', fs)).toMatchObject({ license: 'ISC', text: 'more terms\n\nISC text' }); // COPYING, then LICENCE.md
  });

  it('states the SPDX id when the package ships no license file; legacy `licenses` arrays are OR-joined', () => {
    expect(readPackageNotice('/nm/c', fs)).toEqual({
      name: 'c', version: '3.0.0', license: 'MIT OR Apache-2.0',
      text: 'Licensed under MIT OR Apache-2.0. The package does not include a license file.',
    });
  });

  it('returns null without a readable package.json', () => {
    expect(readPackageNotice('/nm/missing', fs)).toBeNull();
  });
});

describe('groupNotices', () => {
  const p = (name: string, version: string, license: string, text: string): PackageNotice => ({ name, version, license, text });

  it('groups packages with identical text, dedupes name@version, and sorts deterministically', () => {
    const shared = 'MIT License\n\nCopyright (c) Meta';
    const out = groupNotices(
      [p('scheduler', '0.27.0', 'MIT', shared), p('react', '19.3.0', 'MIT', shared), p('zod', '4.6.5', 'MIT', 'MIT zod'), p('react', '19.3.0', 'MIT', shared), p('lucide-react', '1.49.0', 'ISC', 'ISC lucide')],
      false,
    );

    expect(out.packageCount).toBe(4);
    expect(out.partial).toBe(false);
    expect(out.groups.map((g) => [g.license, g.packages.map((x) => x.name)])).toEqual([
      ['ISC', ['lucide-react']],
      ['MIT', ['react', 'scheduler']],
      ['MIT', ['zod']],
    ]);
  });

  it('lists every distinct SPDX id of a group (same text, different metadata)', () => {
    const out = groupNotices([p('a', '1', 'MIT', 'T'), p('b', '1', 'MIT-0', 'T')], true);

    expect(out.groups).toEqual([{ license: 'MIT / MIT-0', text: 'T', packages: [{ name: 'a', version: '1' }, { name: 'b', version: '1' }] }]);
    expect(out.partial).toBe(true);
  });
});

describe('packageRootsOfBundle / findPackageRoot', () => {
  it('collects roots from chunk module ids and asset original files (root-relative, as Vite records them)', () => {
    const roots = packageRootsOfBundle(
      {
        'index.js': { type: 'chunk', modules: { [join('/r/node_modules/react/index.js')]: {}, [join('/r/src/main.tsx')]: {} } },
        'font.woff2': { type: 'asset', originalFileNames: ['../../node_modules/@fontsource/fira-sans/files/x.woff2'] },
        'index.css': { type: 'asset' },
      },
      join('/r/src/renderer'),
    );

    expect([...roots].sort()).toEqual([join('/r/node_modules/@fontsource/fira-sans'), join('/r/node_modules/react')]);
  });

  it('walks up to the nearest node_modules/<name>', () => {
    const fs = memFs({ [join('/repo/node_modules/tailwindcss/package.json')]: '{}' });

    expect(findPackageRoot('tailwindcss', join('/repo/apps/desktop'), fs)).toBe(join('/repo/node_modules/tailwindcss'));
    expect(findPackageRoot('nope', join('/repo/apps/desktop'), fs)).toBeNull();
  });
});

describe('thirdPartyNotices plugins', () => {
  type Hook = (this: unknown, ...args: unknown[]) => unknown;
  const handler = (h: unknown): Hook => (typeof h === 'function' ? h : (h as { handler: Hook }).handler) as Hook;
  const nm = (name: string) => join('/r/node_modules', name);
  const fs = memFs({
    [join(nm('main-dep'), 'package.json')]: JSON.stringify({ name: 'main-dep', version: '1.0.0', license: 'MIT' }),
    [join(nm('main-dep'), 'LICENSE')]: 'MIT shared',
    [join(nm('pre-dep'), 'package.json')]: JSON.stringify({ name: 'pre-dep', version: '2.0.0', license: 'MIT' }),
    [join(nm('pre-dep'), 'LICENSE')]: 'MIT shared',
    [join(nm('ui-dep'), 'package.json')]: JSON.stringify({ name: 'ui-dep', version: '3.0.0', license: 'ISC' }),
    [join(nm('ui-dep'), 'LICENSE')]: 'ISC ui',
  });
  const chunk = (ids: string[], code = '') => ({ type: 'chunk', code, modules: Object.fromEntries(ids.map((i) => [i, {}])) });

  function renderer(collectFrom: string[]) {
    const store = thirdPartyNotices({ fs });
    if (collectFrom.includes('main')) handler(store.collect('main').generateBundle).call({}, {}, { 'index.js': chunk([join(nm('main-dep'), 'i.js')]) });
    if (collectFrom.includes('preload')) handler(store.collect('preload').generateBundle).call({}, {}, { 'index.js': chunk([join(nm('pre-dep'), 'i.js')]) });
    const provide = store.provide();
    const warnings: string[] = [];
    const data = chunk([`\0${THIRD_PARTY_NOTICES_ID}`], `const e=JSON.parse("${NOTICES_PLACEHOLDER}");export{e as default};`);
    const bundle = { 'index.js': chunk([join(nm('ui-dep'), 'i.js')], 'app()'), 'notices.js': data };
    handler(provide.generateBundle).call({ warn: (m: string) => warnings.push(m) }, {}, bundle);
    const json = /JSON\.parse\(("(?:[^"\\]|\\.)*")\)/.exec(data.code)?.[1] ?? '""';
    return { notices: JSON.parse(JSON.parse(json) as string) as ThirdPartyNotices, warnings, code: data.code, provide };
  }

  it('resolves the virtual id and replaces the placeholder with main + preload + renderer packages', () => {
    const { notices, warnings, code, provide } = renderer(['main', 'preload']);

    expect(handler(provide.resolveId).call({}, THIRD_PARTY_NOTICES_ID)).toBe(`\0${THIRD_PARTY_NOTICES_ID}`);
    expect(code).not.toContain(NOTICES_PLACEHOLDER);
    expect(warnings).toEqual([]);
    expect(notices).toEqual({
      partial: false,
      packageCount: 3,
      groups: [
        { license: 'MIT', text: 'MIT shared', packages: [{ name: 'main-dep', version: '1.0.0' }, { name: 'pre-dep', version: '2.0.0' }] },
        { license: 'ISC', text: 'ISC ui', packages: [{ name: 'ui-dep', version: '3.0.0' }] },
      ],
    });
  });

  it('marks the list partial (and warns) when the main/preload builds did not run in this process', () => {
    const { notices, warnings } = renderer([]);

    expect(notices.partial).toBe(true);
    expect(notices.packageCount).toBe(1);
    expect(warnings[0]).toMatch(/main, preload/);
  });

  it('serves an empty, partial stub in dev (serve)', () => {
    const provide = thirdPartyNotices({ fs }).provide();
    handler(provide.configResolved).call({}, { command: 'serve' });

    expect(handler(provide.load).call({}, `\0${THIRD_PARTY_NOTICES_ID}`)).toContain('"partial":true');
  });
});
