import { defineConfig } from '@playwright/test';

// 12 §L1: drives the unpackaged Electron build (apps/desktop/out) through tests/e2e/fixtures.ts.
// One Electron at a time: deterministic, no userData contention.
export default defineConfig({
  testDir: 'tests/e2e/specs',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' },
  outputDir: 'test-results',
});
