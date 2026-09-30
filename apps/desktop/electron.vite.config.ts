// 08 H9 build (electron-vite 5). Every dependency is bundled (externalizeDeps: false); `electron` (and Node
// built-ins, e.g. node:sqlite) stay runtime imports. The runner is emitted as its own chunk via main's
// `import runnerEntryPath from '../runner/runner?modulePath'` — the only runner build mechanism.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { relayCsp } from './build/vite-plugin-csp.js';
import { esmShimFix } from './build/vite-plugin-esm-shim-fix.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const packages = resolve(root, '../../packages');

/** Workspace packages resolve to their TS sources (no stale dist; no global `development` condition). */
export const workspaceAlias = [
  { find: /^@relay\/(contracts|engine|storage|providers|tools|templates)$/, replacement: `${packages}/$1/src/index.ts` },
];

export default defineConfig({
  main: {
    resolve: { alias: workspaceAlias },
    plugins: [esmShimFix()],
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(root, 'src/main/index.ts') },
        external: ['electron'],
      },
    },
  },
  preload: {
    resolve: { alias: workspaceAlias },
    build: {
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
    plugins: [react(), tailwindcss(), relayCsp()],
    build: {
      outDir: resolve(root, 'out/renderer'),
      rollupOptions: { input: resolve(root, 'src/renderer/index.html') },
    },
  },
});
