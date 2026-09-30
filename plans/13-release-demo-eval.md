# Plan 13: Release, Demo Reset, Secret Scan, Evaluation Harness, Pitch Docs (Agent M)

Spec: §17.3–17.5, §18.1–18.5, §20.2, §22.1–22.3, §15.5 (M5/M6 checklists) · Backlog: RLY-024, 025, 026, 027 · Waves (00 §3): **Wave 5 / M5** M1–M4 · **Wave 6 / M6** M5–M6, freeze

Files (exclusive): `scripts/**`, `tests/evaluations/**`, `docs/demo/**`, `docs/product/**`, `docs/release/**`

`scripts/_placeholder.ts` (`export {};`) is created once by A (01) so the `scripts` TS project is never empty. M owns it and **deletes it in the same change that adds the first real script** (M1 `verify-package.ts`), since the project is no longer empty after that.

---

## M1: Package & verify (`scripts/verify-package.ts`) — RLY-025
- `pnpm package` (`electron-builder --mac --dir`, 08 §H9) → `apps/desktop/dist/mac-arm64/Relay.app`: an ad-hoc–signed, **not notarized** dir build (no Developer ID).
- `verify-package.ts` checks that:
  - `Relay.app/Contents/Resources/app.asar` exists.
  - `app.asar` contains the bundled runner `out/main/*runner*.js` (uses `@electron/asar` listPackage + extractFile). Migrations are embedded (03 §R4-32), so the check greps that bundle for `CREATE TABLE runs` and for the runtime `node:sqlite` import. There is no migrations directory to check.
  - `sample-api` is in the resources.
  - There are no `.env`, `.sqlite`, or `tests/` in the asar except the sample fixture resource.
  - Fuses: it reads them with `@electron/fuses` `getCurrentFuseWire` and asserts `RunAsNode=disabled` and `OnlyLoadAppFromAsar=enabled`.
  - **Ad-hoc signature (arm64):** `codesign -dv --verbose=2 Relay.app` succeeds and reports `Signature=adhoc` (08 §R4-34). An unsigned arm64 binary would not launch at all.
  - **Smoke launch:** it runs the binary directly (`Relay.app/Contents/MacOS/Relay`) with `RELAY_E2E=1` and `RELAY_USER_DATA_DIR=<temp>` plus a temp `HOME`, waits for `relay.sqlite` (≤ 15 s), and then asserts the same facts `app.getDiagnostics` reports: runner ready, schema version = latest migration, catalog version non-null with ≥ 1 model, and the `review-propose-fix` template v1 seeded with its prompts (a non-empty prompt sha256 for every step). Because Playwright cannot attach to the packaged build (the `nodeCliInspect` fuse is off), the script reads these facts from the seeded DB (read-only `node:sqlite`), which `seedDatabase` (06 F16) fills from the bundled catalog and prompt modules. This proves the statically imported catalog JSON and prompt modules survived bundling. Then it quits the app (SIGTERM → wait for exit).
- `docs/release/unsigned-build.md` explains Gatekeeper warnings for invited testers **without** instructing anyone to disable OS protections (§18.1). It covers right-click → Open for a single app, or notarization later.

## M2: Secret scan & project-untouched checks
- `scripts/check-no-secrets.ts [dir]`:
  - Walks the directory. Default: the e2e userData dir whose path is read from `test-results/last-userdata.txt` (written by 12 §L2 when `RELAY_E2E_KEEP=1`; the script errors if the file is missing and no dir is given), plus `apps/desktop/out` and `apps/desktop/dist`.
  - Opens every `*.sqlite` with `node:sqlite` (read-only) and scans every column of every table listed in `sqlite_master`, and also scans the raw bytes of each `*.sqlite-wal`.
  - Scans logs, artifacts, exports, and asar contents with the contracts `SECRET_PATTERNS` plus the known test keys.
  - Prints `N findings`. Exit code 1 if > 0.
  - Allowlist: the literal marker `sk-fixture-DO-NOT-READ` is allowed **in any path** (the sample `.env` is excluded from bundles anyway, 08 §R2-29, but the marker may appear in fixtures, docs, and test sources). Nothing else is allowlisted; any other match is a finding.
