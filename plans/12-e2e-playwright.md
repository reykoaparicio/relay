# Plan 12: End-to-End Tests with Playwright + Electron (Agent L)

Spec: §17.2 ("small desktop end-to-end suite covering setup, approval, completion, pause, restart, and export"), §3.3, §5.7, §6.4 (responsiveness), FR-01…FR-12 · Skill: **playwright-cli** (running and debugging tests) · Waves (00 §3): **Wave 1 / M1** L1–L3 + `@m1` specs · **Wave 3 / M3** `@m3` specs · **Wave 4 / M4** `@m4` specs · **Wave 5 / M5** all specs + `@a11y`

Files (exclusive): `playwright.config.ts`, `tests/e2e/**`

The suite drives the **unpackaged build** through Playwright's `_electron.launch()`: the Electron binary installed as a devDependency of `apps/desktop` (the root has no `electron`, 01 §R4-13) is launched with the app directory `apps/desktop` as its argument, and `apps/desktop/package.json` `main` points to `out/main/index.js`. The env sets `RELAY_PROVIDER_MODE=fake` and `RELAY_E2E=1`. It makes no network calls and costs nothing. The packaged app is verified separately in 13 §M1, because the packaged build disables the `nodeCliInspect` fuse, which Playwright needs.

---

## L1: Config (`playwright.config.ts`)

```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e/specs',
  timeout: 60_000, expect: { timeout: 10_000 },
  fullyParallel: false, workers: 1,                // one Electron at a time: deterministic, no userData contention
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' },
  outputDir: 'test-results',
});
```
`pnpm e2e` = `pnpm build && PLAYWRIGHT_HTML_OPEN=never playwright test` (`pnpm test:e2e` is an alias). Per the playwright-cli skill, the HTML report never auto-opens.

## L2: Electron fixture (`tests/e2e/fixtures.ts`)

```ts
import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { FakeCall } from '@relay/providers';

const desktopDir = path.resolve('apps/desktop');
// Resolve the electron binary path from apps/desktop's own devDependency.
const electronPath = createRequire(path.join(desktopDir, 'package.json'))('electron') as unknown as string;

type Fixtures = {
  userDataDir: string;
  scenario: string;                          // FAKE_SCENARIOS key, override per test with test.use({ scenario: 'budget-exhaustion' })
  crashAt: string | undefined;               // 06 grammar: '<hook>@<stepKey>[#n]', e.g. 'afterStepCommit@plan'
  app: ElectronApplication;
  page: Page;
  relaunch: (opts?: { crashAt?: string; scenario?: string }) => Promise<Page>;  // close + launch on SAME userDataDir
  stubDialogs: (s: { directory?: string; diffFile?: string; exportDir?: string }) => Promise<void>;
  callLog: () => Promise<FakeCall[]>;       // reads userData/fake-call-log.jsonl ({ at, runId, attemptId, stepKey, purpose, providerId, modelId, systemSha256 })
  perfMeasures: () => Promise<{ name: string; duration: number }[]>;  // renderer performance.getEntriesByType('measure'), 'relay:*' only
};

export const test = base.extend<Fixtures>({
  scenario: ['happy-path', { option: true }],
  crashAt: [undefined, { option: true }],
  userDataDir: async ({}, use) => {
    const d = await mkdtemp(join(tmpdir(), 'relay-e2e-'));
    await use(d);
    if (process.env.RELAY_E2E_KEEP === '1') {
      // Retained for `pnpm check:secrets` (13 §M2), which reads this path as its default scan dir.
      await mkdir('test-results', { recursive: true });
      await writeFile('test-results/last-userdata.txt', d + '\n');
    } else {
      await rm(d, { recursive: true, force: true });
    }
  },
  app: async ({ userDataDir, scenario, crashAt }, use) => {
    const app = await launch({ userDataDir, scenario, crashAt });
    await use(app);
    await app.close().catch(() => {});      // tolerate already-crashed runner/app
  },
  page: async ({ app }, use) => { const p = await app.firstWindow(); await p.waitForLoadState('domcontentloaded'); await use(p); },
  stubDialogs: async ({ app }, use) => {
    // Native dialogs are not intercepted by Playwright → stub in MAIN via the RELAY_E2E-only seam (08 §H3):
    // globalThis.__relayDialogs = { setStub({directory?, diffFile?, exportDir?}), clear() }
    await use(async (s) => { await app.evaluate((_electron, stub) => { (globalThis as any).__relayDialogs.setStub(stub); }, s); });
    await app.evaluate(() => { (globalThis as any).__relayDialogs?.clear(); }).catch(() => {});
  },
  // …relaunch, callLog, perfMeasures
});

async function launch(o: { userDataDir: string; scenario: string; crashAt?: string }) {
  return electron.launch({
    executablePath: electronPath,
    args: [desktopDir],                       // Electron loads apps/desktop/package.json → main: out/main/index.js
    env: { ...process.env, RELAY_E2E: '1', RELAY_PROVIDER_MODE: 'fake', RELAY_FAKE_SCENARIO: o.scenario,
           RELAY_USER_DATA_DIR: o.userDataDir, ...(o.crashAt ? { RELAY_CRASH_AT: o.crashAt } : {}) },
  });
}
```

