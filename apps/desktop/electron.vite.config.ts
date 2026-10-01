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

/** LIC-01: one store shared by the main (+ nested runner), preload and renderer builds. */
const notices = thirdPartyNotices({ extraPackages: ['tailwindcss'], resolveFrom: root });

export default defineConfig({
  main: {
    resolve: { alias: workspaceAlias },
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