- `scripts/check-project-untouched.ts`: recomputes the fixture tree hash against `.relay-fixture.json` (K1) and fails on any diff.

## M3: Demo reset & verify (`scripts/demo-reset.ts`, `scripts/demo-verify.ts`) — §18.4, §22.2
- **Demo reset = restore a prepared demo userData snapshot.** It does not delete rows, because the ledger and revision tables are immutable by design (03 §C3).
  - The target dir must end in `Relay-Demo`, for example `~/Library/Application Support/Relay-Demo` via `RELAY_USER_DATA_DIR`. This is a separate profile from any real use. The script **refuses any other path**, so it can never erase unrelated user projects (§18.4).
  - Steps:
    1. Quit the app if it is running (checks the single-instance lock).
    2. Move the current demo dir to `Relay-Demo.previous-<ts>` (keep one).
    3. Copy `docs/demo/snapshot/` (DB + artifacts + `samples/`, **never** `secrets/`) into place.
    4. Carry over the existing `secrets/` directory from the previous demo dir, so the Keychain-protected key doesn't need re-entry.
  - `scripts/demo-snapshot.ts` produces the snapshot from a demo dir that has been prepared by hand, then runs `check:secrets` on it. Before copying, it opens the prepared dir with `createRuntime` from `@relay/engine` (fake mode, no dispatch) and asserts the four prepared run states listed below, so a broken snapshot is caught at creation time. Snapshot files under `docs/demo/snapshot/**` are committed through the 01 §R2-4 gitignore negation.
- The prepared snapshot contains:
  1. The sample project with 1 approved rule (§22.2 0:00).
  2. A completed run with a report (the fallback if live is slow).
  3. A budget-blocked run (2:40 segment).
  4. An `interrupted` run checkpointed after Plan (3:10 segment "reopen app and resume").
- `demo-verify.ts` launches the app against the demo dir in fake mode **only for verification**. It asserts each prepared run's state via the diagnostics-free IPC (Playwright-driven, reusing L's fixture) and then prints a checklist. The live demo uses real providers, and each segment is labeled live / prepared / recorded (§22.2).