Every test copies `tests/fixtures/sample-api` into `<userDataDir>/../project-<rand>` (a temp dir under `os.tmpdir()`, which is a valid project root), stubs the directory dialog to that copy, and **hashes the tree before and after**. The afterEach hook asserts the hashes are equal (FR-10 / §3.3 "original project files remain unchanged by every P0 workflow").

**Performance marks (requested from J):** the renderer records `performance.mark('relay:nav:<route>:start')` when navigation starts and `performance.measure('relay:nav:<route>', 'relay:nav:<route>:start')` when the route's primary query has rendered, plus `relay:history-loaded` when the Runs list first renders its rows. `perfMeasures()` reads them with `page.evaluate(() => performance.getEntriesByType('measure'))`.

## L3: Page objects (`tests/e2e/pages/*.ts`) — locators by role and accessible name only

Locators use `getByRole`/`getByLabel`/`getByText`, which also serves as an accessibility check. `data-testid` is allowed only for non-semantic containers (timeline items use `getByRole('button', { name: /Review input/ })`).

| Page object | Key methods |
|---|---|
| `Shell` | `nav(name)`, `activeProject()`, `runsBadgeCount()`, `fakeProviderBadge()`, `runnerBanner()` |
| `Onboarding` | `useSample()`, `chooseFolder()`, `connectProvider(id, key, mode)`, `expectRedactedLabel()`, `addRule(text)`, `setAllowance('$3.00')`, `startRun(goal)` |
| `Overview` | `attentionCard()`, `openPendingStep()`, `trackedUsage()`, `recentRuns()` |
| `NewRun` | `fillGoal`, `selectFiles([...])`, `importDiff()`, `setLimits({ maxAttempts?, timeoutSeconds? })`, `expectPreflight({ files, providersReceivingContext })`, `expectBudgetBlocked({ L, N })`, `submit()` |
| `RunInspector` | `waitForStatus(text)`, `selectStep(name)`, `tab(name)`, `approve()`, `requestRevision(note)`, `reject()`, `cancel()`, `pause()`, `increaseAllowance('$1.00')`, `decideUnknown(choice)`, `retryStep({ profile? })`, `acknowledgeOverrun()`, `raiseLimits({ maxAttempts?, timeoutSeconds? })`, `expectActions([...])`, `ledgerRow(name)`, `reservedAmount()`, `attemptTimings(stepName)` → `{ providerLatency, appTime }`, `secondaryPanelTabs()` |
| `Report` | `exportBoth()`, `expectNotModifiedBanner()`, `patchTab()` |
| `Memory` | `tab(name)`, `openTab`, `records(tab)`, `record(tab, title)`, `detail(title)`, `openAddRule()`, `ruleFields()`, `addRule({ title, content, pinned? })`, `startEdit(title)`, `editForm()`, `conflictTable(form)`, `keepMyChanges(form)`, `archive`, `restore`, `openDelete`, `suggestion(title)`, `approveSuggestion(title)` |
| `WorkflowEditor` | `open()`, `status()`, `versionLabel()`, `saveButton()`, `validateButton()`, `limitField(label)`, `validAlert()`, `publishButton()`, `publishedBanner()` |
| `Settings` | `section(name)`, `connect`, `test`, `disconnect`, `diagnosticsValue(term)`, `profilesSection()`, `editProfile(name)`, `projectsSection()`, `projectForm()`, `archiveProject(name)`, `projectPicker()`, `fallbackProjectNote()`, `data()`, `exportProject()`, `openPurge()` |

## L4: Specs (`tests/e2e/specs/*.spec.ts`)

