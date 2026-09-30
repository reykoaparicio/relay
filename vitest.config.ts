import { defineConfig } from 'vitest/config';

// Setting resolve.conditions replaces Vite's defaults, so re-add the ones the runtime relies on.
// `ssr.resolve` is set too because Vite >= 6 resolves the SSR environment (used by environment: 'node') separately.
const nodeDev = ['development', 'module', 'node'];
const webDev = ['development', 'module', 'browser'];
const NO_NETWORK = 'tests/helpers/no-network.ts';

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { conditions: nodeDev },
        ssr: { resolve: { conditions: nodeDev } },
        test: {
          name: 'unit',
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/desktop/src/{main,runner}/**/*.test.ts',
            'apps/desktop/build/**/*.test.ts',
            'tests/evaluations/**/*.test.ts',
          ],
          environment: 'node',
          setupFiles: [NO_NETWORK],
        },
      },
      {
        resolve: { conditions: webDev },
        test: {
          name: 'unit-web',
          include: ['apps/desktop/src/renderer/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['apps/desktop/src/renderer/test-setup.ts'],
        },
      },
      {
        resolve: { conditions: nodeDev },
        ssr: { resolve: { conditions: nodeDev } },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.int.test.ts'],
          environment: 'node',
          setupFiles: [NO_NETWORK],
          testTimeout: 30_000,
          pool: 'forks',
        },
      },
      {
        resolve: { conditions: nodeDev },
        ssr: { resolve: { conditions: nodeDev } },
        test: {
          name: 'live',
          include: ['tests/live/**/*.live.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
        },
      },
    ],
  },
});
