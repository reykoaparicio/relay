// Regression: `pnpm dev` killed the runner on every start. `ws` (via @google/genai) optionally requires the native
// add-ons `bufferutil` / `utf-8-validate`; unresolved, Vite's dev-mode build replaced them with a stub that throws
// when the bundle loads. This builds a module shaped like ws's optional require in DEVELOPMENT mode and loads it.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { wsOptionalNative } from '../electron.vite.config.js';
import { makeTempDir, removeTempDir } from '../src/main/testing/temp-dirs.js';

const WS_LIKE = `
const fallback = (n) => 'js:' + n;
module.exports.mask = fallback;
if (!process.env.WS_NO_BUFFER_UTIL) {
  try {
    const bufferUtil = require('bufferutil');
    module.exports.mask = (n) => (n < 48 ? fallback(n) : bufferUtil.mask(n));
  } catch (e) {}
}
`;

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs.splice(0)) await removeTempDir(d);
});

async function buildAndLoad(withFix: boolean): Promise<{ mask: (n: number) => string }> {
  const dir = await makeTempDir('ws-native-');
  dirs.push(dir);
  // A real package that declares `bufferutil` as an OPTIONAL peer dependency, as ws does: that is what makes Vite
  // generate its stub for the missing add-on.
  const pkg = join(dir, 'node_modules', 'ws-like');
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: 'ws-like',
      version: '1.0.0',
      main: 'index.js',
      peerDependencies: { bufferutil: '*' },
      peerDependenciesMeta: { bufferutil: { optional: true } },
    }),
  );
  await writeFile(join(pkg, 'index.js'), WS_LIKE);
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src', 'entry.js'), "import wsLike from 'ws-like';\nexport const mask = wsLike.mask;\n");
  await build({
    configFile: false,
    logLevel: 'silent',
    mode: 'development',
    root: dir,
    ...(withFix ? { resolve: { alias: wsOptionalNative.alias }, define: wsOptionalNative.define } : {}),
    ssr: { noExternal: true }, // bundle dependencies, as the main/runner build does (externalizeDeps: false)
    build: {
      ssr: join(dir, 'src', 'entry.js'),
      outDir: join(dir, 'out'),
      minify: false,
      rollupOptions: { output: { format: 'es', entryFileNames: 'entry.mjs' } },
    },
  });
  return (await import(pathToFileURL(join(dir, 'out', 'entry.mjs')).href)) as { mask: (n: number) => string };
}

describe('ws optional native add-ons (dev-mode runner crash)', () => {
  it('a development build loads, and ws keeps its pure-JS fallback for every frame size', async () => {
    const mod = await buildAndLoad(true);

    expect(mod.mask(10)).toBe('js:10');
    expect(mod.mask(4096)).toBe('js:4096'); // never calls into the empty stand-in
  });

  it('without the fix the bundle fails to load or calls a missing add-on (the bug this guards)', async () => {
    const outcome = await buildAndLoad(false).then(
      (m) => {
        try {
          return m.mask(4096);
        } catch (e) {
          return `threw: ${String(e)}`;
        }
      },
      (e: unknown) => `threw: ${String(e)}`,
    );

    expect(outcome).not.toBe('js:4096');
  });
});
