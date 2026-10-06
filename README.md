# Relay

Relay is a local desktop application for individual developers and small software teams that already use AI for software work. It runs one repeatable workflow (review a selected change, plan a fix, propose a patch, review the patch) across two AI API providers. The application, not the model, owns workflow state, budget accounting, checkpoints, approved project memory, and artifacts. The product promise: **run repeatable AI work with persistent project context, visible spending, and clear human control.**

The full product and engineering specification is [`Relay_Product_and_Engineering_Plan.md`](Relay_Product_and_Engineering_Plan.md). The implementation plan is in [`plans/`](plans/00-overview.md).

## Prototype limitations (P0)

This is a pitch prototype, not a product. The P0 scope (spec §3.1) is:

- one the desktop OS (macOS on Apple silicon);
- two API providers (Anthropic and OpenAI), with Gemini as an optional third adapter;
- one fixed workflow template, with a model chosen per role;
- local approved memory, a usage ledger, iteration limits, approvals, checkpoints, and an exportable patch and report.

Relay never writes to your project's source files. Patches are artifacts that you export and apply yourself. There are no schedules, no visual workflow canvas, no arbitrary workflow structure, and no shell execution.

**Local persistence does not make remote inference private or offline** (spec §6.2). Project context leaves your machine only through the provider calls you configure, and the providers you select determine where that context is processed. There is no Relay-hosted backend.

You bring your own API keys. Keys are entered in the app and stored with OS protection (Electron `safeStorage`). They are never written to `.env`, logs, exports, or the database.

## Setup

Requirements: macOS (Apple silicon), Node 24 (see `.nvmrc`), pnpm 10 (pinned in `package.json` `packageManager`).

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm dev            # launch the desktop app (electron-vite)
```

`.env.example` lists the development-only environment variables. It holds names only, never key values.

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Launch the desktop app in development mode (electron-vite) |
| `pnpm dev:renderer` | Serve the renderer alone in a browser on the fake bridge (no Electron) |
| `pnpm build` | Build every package, then the desktop app into `apps/desktop/out/` |
| `pnpm typecheck` | `tsc -b` across every project reference |
| `pnpm lint` | ESLint (including layer-boundary rules) and dependency-cruiser; zero warnings allowed |
| `pnpm format` | Prettier over the repository |
| `pnpm test:unit` | Vitest `unit` (Node) and `unit-web` (jsdom) projects |
| `pnpm test:integration` | Vitest `integration` project (cross-package suites, crash matrix) |
| `pnpm test:live` | Live provider smokes. Spends real money, capped; requires `RELAY_LIVE_TESTS=1`. Never run in CI |
| `pnpm test` | `test:unit` then `test:integration` |
| `pnpm e2e` | Build, then run the Playwright-Electron suite on the fake provider |
| `pnpm test:e2e` | Alias for `pnpm e2e` |
| `pnpm gen:api-doc` | Regenerate `docs/architecture/ipc-api.md` from the contracts IPC catalog |
| `pnpm evaluate` | Run the evaluation harness (`scripts/evaluate.ts`) |
| `pnpm package` | Build, then package the macOS app with electron-builder (unpacked `dir` target) |
| `pnpm demo:reset` / `pnpm demo:verify` | Reset and verify the demo state |
| `pnpm check:secrets` | Scan a post-e2e userData directory for plaintext secrets |
| `pnpm check:project-untouched` | Prove the sample project fixture was not modified |

## Repository layout

```
apps/desktop/        Electron main, preload, runner, and React renderer
packages/contracts   Shared types, Zod schemas, IPC catalog (the only package every layer may import)
packages/storage     SQLite (node:sqlite) driver, migrations, repositories
packages/providers   Provider adapters (Anthropic, OpenAI, Gemini, Fake) and the model catalog
packages/tools       Root-confined file access, diff intake, artifact store
packages/templates   The review-propose-fix workflow template and prompts
packages/engine      Run/step state machines, checkpoints, budget ledger, policy, recovery
tests/               Integration, e2e, live, and evaluation suites plus fixtures
scripts/             Demo, release, and verification scripts
docs/                ADRs, architecture, product, demo, and release docs
```

Layer rules (spec §13.4) are enforced by `pnpm lint`. See [`docs/architecture/overview.md`](docs/architecture/overview.md) and the ADRs in [`docs/adr/`](docs/adr/).

## Demo

Demo instructions and the rehearsal checklist live in [`docs/demo/`](docs/demo/).
