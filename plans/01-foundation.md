# Plan 01: Foundation — Monorepo, Tooling, Boundaries, CI (Agent A)

Spec: §13.1, §13.4, §13.5, §24.1 · Backlog: RLY-003 · Wave (00 §3): **Wave 0 / M1** A all (first 1–2 sessions)

Files (exclusive): `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `tsconfig.tools.json`, `scripts/tsconfig.json`, `eslint.config.js`, `.dependency-cruiser.cjs`, `vitest.config.ts`, `.gitignore`, `.editorconfig`, `.prettierrc.json`, `.nvmrc`, `.npmrc`, `.env.example`, `README.md`, `.github/workflows/ci.yml`, `docs/adr/*.md`, `docs/architecture/*.md` (including the generated `ipc-api.md`, R2-36), `packages/*/package.json`, `packages/*/tsconfig.json`, `apps/desktop/package.json`, `apps/desktop/tsconfig*.json`, `tests/package.json`, `tests/tsconfig.json` (R2-34)

One-time placeholders (created once by A, owned afterwards by the named agent): `tests/helpers/no-network.ts` (→ K), `scripts/_placeholder.ts` (→ M, which deletes it when the first real script lands).

Precondition: repository is not yet a git repo. A0 initializes it.

## Tasks

### A0: Initialize repository
- `git init -b main`. Add `.gitignore` first (A1) and then commit the spec and `plans/`.
- `.nvmrc`: `24` (Electron 44 bundles Node 24.21; local Node must match major for `node:sqlite` parity).
- `.npmrc`: `engine-strict=true`, `auto-install-peers=true`, `strict-peer-dependencies=false`, `node-linker=isolated`.

### A1: Root files

`.gitignore` (negations come last so they win; R2-4):
```
node_modules/
out/
dist/
coverage/
playwright-report/
test-results/
.tsbuild/
*.tsbuildinfo
*.sqlite
*.sqlite-wal
*.sqlite-shm
.env
.env.*
!.env.example
.DS_Store
tmp/
.userdata*/

