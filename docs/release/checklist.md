# Release checklist (spec §18.5, plan 13 §M5)

Run this for every build you give to anyone, starting with the M5 build. Every item names its command. Tick an item only when the command's output matches the expected line, and paste that output into the release notes.

Build: `__________` · Date: `__________` · By: `__________`

| # | §18.5 item | Command | Expected |
|---|---|---|---|
| 1 | Version and build identifier visible | Launch the build → **Settings → About** (`app.getInfo`) | version + build id shown, matching this sheet |
| 2 | Database migration tested from the previous pilot version | `pnpm test:integration -- tests/integration/migration.int.test.ts` | green (it consumes `tests/fixtures/databases/v1-populated.sqlite`, K-owned, 11 §K7) |
| 3 | Credentials excluded from artifacts and logs | `RELAY_E2E_KEEP=1 pnpm e2e` then `pnpm check:secrets` | `0 findings` |
| 3b | Sample project untouched by every workflow | `pnpm check:project-untouched` | `OK` |
| 4 | Fresh project onboarding tested | `PLAYWRIGHT_HTML_OPEN=never pnpm exec playwright test tests/e2e/specs/onboarding.spec.ts` | green |
| 5 | Budget exhaustion and restart recovery tested | `PLAYWRIGHT_HTML_OPEN=never pnpm exec playwright test tests/e2e/specs/budget-pause.spec.ts tests/e2e/specs/restart-recovery.spec.ts` | green |
| 6 | Demo fixture reset tested | `RELAY_USER_DATA_DIR="$HOME/Library/Application Support/Relay-Demo" pnpm demo:reset && pnpm demo:verify`, **twice in a row** | `demo:verify OK` both times |
| 7 | Known limitations documented | review `docs/release/known-limitations.md` against this build | reviewed, up to date |
| 8 | Chosen OS package launches | `pnpm package && pnpm exec tsx --conditions=development scripts/verify-package.ts` | `package OK` (macOS arm64, ad-hoc signature, fuses, catalog + prompts seeded) |
| 9 | Third-party licenses recorded before distribution | `pnpm licenses list --prod > docs/release/licenses.txt` | file regenerated and reviewed for this build |

Also, every time:

- [ ] `pnpm typecheck && pnpm lint && pnpm test` is green.
- [ ] `docs/release/flakes.md` has no open entry (12 §L5: a flake must be fixed before the M6 freeze).
- [ ] A backup of the tester's previous data was taken before upgrading (`docs/release/backup-restore.md`).
- [ ] Testers receive `docs/release/unsigned-build.md` together with the build.
- [ ] No claim in the release notes goes beyond `docs/demo/pitch-script.md` → Claims discipline.

## M5 build

| # | Result | Output / note |
|---|---|---|
| 1 | [ ] | |
| 2 | [ ] | |
| 3 | [ ] | |
| 3b | [ ] | |
| 4 | [ ] | |
| 5 | [ ] | |
| 6 | [ ] | |
| 7 | [ ] | |
| 8 | [ ] | |
| 9 | [ ] | |