| Spec | Tags | Scenario | Steps → Assertions |
|---|---|---|---|
| `smoke.spec.ts` | `@m1` | happy-path | Launch → the window title is "Relay" → the Diagnostics page shows `runner: ready`, schema v1, and the provider mode "fake" badge visible. Navigate Overview → Runs → Settings and **record** the `relay:nav:*` and `relay:history-loaded` measures as a test attachment (`testInfo.attach('perf-marks', …)`), so every run leaves a timing baseline |
| `responsiveness.spec.ts` | `@m1` §6.4 | slow-review (review `delayMs` 5000) | Start a run → while the review call is in flight (status "Running", step Review running), navigate Runs → Memory → Settings → each route's `relay:nav:<route>` measure is **< 1000 ms** and the page content is visible (the runner process keeps the UI responsive during a provider call) |
| `onboarding.spec.ts` | `@m1` FR-01 FR-02 | happy-path | Welcome → connect provider with a fake key `sk-ant-e2e-ABCDEFGHIJKLMNOP` → the redacted label `sk-…MNOP` is shown and the full key is **not in the DOM** (`page.content()` does not contain it) → select project → the preview shows `.env` excluded as "secret", `node_modules` as "dependency", `assets/logo.png` as "binary" → add rule → allowance $3.00 → review → start → lands on the inspector |
| `run-restart-history.spec.ts` | `@m1` | happy-path | Complete one run → `relaunch()` → the Runs list shows it `Completed` with its cost (M1 exit gate: "run appears in history after restart") |
| `run-happy-path.spec.ts` | `@m2` FR-04 FR-08 FR-09 FR-10 | slow-review | Start → while the review is running, the budget panel shows **Reserved > $0.00** → wait for "Awaiting your approval" → the timeline shows Review/Plan completed → Review step → Attempts tab shows **"Provider latency"** and **"App time"** as two separate labeled values → the approval card shows plan + hash text → **Approve** → wait for "Completed" → the verdict note "does not guarantee the code is correct" is present → the ledger shows Calculated > $0, Reserved $0.00, and Unknown $0.00 → Report → Export both (stub the export dir to a temp dir) → both files exist, the report contains "Limitations", and the export content does **not** contain the fake key → Settings → Storage & data → **Export project…** (stubbed save folder) → exactly `relay-project-<name>.json` exists, the toast says "Project export saved", and the bundle contains no `sk-`, no `AIza`, not the fake key / `.env` value, and **not the project realpath** (02 `projects.export`: no realpath) → the project tree hash is unchanged |
| `approval-controls.spec.ts` | `@m2` FR-08 | revise-then-accept | Request revision without a note → the button is disabled. With a note → planner re-runs (call log: `stepKey=plan` ×2) → Approve → completes. Reject path on a new run → `Cancelled` |
| `budget-pause.spec.ts` | `@m4` FR-05 | budget-exhaustion | Allowance $0.10 → start → the banner "Paused before dispatch…" and the breakdown table show L=$0.10 and a total greater than L → **call log has 0 calls for the blocked step** → Increase allowance to $3.00 → resumes → completes |
| `pause-states.spec.ts` | `@m4` FR-05 FR-12 | malformed-twice, overrun, happy-path | Three tests: (1) `malformed-twice` → banner for `paused(output_invalid)` with actions Retry step / Choose profile / Stop → **Retry step** → completes (call log: the retried step has a new `user_retry` call). (2) `overrun` with allowance $3.00 → banner for `paused(budget_overrun)` showing actual > reserved → **Acknowledge overrun** → completes. (3) `happy-path` with New run limits maxAttempts 2 → banner for `paused(limit_attempts)` → **Raise limits** dialog (maxAttempts 8, bounded by `RUN_LIMIT_MAXIMUMS`) → completes |
| `restart-recovery.spec.ts` | `@m3` FR-07 | happy-path + `crashAt: 'afterStepCommit@plan'` | The runner dies after the plan commit (the app shows the "runner restarting" banner or the relaunch) → `relaunch({ crashAt: undefined })` → Overview shows the **Interrupted** banner with "last completed step: Plan a fix" → Review recovery → Continue → reaches approval → **call log: review ×1, plan ×1** (not re-executed) |
| `unknown-outcome.spec.ts` | `@m3` §7.5 | unknown-outcome | (1) The implement attempt becomes unknown → the banner says the charge is unknown and the liability is shown → the Retry button label includes "may incur another charge" → Retry → completes → the ledger still shows the earlier unknown liability (not silently dropped). (2) Relaunch with a **fresh `userDataDir`** (a new fixture instance with the `unknown-outcome` scenario, since part (1) consumed the scenario's scripted steps), start a new run to the same unknown state → choose **Accept estimated charge** (`accept_estimated_charge`) → the ledger row for that attempt shows the amount with the **"est."** label (certainty estimated) and Unknown returns to $0.00 |
| `approval-stale.spec.ts` | `@m3` FR-08 §11.2 | happy-path | At approval, modify `src/handlers/user.ts` in the project copy from the test (fs write) → Approve → the banner "changed since the context snapshot" shows before→after hashes → choose "Continue with preserved snapshot" → completes → the report states the snapshot was used |
| `cancel.spec.ts` | `@m4` FR-11 | hang | Start → while the review is running click Cancel → the confirm dialog explains best-effort cancellation → confirm → "Cancelling…" then "Cancelled" → remaining steps show "Skipped" → the ledger row "Unknown" > $0 and Reserved $0.00 (honest charge status) → the call log count stays 1 |
| `memory.spec.ts` | `@m3` FR-06 | happy-path | (1) **Add project rule** → approved + selected; reopening the dialog shows empty fields (reset after success) → Edit while another session (`window.relay.invoke('memory.update')`) saves revision 2 → Save → the field-by-field **conflict table** (Title changed by another session, Content by you) → **Keep my changes and save over revision 2** → "Saved revision 3" with their title and my content → Archive → Archived (1) → Restore to approved. (2) After a completed run, add an approved rule titled like the run's suggestion → Approve the suggestion → **"Conflicts with “…”"** and **"Combine with “…”"**, nothing approved → Combine opens the side-by-side resolver. (3) Pinned + 2 rules → New run with the picker untouched: the preflight lists all 3 → untick both unpinned → the preflight lists only the pinned rule → start → the inspector's Context summary shows 1 approved memory record |
| `workflow-editor.spec.ts` | `@m4` §5.3 | happy-path | (1) Editor opens on Version 1 → edit Maximum attempts → "Draft, unsaved changes" → **Save draft** → "Draft revision 1 · based on v1" → Validate → "Draft revision 1 is valid" → an unsaved edit **disables Publish** with "Publishing is unavailable while you have unsaved changes" (also its accessible description) → revert → **Publish as v2** → banner "v2 validated — new runs will snapshot v2…" listing capability warnings or "No capability warnings.". (2) Settings → Model profiles → rename *Economy* → CONFLICT `profile_in_use` "This profile is used by workflows" with a link to the workflow → the link opens its editor. (3) `editable.limits: false` (forced in main via `patchIpcReply`, since the P0 runner always allows limit edits) → the run allowance is a read-only input "Locked for this version." and the other limits are not editable |
| `settings.spec.ts` | `@m4` 10 J10 | happy-path | (1) Projects: type an exclusion, another session saves a monthly allowance, Save → CONFLICT refetch → "This project changed since you started editing" table; the form still holds my edit and not the server value → **Keep my changes on top of the saved settings** → save → both stored. (2) A second (sample) project is made active; Memory of project 1 → Delete… → **Purge project history** link → `#/settings/data?project=<id>`: picker on that project, no fallback note, the purge dialog names it. (3) An awaiting-approval run → Archive project → CONFLICT `active_run` "This project has an active run" with a link to the run; not archived |
| `provider-settings.spec.ts` | `@m1` §3.3 §18.2 | happy-path | Connect → Test (shows a latency and cost label) → Disconnect → a run start is blocked with "AUTH_REQUIRED/Reconnect". After the suite, scan `userDataDir/**` for the key: a custom DB dump via Node `node:sqlite` (iterate `sqlite_master`, `SELECT *` every table) plus the `-wal` file bytes, logs, artifacts, and exports → 0 hits |
| `failure-states.spec.ts` | `@m4` FR-12 | malformed-then-ok, auth-fail | Schema repair visible in the Attempts tab (2 attempts, purpose "schema repair"). Auth failure → paused with Reconnect → reconnect → resume → completes |
| `a11y.spec.ts` | `@a11y` §3.3 §5.7 | various | For each page (Overview, Runs, New run, Inspector in awaiting-approval, Report, Memory (approved + detail, add-rule dialog, edit, suggestions, archived), Workflow editor (version + validated draft), every Settings section (+ profile edit form), Onboarding step 3) run `new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()` → 0 violations. **Keyboard-only journey:** from launch, with Tab/Shift+Tab/Enter/Space/Arrows only, navigate to the pending approval and approve (no mouse). The focus ring is visible on each focused element (computed `outline-style !== 'none'`). The skip link works. **Narrow layout:** at a 1100 px window width (`BrowserWindow.setSize` via `app.evaluate`), the inspector's secondary panels (Budget, Context) render as tabs (`getByRole('tab', { name: 'Budget' })`), and axe still reports 0 violations. **Error contrast:** a project export to a missing folder renders an ErrorView ("Error code NOT_FOUND") in Storage & data → 0 `color-contrast` violations |
| `visual-parity.spec.ts` | `@visual` (optional, not in the gate) | fake scenarios | Screenshot each page state and compare against the baseline PNGs captured at M4 (`toHaveScreenshot`, threshold 0.2). Detects accidental regressions after freeze (M6) |

## L5: Debugging workflow (playwright-cli skill)
- Run a single spec: `PLAYWRIGHT_HTML_OPEN=never npx playwright test tests/e2e/specs/budget-pause.spec.ts`.
- Debug a failing test: run `PLAYWRIGHT_HTML_OPEN=never npx playwright test <spec> --debug=cli` **in the background** and watch its output until "Debugging Instructions" (with a session name) is printed. Then `playwright-cli attach <session>` to inspect snapshots and element refs (`playwright-cli snapshot`, `playwright-cli click e15`, `playwright-cli eval "el => el.getAttribute('aria-label')" e5`). Every action prints generated Playwright TypeScript that can be pasted back as a fixed locator or expectation. When the fix is in, stop the background test run and rerun the spec normally to confirm it passes.
- Inspect a retained failure: rerun with `RELAY_E2E_KEEP=1`; the userData path is in `test-results/last-userdata.txt` (DB, logs, `fake-call-log.jsonl`).
- Traces: `npx playwright show-trace test-results/<test>/trace.zip`.
- Flake policy: a test that fails once and passes on retry in CI is logged in `docs/release/flakes.md` (M) and must be fixed before M6 freeze. Retries hide flakes and are not a fix.

## L6: Determinism rules
- Fake provider latency is fixed per scenario step (`delayMs` ≤ 300), except `slow-review`, whose review step uses `delayMs` 5000 so that "while running" states (responsiveness, Reserved > $0) are observable. Specs wait on **UI state**, never on sleeps (`expect(locator).toHaveText(...)` with auto-wait).
- There are no `page.waitForTimeout` calls (lint rule `playwright/no-wait-for-timeout` via `eslint-plugin-playwright` in the `tests/e2e` override; **A owns the eslint config**, 01 §R2-37).
- The call log (`fake-call-log.jsonl`, `FakeCall` records) is the source of truth for "not re-executed" assertions; counts filter on `stepKey` and `purpose`.
- `RELAY_CRASH_AT` values always use the 06 grammar `<hook>@<stepKey>[#<n>]`.

## Success Criteria (gate)
- [ ] `pnpm e2e` → all specs green except `@visual` (1 worker, < 8 min on the dev Mac)
- [ ] `pnpm e2e -- --grep @m1` green at M1 (including `responsiveness.spec.ts`). `--grep "@m2|@m3|@m4"` green at those milestones (including `pause-states.spec.ts` at M4)
- [ ] `pnpm e2e -- --grep @a11y` → 0 axe violations, including the 1100 px narrow-layout check
- [ ] `RELAY_E2E_KEEP=1 pnpm e2e` then `pnpm check:secrets` (default dir from `test-results/last-userdata.txt`) → "0 findings"
- [ ] `pnpm check:project-untouched` → OK
- [ ] 3 consecutive full green runs locally before M5 sign-off (flake check)

## Review Checklist
- [ ] Every FR-01…FR-12 has at least one e2e assertion or a documented integration-only rationale (00 §6 table)
- [ ] The app is launched with `executablePath` from `apps/desktop`'s `electron` and `args: [path.resolve('apps/desktop')]`, never a root `electron` or a hard-coded `out/main/index.js` arg
- [ ] Dialogs are stubbed only through `__relayDialogs.setStub` and cleared after each test
- [ ] No test depends on a live provider or the network
- [ ] Locators are role/label based (accessibility doubles as a test)
- [ ] Every spec asserts the project tree is untouched (afterEach)
- [ ] Every pause reason exercised in e2e (budget_run, budget_overrun, output_invalid, limit_attempts, unknown_outcome, auth_required, approval_stale) resolves through its UI action to completion