# Committed fixtures and demo snapshot (R2-4). The fixture .env holds only an obviously fake marker (sk-fixture-DO-NOT-READ…).
!tests/fixtures/sample-api/.env
!tests/fixtures/sample-api/node_modules/
!tests/fixtures/sample-api/dist/
!tests/fixtures/databases/*.sqlite
!docs/demo/snapshot/**
```
The negations re-include paths whose **own** name matched an ignore rule (their parent directories are not ignored), so git honors them. The `link-outside` symlink in the fixture is created at test time, not committed (11).

`.env.example` (names only, **no values**; spec §13.1):
```
# Development-only overrides. Real API keys are entered in the app and stored with OS protection.
RELAY_USER_DATA_DIR=            # dev/e2e only: isolated userData directory (ignored in packaged builds unless RELAY_E2E=1)
RELAY_PROVIDER_MODE=            # "live" (default) | "fake"
RELAY_FAKE_SCENARIO=            # fake provider script name, e.g. happy-path
RELAY_LIVE_TESTS=               # "1" enables pnpm test:live (spends real money, capped)
RELAY_LIVE_TEST_CAP_MICROUSD=100000       # $0.10 cap for the connection smokes
RELAY_LIVE_WORKFLOW_CAP_MICROUSD=1500000  # $1.50 cap for the live workflow smoke (04 D9b)
RELAY_E2E=                      # dev/e2e only: "1" enables e2e-only paths (RELAY_USER_DATA_DIR in packaged builds, crash hooks); never set in normal use
RELAY_CRASH_AT=                 # dev/e2e only: crash-hook spec parsed by parseCrashAt (06 F13); inert unless RELAY_E2E=1
RELAY_E2E_KEEP=                 # dev/e2e only: "1" keeps the e2e userData dir and writes test-results/last-userdata.txt for check:secrets
ANTHROPIC_API_KEY=              # ONLY read by pnpm test:live, never by the app
OPENAI_API_KEY=                 # ONLY read by pnpm test:live, never by the app
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "tests"
```

### A2: Root `package.json` scripts (spec §13.5)

```jsonc
{
  "name": "relay",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.x",           // pin exact at bootstrap
  "engines": { "node": ">=24.0.0 <25" },
  "scripts": {
    "dev": "pnpm --filter @relay/desktop dev",
    "dev:renderer": "pnpm --filter @relay/desktop dev:renderer",  // renderer on fake bridge only (R2-37)
    "build": "pnpm -r --filter ./packages/** build && pnpm --filter @relay/desktop build",
    "typecheck": "tsc -b tsconfig.json",
    "lint": "eslint . --max-warnings 0 && depcruise apps packages --config .dependency-cruiser.cjs",
    "format": "prettier --write .",
    "test:unit": "vitest run --project unit --project unit-web",   // R2-37
    "test:integration": "vitest run --project integration",
    "test:live": "vitest run --project live",
    "test": "pnpm test:unit && pnpm test:integration",
    "e2e": "pnpm build && PLAYWRIGHT_HTML_OPEN=never playwright test",   // R2-37: never blocks on the HTML report
    "test:e2e": "pnpm e2e",                                               // alias (R3-35)
    "gen:api-doc": "pnpm --silent --filter @relay/contracts gen:api-doc > docs/architecture/ipc-api.md",  // R2-36
    "evaluate": "tsx scripts/evaluate.ts",
    "package": "pnpm build && pnpm --filter @relay/desktop package",
    "demo:reset": "tsx scripts/demo-reset.ts",
    "demo:verify": "tsx scripts/demo-verify.ts",
    "check:secrets": "tsx scripts/check-no-secrets.ts",
    "check:project-untouched": "tsx scripts/check-project-untouched.ts"
  }
}
```

Root devDependencies: `typescript`, `tsx`, `@types/node` (24.x; for `tsconfig.tools.json` and `scripts/`), `vitest`, `@vitest/coverage-v8`, `fast-check`, `eslint`, `typescript-eslint`, `eslint-plugin-boundaries`, `eslint-plugin-react`, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, `eslint-plugin-playwright` (R2-37), `dependency-cruiser`, `prettier`, `@playwright/test`, `@axe-core/playwright`. The root has **no** `electron` dependency (R4-13; see A3).

### A3: Package skeletons (`package.json` + `tsconfig.json` each; `src/index.ts` stub is created by the owning agent)

| Package | name | deps (runtime) | notes |
|---|---|---|---|
| `packages/contracts` | `@relay/contracts` | `zod` | **no** node/electron/provider runtime deps. `"sideEffects": false`. devDeps: `@types/node` (used only by `src/scripts/**`). Script `gen:api-doc: tsx src/scripts/gen-api-doc.ts` prints the IPC reference to stdout (R2-36, 02 §B10) |
| `packages/storage` | `@relay/storage` | `@relay/contracts` | uses `node:sqlite` (built-in). Migrations are embedded TS modules under `migrations/` (03, R4-32), so `tsconfig.json` includes `src` **and** `migrations`; nothing is copied at build |
| `packages/providers` | `@relay/providers` | `@relay/contracts`, `@anthropic-ai/sdk`, `openai` | catalog and fake fixtures are statically imported JSON (`resolveJsonModule`; tsconfig includes `catalog/**/*.json` and `src/**/*.json`) |
| `packages/tools` | `@relay/tools` | `@relay/contracts`, `picomatch`, `ignore`, `diff` | |
| `packages/templates` | `@relay/templates` | `@relay/contracts`, `zod` | tsconfig includes `src` **and** `review-propose-fix` (prompts are `.ts` modules, `workflow.json` is a JSON import; R2-20) |
| `packages/engine` | `@relay/engine` | `@relay/contracts`, `@relay/templates` | **devDependencies** `@relay/storage`, `@relay/providers`, `@relay/tools` (R2-2), plus matching tsconfig project references. Engine runtime code imports them **type-only**; implementations are injected (§13.4). Exceptions: tests, `src/testing/**`, and the Electron-free composition root `src/runtime.ts` (06 F16) may value-import storage, providers, tools, and templates (lint override in A5). Consumers of `createRuntime` (desktop, tests) depend on all packages directly, so the devDependency edge suffices |
| `apps/desktop` | `@relay/desktop` | all of the above + `react`, `react-dom`, `react-router`, `@tanstack/react-query`, `@tanstack/react-virtual`, `@radix-ui/react-*`, `lucide-react`, `react-markdown`, `@fontsource/fira-sans`, `@fontsource/fira-code` | dev: `electron` (R4-13: a devDependency here only; the root keeps no electron), `electron-vite`, `vite@7`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`, `electron-builder`, `@testing-library/react`, `@testing-library/user-event`, `vitest-axe`, `jsdom`. `"main": "out/main/index.js"` (12 R4-19) |
| `tests` | `@relay/tests` | — | `"private": true`. devDeps: every `@relay/*` package except desktop (`workspace:*`) and `tsx` (R4-18). Holds integration/e2e/live/evaluations |

Every package `package.json` has `"type": "module"`, `"exports": { ".": { "development": "./src/index.ts", "types": "./dist/index.d.ts", "import": "./dist/index.js" } }`: the `"development"` condition comes first so Vitest (A7) and tsx (`--conditions=development`) run from source without prebuilding, and bundles and `tsc` use `dist`.

Per-package scripts: `build: tsc -b`. There is no per-package `test` script: tests run from the root `vitest.config.ts` projects (A7).

`apps/desktop/package.json` scripts (requested by 08 §H9; R2-37):
```jsonc
{
  "dev": "electron-vite dev",
  "dev:renderer": "vite --config vite.renderer.config.ts",   // renderer-only dev server on the fake bridge; config owned by H (08)
  "build": "electron-vite build",
  "package": "electron-builder --mac --dir"
}
```

**Forked Node children in tests (R4-18).** Any child process or worker that runs TypeScript from source (K's crash-harness child, the contention test's workers, M's scripts when forked) is started with `execArgv: ['--import', 'tsx', '--conditions=development']`, so it resolves workspace packages to `src/` exactly like Vitest does.

### A4: TypeScript project references
- `tsconfig.base.json` exactly as in [00b §2.1](00b-engineering-standards.md).
- Root `tsconfig.json`: `{ "files": [], "references": [ contracts, storage, providers, tools, templates, engine, apps/desktop/tsconfig.node.json, apps/desktop/tsconfig.web.json, tests, scripts, tsconfig.tools.json ] }` (R2-31).
- `packages/engine/tsconfig.json` references contracts, templates, storage, providers, and tools (R2-2).
- `apps/desktop/tsconfig.node.json` covers `src/main`, `src/preload`, `src/runner`, `electron.vite.config.ts`, `vite.renderer.config.ts`, and `build/**` (Node + Electron types).
- `apps/desktop/tsconfig.web.json` covers `src/renderer` (DOM types, **no** `@types/node`, `jsx: react-jsx`, `moduleResolution: Bundler`).
- `tests/tsconfig.json`: extends the base, `types: ["node"]`, `include: ["**/*.ts"]`, `exclude: ["fixtures/**"]` (R2-31; the sample-api fixture is its own tiny project and must not be typechecked or linted as Relay code), references every package, `outDir: ".tsbuild"`.
- `scripts/tsconfig.json`: extends the base, `types: ["node"]`, `include: ["**/*.ts"]`, references the packages the scripts import, `outDir: ".tsbuild"`. A creates `scripts/_placeholder.ts` (`export {};`) so the project is never empty (TS18003) before M adds scripts.
- `tsconfig.tools.json` (root): extends the base, `types: ["node"]`, `include: ["vitest.config.ts", "playwright.config.ts"]`, `outDir: ".tsbuild/tools"`. It gives the root config files a project for `tsc -b` and for ESLint's `projectService`. (`playwright.config.ts` is L-owned and appears later; `include` tolerates its absence.)
- Composite projects referenced by `tsc -b` must emit, so non-package projects emit to `.tsbuild/` (gitignored) instead of using `noEmit`.

