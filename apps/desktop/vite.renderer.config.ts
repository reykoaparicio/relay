// 08 H9: renderer-only Vite config behind `pnpm dev:renderer` — serves the renderer on the fake bridge in a browser.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { relayCsp } from './build/vite-plugin-csp.js';
import { thirdPartyNotices } from './build/vite-plugin-third-party-notices.js';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  resolve: {
    alias: [
      { find: /^@relay\/(contracts)$/, replacement: `${resolve(root, '../../packages')}/$1/src/index.ts` },
    ],
  },
  plugins: [react(), tailwindcss(), relayCsp({ mode: 'development' }), thirdPartyNotices({ resolveFrom: root }).provide()],
  server: { port: 5173, strictPort: false },
});