## M4: Evaluation harness (`tests/evaluations/`, `scripts/evaluate.ts`) — §17.3–17.5, RLY-026
- `tests/evaluations/tasks/*.json`: 6–10 tasks on the sample-api seeded defects and variants, for example `{ id: 'T1-validate-age', goal, input: { kind: 'files', relPaths }, approvedRules: [...], acceptance: [ 'rejects negative age with 400 and {error:{code}} shape', 'no change to public response fields' ] }`. Answers are **not** embedded in the goal (§17.3).
- `tests/evaluations/rubric.md`: a 0–2 scale for correctness, requirement coverage, unintended changes, explanation usefulness, and review effort (minutes). A task is accepted only if the correctness and coverage requirements are met (§17.4).
- `scripts/evaluate.ts --config relay|single-agent --tasks T1,T2 --repeat 2`:
  - Runs headless via `createRuntime({ userDataDir, providerMode: 'live', credentials })` imported from `@relay/engine` (06 F16), the same Electron-free composition root the desktop runner uses, with **live** providers (requires `RELAY_LIVE_TESTS=1`, keys from the script's env only, and a `--cap-usd` hard stop). Scripts run with `tsx --conditions=development`.
  - `single-agent` baseline = one `implementer` step with the same context and rules (§17.3 comparison), implemented as a second template variant `single-step` in **evaluation-only** code under `tests/evaluations/templates/`, not shipped. The `single-agent` config builds a `TemplateRegistry` containing that variant and passes it as `createRuntime({ …, templates: singleStepRegistry })` (06 F16 `RuntimeOptions.templates`), so `seedDatabase` and the engine both use it.
  - Output: `tests/evaluations/results/<date>/<config>/<task>-<n>.json` (run id, costs with certainty, elapsed, artifacts copied) plus `summary.csv`.
  - **Human scoring** is recorded in `scores.csv` by the founder. The script never auto-scores quality (§17.4, §7.7 no self-rating).
  - `scripts/evidence-table.ts` renders the §17.5 table from the scores and results **with the sample size**, and prints "Not yet measured" for empty cells. It never invents numbers (§17.5). The **denominator counts every attempted task run**, including `incomplete`, `failed`, and `cancelled` runs and runs stopped by the cost cap; only acceptance-rated runs count in the numerator. `tests/evaluations/evidence-table.test.ts` runs it against a dry-run fixture results dir (mixed completed/incomplete/failed/cancelled) and asserts the printed `n` and rates.
- The manual workflow baseline (§17.3 "current manual workflow") is recorded by hand in `docs/product/baseline-notes.md` using a template.

## M5: Pitch & operations docs
| File | Content |
|---|---|
| `docs/demo/pitch-script.md` | §22.1 narrative + the §22.2 table with exact clicks per segment, labeled Live / Prepared / Recorded. Claims discipline checklist (§22.3) |
| `docs/demo/recovery-script.md` | What to do if the provider is down (switch to the prepared run and labeled recording), the app crashes (relaunch → interrupted demo), or wifi fails |
| `docs/demo/rehearsal-checklist.md` | M6 checklist (§15.5): demo account/network tested, recording labeled, reset tested twice, battery/sleep disabled, font size |
| `docs/release/checklist.md` | §18.5 items as commands: version/build id visible (`app.getInfo`), `migration.int.test.ts` green, `check:secrets` 0, onboarding e2e green, budget + restart e2e green, demo reset tested, known limitations, package launches, `pnpm licenses list --prod > docs/release/licenses.txt` |
| `docs/release/known-limitations.md` | P0 limits: one OS; no code execution; unknown charges possible; tracked usage ≠ provider bill; local persistence ≠ private inference; unsigned build; no schedules |
| `docs/release/backup-restore.md` | Manual backup and restore steps (03 §C7) |
| `docs/release/flakes.md` | Flake log (12 §L5) |
| `docs/product/interviews/` | Template for §20.1 questions. Notes are nonconfidential |
| `docs/product/pilot-log.md` | §20.2 sessions: date, participant (pseudonym), task, friction, whether they returned |
| `docs/product/m0-status.md` | M0 checklist items, each with a status; interview count to date; the **funder-confirmed** spending cap (recorded only once confirmed, never assumed); the confirmed target OS (00 §1 currently assumes macOS Apple silicon). Reviewed at the M1 gate |

## M6: Fixture database (reference only)
The upgrade fixture `tests/fixtures/databases/v1-populated.sqlite` and its generator `tests/helpers/make-fixture-db.ts` are **K-owned** (11 §K7). M does not own a copy. `docs/release/checklist.md` references `migration.int.test.ts`, which consumes that fixture.

## Success Criteria (gate)
- [ ] `pnpm package && tsx scripts/verify-package.ts` → "package OK"
- [ ] `pnpm check:secrets` (default dir from `test-results/last-userdata.txt` after `RELAY_E2E_KEEP=1 pnpm e2e`) → "0 findings". `pnpm check:project-untouched` → "OK"
- [ ] `pnpm demo:reset && pnpm demo:verify` → all prepared states verified, run twice in a row (idempotent)
- [ ] `tsx scripts/evaluate.ts --dry-run --tasks all` → validates the task files and prints the planned calls with an estimated cost upper bound (no spend)
- [ ] `evidence-table.test.ts` green: the denominator includes incomplete, failed, and cancelled runs
- [ ] `docs/product/m0-status.md` exists and was reviewed at the M1 gate
- [ ] `docs/release/checklist.md` items all checked for the M5 build

## Review Checklist
- [ ] Demo reset refuses any non-demo path
- [ ] No evaluation number appears in the docs without a results file behind it
- [ ] Every pitch claim is in the allowed list or backed by `evidence-table.ts` output (§22.3)
- [ ] The unsigned build doc does not tell users to disable OS protections
- [ ] `verify-package` checks the ad-hoc signature and that the catalog and prompts load in the packaged build
- [ ] Evaluation and demo scripts compose only through `createRuntime` from `@relay/engine`
- [ ] The secret-scan allowlist is exactly the literal `sk-fixture-DO-NOT-READ` marker
- [ ] Evidence-table rates use all attempted runs as the denominator
- [ ] `m0-status.md` records the spending cap only as funder-confirmed