### A5: ESLint flat config with import boundaries (gate for §13.4)

`eslint.config.js` essentials:

```js
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

export default tseslint.config(
  { ignores: ['**/dist/**', '**/out/**', '**/.tsbuild/**', 'coverage/**', 'playwright-report/**', 'test-results/**',
              'plans/**', 'tests/fixtures/**'] },                                  // R2-31
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'contracts', pattern: 'packages/contracts/**' },
        { type: 'storage',   pattern: 'packages/storage/**' },
        { type: 'providers', pattern: 'packages/providers/**' },
        { type: 'tools',     pattern: 'packages/tools/**' },
        { type: 'templates', pattern: 'packages/templates/**' },
        { type: 'engine',    pattern: 'packages/engine/**' },
        { type: 'main',      pattern: 'apps/desktop/src/main/**' },
        { type: 'preload',   pattern: 'apps/desktop/src/preload/**' },
        { type: 'runner',    pattern: 'apps/desktop/src/runner/**' },
        { type: 'renderer',  pattern: 'apps/desktop/src/renderer/**' },
      ],
    },
    rules: {
      'boundaries/element-types': ['error', { default: 'disallow', rules: [
        { from: 'contracts', allow: [] },
        { from: ['storage', 'providers', 'tools', 'templates'], allow: ['contracts'] },
        { from: 'engine',   allow: ['contracts', 'templates', 'storage', 'providers', 'tools'] }, // type-only enforced below
        { from: 'runner',   allow: ['contracts', 'storage', 'providers', 'tools', 'templates', 'engine'] },
        { from: 'main',     allow: ['contracts'] },            // main never imports engine/storage/providers (§6.3)
        { from: 'preload',  allow: ['contracts'] },
        { from: 'renderer', allow: ['contracts'] },            // §13.4: renderer depends only on contracts + UI
      ]}],
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
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.strict.rules,
      'react/no-danger': 'error',
      'no-restricted-imports': ['error', { patterns: [
        PUBLIC_API_ONLY,
        { group: ['node:*', 'electron', 'fs', 'path', 'child_process'], message: 'Renderer must not import Node/Electron (§6.3).' },
        { group: ['@anthropic-ai/*', 'openai'], message: 'Provider SDKs never enter the renderer (§13.4).' },
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
```

