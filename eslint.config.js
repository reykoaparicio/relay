import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import playwright from 'eslint-plugin-playwright';

// A later block's `no-restricted-imports` replaces an earlier one, so every override repeats this pattern.
const PUBLIC_API_ONLY = { group: ['@relay/*/src/*', '@relay/*/dist/*'], message: 'Import package public API only.' };
const ENGINE_BANNED_PATHS = ['electron', 'node:sqlite'];
const typeOnly = (name) => ({ name, allowTypeImports: true, message: 'engine: type-only import; inject implementation' });

/** Boundary policy (§13.4): `from` element may import only the listed element types. */
const allow = (from, to) => ({
  from: { element: { types: { anyOf: [from].flat() } } },
  allow: { to: { element: { types: { anyOf: to } } } },
});

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/.tsbuild/**',
      '**/node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'plans/**',
      'tests/fixtures/**', // R2-31
      '.claude/**',
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        // Resolves @relay/* through the workspace symlinks to src/ (the "development" export condition).
        typescript: {
          alwaysTryTypes: true,
          conditionNames: ['development', 'types', 'import', 'node', 'default'],
          project: 'tsconfig.json',
        },
      },
      'boundaries/elements': [
        { type: 'contracts', pattern: 'packages/contracts/**', partialMatch: false },
        { type: 'storage', pattern: 'packages/storage/**', partialMatch: false },
        { type: 'providers', pattern: 'packages/providers/**', partialMatch: false },
        { type: 'tools', pattern: 'packages/tools/**', partialMatch: false },
        { type: 'templates', pattern: 'packages/templates/**', partialMatch: false },
        { type: 'engine', pattern: 'packages/engine/**', partialMatch: false },
        { type: 'main', pattern: 'apps/desktop/src/main/**', partialMatch: false },
        { type: 'preload', pattern: 'apps/desktop/src/preload/**', partialMatch: false },
        { type: 'runner', pattern: 'apps/desktop/src/runner/**', partialMatch: false },
        { type: 'renderer', pattern: 'apps/desktop/src/renderer/**', partialMatch: false },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            // Files inside one element may import each other; npm and Node core modules are policed by
            // no-restricted-imports and dependency-cruiser instead.
            { allow: { dependency: { relationship: { to: 'internal' } } } },
            { allow: { to: { module: { origin: '{external,core}' } } } },
            // contracts imports no other element.
            allow(['storage', 'providers', 'tools', 'templates'], ['contracts']),
            allow('engine', ['contracts', 'templates', 'storage', 'providers', 'tools']), // type-only enforced below
            allow('runner', ['contracts', 'storage', 'providers', 'tools', 'templates', 'engine']),
            allow('main', ['contracts']), // main never imports engine/storage/providers (§6.3)
            allow('preload', ['contracts']),
            allow('renderer', ['contracts']), // §13.4: renderer depends only on contracts + UI
          ],
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-imports': ['error', { patterns: [PUBLIC_API_ONLY] }],
    },
  },
  {
    // Plain JS/CJS config files (eslint.config.js, .dependency-cruiser.cjs) belong to no tsconfig.
    ...tseslint.configs.disableTypeChecked,
    files: ['**/*.{js,cjs,mjs}'],
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    // @relay/contracts has no Node/Electron runtime dependency (02). Only its build-time scripts may use Node.
    files: ['packages/contracts/src/**'],
    ignores: ['packages/contracts/src/scripts/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        PUBLIC_API_ONLY,
        { group: ['node:*', 'electron', 'fs', 'path', 'child_process'], message: 'contracts must stay Node/Electron-free (02).' },
      ]}],
    },
  },
  {
    files: ['packages/engine/**'],
    rules: {
      // engine may only import TYPES from storage/providers/tools; implementations are injected (§13.4)
      '@typescript-eslint/no-restricted-imports': ['error', { paths: [
        typeOnly('@relay/storage'), typeOnly('@relay/providers'), typeOnly('@relay/tools'),
      ]}],
      'no-restricted-imports': ['error', { paths: ENGINE_BANNED_PATHS, patterns: [PUBLIC_API_ONLY] }],
    },
  },
  {
    // R2-2: tests, the test harness, and the Electron-free composition root (06 F16) may value-import
    // storage/providers/tools/templates. electron and node:sqlite stay banned (rule above still applies).
    files: ['packages/engine/src/**/*.test.ts', 'packages/engine/src/testing/**', 'packages/engine/src/runtime.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': 'off' },
  },
  {
    // R2-2: the barrel never exports the test harness/fakes. The only testing export is the crash-hook
    // parser (R2-35 / R4-11), which H and K import from @relay/engine and which has no test-only deps.
    files: ['packages/engine/src/index.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: ENGINE_BANNED_PATHS, patterns: [
        PUBLIC_API_ONLY,
        { group: ['./testing/*', '!./testing/crash-hooks.js'], message: 'engine barrel must not export src/testing/** (R2-2).' },
      ]}],
    },
  },
  {
    files: ['apps/desktop/src/renderer/**'],
    plugins: { react, 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    settings: { react: { version: '19.3' } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.strict.rules,
      'react/no-danger': 'error',
      'no-restricted-imports': ['error', { patterns: [
        PUBLIC_API_ONLY,
        { group: ['node:*', 'electron', 'fs', 'path', 'child_process'], message: 'Renderer must not import Node/Electron (§6.3).' },
        { group: ['@anthropic-ai/*', 'openai', '@google/genai'], message: 'Provider SDKs never enter the renderer (§13.4).' },
      ]}],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'tests/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    // R2-37: E2E specs never sleep; wait on locators/events instead.
    ...playwright.configs['flat/recommended'],
    files: ['tests/e2e/**'],
    rules: { ...playwright.configs['flat/recommended'].rules, 'playwright/no-wait-for-timeout': 'error' },
  },
);
