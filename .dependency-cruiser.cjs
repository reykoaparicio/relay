/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make layering and initialization order unpredictable.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'renderer-no-node',
      severity: 'error',
      comment: 'Renderer must not import Node/Electron or provider SDKs (§6.3, §13.4).',
      from: { path: '^apps/desktop/src/renderer' },
      to: {
        // dependency-cruiser strips `node:`, so match Node built-ins by dependency type (F6 audit fix).
        dependencyTypes: ['core'],
      },
    },
    {
      name: 'renderer-no-electron-or-sdk',
      severity: 'error',
      comment: 'Renderer must not import Electron or provider SDKs (§6.3, §13.4).',
      from: { path: '^apps/desktop/src/renderer' },
      to: { path: ['^electron$', 'node_modules/electron/', 'node_modules/openai/', 'node_modules/@anthropic-ai/', 'node_modules/@google/genai/'] },
    },
    {
      name: 'sqlite-only-in-storage',
      severity: 'error',
      comment: 'Only @relay/storage talks to SQLite (00b §3).',
      from: { pathNot: '^packages/storage' },
      to: { path: '^node:sqlite$' },
    },
    {
      name: 'electron-only-in-host',
      severity: 'error',
      comment: 'Packages are Electron-free so a headless runner can reuse them (§6.1).',
      from: { path: '^packages/' },
      to: { path: ['^electron$', 'node_modules/electron/'] },
    },
    {
      name: 'sdk-only-in-providers',
      severity: 'error',
      comment: 'Provider SDKs are wrapped by @relay/providers only (§13.4).',
      from: { pathNot: '^packages/providers' },
      to: { path: 'node_modules/(openai|@anthropic-ai|@google/genai)' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Modules nothing imports are usually dead code.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$',
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(index|main)\\.(ts|tsx)$',
          '\\.test\\.(ts|tsx)$',
          '(^|/)(electron\\.vite|vite\\.renderer)\\.config\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|out|\\.tsbuild|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['development', 'import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.tsx', '.d.ts', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