### A6: dependency-cruiser (CI whole-graph check)

`.dependency-cruiser.cjs` forbidden rules:
- `no-circular` (severity error).
- `renderer-no-node`: from `^apps/desktop/src/renderer` to `^(node:|electron$|fs$|path$)` or `node_modules/(openai|@anthropic-ai)`.
- `sqlite-only-in-storage`: from anything not `^packages/storage` to `^node:sqlite$`.
- `electron-only-in-host`: from `^packages/` to `^electron$`.
- `sdk-only-in-providers`: from not `^packages/providers` to `node_modules/(openai|@anthropic-ai)`.
- `no-orphans` (warn).

### A7: Vitest projects (`vitest.config.ts`)

The workspace file was removed in Vitest 4, so the root `vitest.config.ts` declares `test.projects` (R2-30). `resolve` is a **top-level** (Vite) key of each project, never inside `test` (R4-17), and every project resolves workspace packages through the `"development"` condition.

```ts
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
          include: ['packages/*/src/**/*.test.ts', 'apps/desktop/src/{main,runner}/**/*.test.ts', 'apps/desktop/build/**/*.test.ts', 'tests/evaluations/**/*.test.ts'],
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
```

`test:unit` runs both `unit` and `unit-web` (A2).

`tests/helpers/no-network.ts` is owned by K. A creates an empty placeholder (`export {};`) that K replaces. **Ownership note:** A creates it once, and K owns it afterwards; this is recorded in K's plan.

### A8: CI (`.github/workflows/ci.yml`)
Jobs:
1. `check` on `macos-14` (target OS): checkout → pnpm setup → `actions/setup-node` (node-version-file `.nvmrc`) → `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm lint` → `pnpm test:unit -- --coverage` → `pnpm test:integration` → **API doc** (R2-36): `pnpm gen:api-doc` writes `docs/architecture/ipc-api.md`, then `git diff --exit-code docs/architecture/ipc-api.md` fails the job if the committed reference is stale. (Before B10 exists the step is skipped via `if: hashFiles('packages/contracts/src/scripts/gen-api-doc.ts') != ''`.)
2. `e2e` (needs check, `macos-14`): `pnpm e2e` with `RELAY_PROVIDER_MODE=fake`; upload `playwright-report/` and traces on failure.
3. `audit` (non-blocking): `pnpm audit --prod --audit-level high`.
CI never has provider keys; `test:live` is not run in CI.

