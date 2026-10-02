// 08 H9 build (electron-vite 5). Every dependency is bundled (externalizeDeps: false); `electron` (and Node
// built-ins, e.g. node:sqlite) stay runtime imports. The runner is emitted as its own chunk via main's
// `import runnerEntryPath from '../runner/runner?modulePath'` — the only runner build mechanism.
// PERF-01: every build is minified with esbuild (electron-vite 5 defaults to `minify: false`) and emits HIDDEN
// sourcemaps (`.map` files, no sourceMappingURL comment; excluded from the package by electron-builder.yml). Main,
// preload and the runner keep function/class names (`keepNames`): V8 stack traces and `error.name`/`constructor.name`
// stay readable, and positions map back through the .map files.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { chunkBudget } from './build/vite-plugin-chunk-budget.js';
import { relayCsp } from './build/vite-plugin-csp.js';
import { esmShimFix } from './build/vite-plugin-esm-shim-fix.js';
import { thirdPartyNotices } from './build/vite-plugin-third-party-notices.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const packages = resolve(root, '../../packages');

/** Workspace packages resolve to their TS sources (no stale dist; no global `development` condition). */
export const workspaceAlias = [
  { find: /^@relay\/(contracts|engine|storage|providers|tools|templates)$/, replacement: `${packages}/$1/src/index.ts` },
];

/**
 * `ws` (pulled in by @google/genai) optionally requires the native add-ons `bufferutil` and `utf-8-validate`, which
 * are not installed. Unresolved, Vite replaces them with a stub that THROWS at load in dev builds (the runner died on
 * every `pnpm dev` start) and with an empty object in production builds (where `ws` would then call a missing
 * `bufferUtil.mask` on frames of 48+ bytes). Defining ws's own opt-out flags removes both code paths; the alias
 * points the now-unused ids at an empty local module so no stub is generated.
 */
export const wsOptionalNative = {
  alias: [{ find: /^(bufferutil|utf-8-validate)$/, replacement: resolve(root, 'build/ws-optional-native.cjs') }],
  define: {
    'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('1'),
    'process.env.WS_NO_UTF_8_VALIDATE': JSON.stringify('1'),
  },
};

/** LIC-01: one store shared by the main (+ nested runner), preload and renderer builds. */
const notices = thirdPartyNotices({ extraPackages: ['tailwindcss'], resolveFrom: root });

export default defineConfig({
  main: {
    resolve: { alias: [...workspaceAlias, ...wsOptionalNative.alias] },
    define: wsOptionalNative.define,
    plugins: [esmShimFix(), notices.collect('main')],
    esbuild: { keepNames: true },
    build: {
      minify: 'esbuild',
      sourcemap: 'hidden',
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(root, 'src/main/index.ts') },
        external: ['electron'],
      },
    },
  },
  preload: {
    resolve: { alias: workspaceAlias },
    plugins: [notices.collect('preload')],
    esbuild: { keepNames: true },
    build: {
      minify: 'esbuild',
      sourcemap: 'hidden',
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    resolve: { alias: workspaceAlias },
    plugins: [react(), tailwindcss(), relayCsp(), notices.provide(), chunkBudget()],
    build: {
      minify: 'esbuild',
      sourcemap: 'hidden',
      outDir: resolve(root, 'out/renderer'),
      rollupOptions: { input: resolve(root, 'src/renderer/index.html') },
    },
  },
});