### A9: Docs scaffolding
- `README.md`: What Relay is (spec §1 one paragraph), prototype limitations (spec §3.1 P0, §6.2 boundary: "local persistence does not make remote inference private"), setup commands, scripts table (A2, including `dev:renderer`, `test:e2e`, and `gen:api-doc`), demo instructions pointer to `docs/demo/`.
- `docs/adr/0001-desktop-first.md` … `0010-scheduling-after-pitch.md` from spec §24.1 table, and `0011`–`0018` from [00 §7](00-overview.md). Format: Title, Status (Accepted 2026-09-30), Context, Decision, Consequences, Revisit when.
- `docs/architecture/overview.md`: copies spec §6.2 diagram and adds the process/IPC diagram from [02 §B1](02-contracts-api-layer.md).
- `docs/architecture/ipc-api.md`: generated only, by `pnpm gen:api-doc` (A2/A8); never hand-edited.

## Success Criteria (gate)

- [ ] `pnpm install --frozen-lockfile` exits 0 (after a first `pnpm install` generates and commits the lockfile)
- [ ] `pnpm typecheck` exits 0 with every package containing only `src/index.ts` (`export {}`); the build graph includes `tests`, `scripts/tsconfig.json`, and `tsconfig.tools.json`
- [ ] `pnpm lint` exits 0 (including `vitest.config.ts`, `eslint.config.js`, and `.dependency-cruiser.cjs`)
- [ ] `pnpm test:unit` exits 0 (`--passWithNoTests` allowed only in this plan); `vitest list --project unit --project unit-web --project integration --project live` shows all four projects loaded from `vitest.config.ts` (no `vitest.workspace.ts` exists)
- [ ] Boundary proof: add a temporary file `apps/desktop/src/renderer/_probe.ts` with `import 'node:fs'` and confirm `pnpm lint` **fails** with the §6.3 message, then delete it. Record the output in the commit message.
- [ ] Engine boundary proof: `packages/engine/src/_probe.ts` with `import { openDb } from '@relay/storage'` (value import) fails lint. Delete it afterwards.
- [ ] Engine override proof (R2-2): the same value import in `packages/engine/src/_probe.test.ts` **passes** lint, and `import 'node:sqlite'` in it still fails. Delete it afterwards.
- [ ] Gitignore proof (R2-4): after creating empty stand-ins, `git check-ignore -v tests/fixtures/sample-api/.env tests/fixtures/sample-api/node_modules/x tests/fixtures/sample-api/dist/x tests/fixtures/databases/a.sqlite docs/demo/snapshot/a.sqlite` reports none of them as ignored; delete the stand-ins.
- [ ] `pnpm --filter @relay/desktop run` lists `dev`, `dev:renderer`, `build`, and `package`; root `pnpm run` lists `test:e2e` and `gen:api-doc`.
- [ ] `git log --oneline` shows `plan-01: foundation`

## Testing Requirements
- Command: `pnpm typecheck && pnpm lint && pnpm test:unit`
- Expected: exit 0. The two negative probes fail lint and the override probe passes, as described.

## Review Checklist
- [ ] No file outside A's ownership list was created (except the documented `tests/helpers/no-network.ts` and `scripts/_placeholder.ts` placeholders)
- [ ] `.env.example` contains no values for keys
- [ ] Node major in `.nvmrc` matches Electron's bundled Node major (24)
- [ ] ADR 011–018 present and consistent with 00 §7
- [ ] `vitest.config.ts` uses `test.projects`; every project has top-level `resolve.conditions` including `'development'` (none inside `test`)
- [ ] ESLint `ignores` contain `plans/**` and `tests/fixtures/**`; the engine override covers exactly `src/**/*.test.ts`, `src/testing/**`, and `src/runtime.ts`; `tests/e2e/**` enables `playwright/no-wait-for-timeout`
- [ ] `.gitignore` negations are present and listed after the patterns they override
- [ ] `packages/engine/package.json` lists storage/providers/tools as **devDependencies** with matching tsconfig references; `electron` appears only in `apps/desktop` devDependencies
- [ ] `tests/package.json` devDependencies include `tsx`; `tests/tsconfig.json` excludes `fixtures/**`
- [ ] `packages/contracts/package.json` has `gen:api-doc`, and CI writes and drift-checks `docs/architecture/ipc-api.md`
