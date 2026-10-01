# Plan 08: Desktop Host — Electron Main, Preload Bridge, IPC Router, Credentials, Runner Supervisor (Agent H)

Spec: §3.3, §6.1–6.5, §11.1, §12.3, §12.5, §18.1–18.3 · Backlog: RLY-006 (shell half), RLY-007, RLY-009, RLY-021 (IPC), RLY-025 (config) · Waves (00 §3): **Wave 1 / M1** H1–H7 · **Wave 5 / M5** H9 packaging. H8 (security) and H10 (samples) are not separately scheduled in 00 §3 and land before Wave 5

Files (exclusive): `apps/desktop/src/main/**`, `apps/desktop/src/preload/**`, `apps/desktop/src/runner/**`, `apps/desktop/electron.vite.config.ts`, `apps/desktop/vite.renderer.config.ts` (the renderer-only config behind `dev:renderer`), `apps/desktop/build/**` (build-time Vite plugins, including `vite-plugin-csp.ts`), `apps/desktop/electron-builder.yml`, `apps/desktop/resources/**`

Main **never** imports `@relay/engine`, `@relay/storage`, or `@relay/providers` (lint gate, 01 §A5). Main owns windows, dialogs, credentials, and the runner lifecycle (§6.3). The runner entry is the only place those packages are composed, and it composes them solely through `createRuntime` from `@relay/engine` (06 §F16) plus `createJsonlCallLog` from `@relay/providers`.

Logging (main and runner): structured JSONL lines with the 00b §3 fields, including `outcome` (`'ok' | 'error'`, plus `code` on errors). Every IPC operation logs one `ipc.op` line `{ channel, correlationId, durationMs, outcome, code? }`. All lines are redacted (`redactString`, 02) before writing.

---

## H1: Main entry & app lifecycle (`src/main/index.ts`, `src/main/app-paths.ts`)

Boot order (this order is binding and is unit-tested in `index.test.ts`):
1. **userData override** (first, before the lock, because the lock is scoped to userData): when `RELAY_USER_DATA_DIR` is set **and** (`!app.isPackaged` or `RELAY_E2E === '1'`), call `app.setPath('userData', dir)`. Playwright uses this for isolated profiles.
2. **Single-instance lock:** `if (!app.requestSingleInstanceLock()) { app.quit(); return; }`. `second-instance` focuses the existing window (§6.4).
3. **Provider mode:** `RELAY_PROVIDER_MODE=fake` is honored only under the same condition as step 1. Otherwise mode = `live`. The effective mode (and `RELAY_FAKE_SCENARIO` in fake mode) is passed to the runner via the fork env and shown in the UI (`app.getInfo()` → `providerMode`, `fakeScenario`) as a persistent "Fake provider" badge.
4. `await app.whenReady()`, then in order:
   1. `security.applySessionPolicy()` (H8).
   2. `paths.ensureLayout()` creates `userData/{artifacts,backups,logs,exports,secrets,samples}`, with mode 0700 for `secrets`.
   3. `ipc.register()` (H4) — **before** any window exists, so the renderer's first `invoke` never races a missing handler.
   4. `createMainWindow()`.
   5. `supervisor.start()` (H6). A rejected `start()` is caught and logged; the supervisor state becomes `unavailable`, the window still shows, and the renderer displays the diagnostics banner (runner-routed ops return `RUNNER_UNAVAILABLE`).
5. **Quit:** `app.on('before-quit', e => …)` guarded by a module-level `quitting` flag. On the first call: `e.preventDefault()` → `quitting = true` → `await supervisor.shutdown({ graceMs: 5000 })` (lets an in-flight checkpoint commit; errors are logged, never block) → flush logs → `app.quit()`. The second `before-quit` sees `quitting === true` and returns without preventing, so quit is never re-entered or blocked.

`app-paths.ts` exports `appPaths(userData, samples)` → `{ userData, artifacts, backups, logs, exports, secrets, samples, dbFile: join(userData, 'relay.sqlite') }`, where `samples = samplesRoot(userData, app.getPath('documents'), userDataOverridden)` (H10: outside userData). It never hardcodes a home path (§12.3).

Window: `new BrowserWindow({ width: 1440, height: 940, minWidth: 1024, minHeight: 700, show: false, backgroundColor: '#0B1119', webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false } })`. It shows on `ready-to-show` (avoids a white flash), independent of the runner state. DevTools are available only when `!app.isPackaged` and are **never auto-opened when `RELAY_E2E=1`** (an extra DevTools window breaks Playwright's `firstWindow()`).

## H2: Preload bridge (`src/preload/bridge.ts`, `src/preload/index.ts`) — "small typed, validated IPC surface" (§6.3)

The API is built by `createRelayApi(ipcRenderer, process.platform)` in Electron-free `bridge.ts` (unit-tested with a fake `ipcRenderer`); `index.ts` only calls `contextBridge.exposeInMainWorld('relay', createRelayApi(ipcRenderer, process.platform))`. The logic is:

```ts
import { contextBridge, ipcRenderer } from 'electron';
import { OPERATIONS, pushEventSchema, type Channel, type InputOf, type IpcResult } from '@relay/contracts';

const ALLOWED = new Set<string>(Object.values(OPERATIONS).map((o) => `${o.channel}`));  // INTERNAL_RUNNER_OPS are never in OPERATIONS
const api = {
  invoke<C extends Channel>(channel: C, input: InputOf<C>): Promise<IpcResult<C>> {
    if (!ALLOWED.has(channel)) return Promise.resolve({ ok: false, error: appError('PERMISSION_DENIED', { details: { reason: 'channel_not_allowed' } }) });
    return ipcRenderer.invoke(channel, input);          // main validates; preload does not trust itself
  },
  subscribe(listener: (e: PushEvent) => void): () => void {
    // PERF-06: ONE lazy ipcRenderer listener parses each payload once and fans out to a Set of entries (one entry per
    // subscribe call); the listener is removed when the last subscriber leaves. See src/preload/bridge.ts.
    const entry = { listener };
    if (subscribers.size === 0) ipcRenderer.on('relay/v1/events', handler);
    subscribers.add(entry);
    return () => { if (subscribers.delete(entry) && subscribers.size === 0) ipcRenderer.removeListener('relay/v1/events', handler); };
  },
  platform: process.platform,                            // for keyboard hints only
} as const;
contextBridge.exposeInMainWorld('relay', api);
export type RelayBridge = typeof api;                    // re-exported type used by renderer via contracts' ambient decl
```
The preload never exposes `ipcRenderer`, `require`, `process.env`, or any filesystem API. It is **bundled as a single CJS file** (H9): a sandboxed preload can only `require` a few Electron built-ins, so `@relay/contracts` and zod must be inlined, and the output contains no runtime `require` of any workspace package.

## H3: Dialogs & selection tokens (`src/main/dialogs.ts`)
- `pickDirectory()` → `dialog.showOpenDialog({ properties: ['openDirectory','createDirectory'] })`. Main then does the following:
  1. Takes the `realpath`.
  2. Validates the root (`validateProjectRoot`, pure and unit-tested). It rejects:
     - a root equal to `/` or the home dir itself;
     - a root equal to or inside `/System`, `/Library`, `/usr`, `/bin`, `/etc` (compared after realpath, so `/private/etc` is covered);
     - a root equal to, inside, or **containing** `userData`.

     Subdirectories of `os.tmpdir()` (realpath'd, e.g. `/private/var/folders/…`) are **allowed**; E2E and integration tests use them (05 R4-35).
  3. Stores it in `selections: Map<SelectionId, { realpath, expiresAt }>` with a 10-minute TTL.
  4. Returns `{ selectionId, displayPath: toDisplayPath() }`. **The renderer never supplies a filesystem path** (§12.5, "the renderer never submits … filesystem paths").
- Selection tokens: `resolveSelection(id)` returns the realpath without consuming it (used by `projects.previewFiles`). `consumeSelection(id)` deletes the token; `projects.create` calls it once the runner returns `ok`, so a token can create at most one project (a failed create leaves the token until TTL so the user can retry). Expired or unknown tokens → `NOT_FOUND`.
- `pickDiffFile()`, a filter for `.diff`/`.patch`, reads ≤ 1 MiB in main and returns `{ text, fileName }` for the internal `artifacts.importDiffText` op.
- `pickExportDir()` → the directory dialog, realpath'd. `pickSaveFile(defaultName, filters)` → `dialog.showSaveDialog`; main realpaths the chosen file's **parent directory** and returns `join(realParent, basename)`. The runner (05 §E7) re-checks and refuses destinations inside, or containing, any project root.
- **E2E test seam** (installed only when `RELAY_E2E === '1'`; absent otherwise):
  ```ts
  globalThis.__relayDialogs = {
    setStub(s: { directory?: string; diffFile?: string; exportDir?: string }): void,  // merges into the active stub
    clear(): void,                                                                    // back to native dialogs
  };
  ```
  While a field is set, the matching dialog returns it instead of opening a native dialog: `directory` → `pickDirectory`, `diffFile` → `pickDiffFile`, `exportDir` → `pickExportDir` and `pickSaveFile` (the latter returns `join(exportDir, defaultName)`). Stubbed paths go through the **same** realpath and validation as real selections. The stub persists until `clear()` (12 §L2 `stubDialogs`).

## H4: IPC router (`src/main/ipc/router.ts`, `src/main/ipc/handlers/*.ts`, `src/main/ipc/rate-limit.ts`)

A pipeline per operation, in this order (backend-patterns "middleware"). Only `OPERATIONS` are registered; `INTERNAL_RUNNER_OPS` (02 `src/ipc/internal.ts`) are **never** registered with `ipcMain` and are reachable only from main's composite handlers via `supervisor.request`.

```ts
// router.ts (createIpcRouter): `register()` calls ipcMain.handle(op.channel, …) for every OPERATION; `invoke` is the pipeline.
async function invoke(channel, event, raw): Promise<IpcEnvelope<unknown>> {
  const correlationId = ids.next('correlation'); const t0 = now();
  const op = byChannel.get(channel);
  let result;
  if (op === undefined) result = { ok: false, error: errors.notFound('channel') };          // unknown channel → NOT_FOUND
  else {
    try {
      result = await pipeline(op, event, raw);
    } catch (e) {
      logger.error({ event: 'ipc.error', channel, correlationId, outcome: 'error', err: redactDeep(serializeError(e)) });
      const mapped = toAppError(e, correlationId);                  // a thrown AppError (known code) passes through as is;
      if (e instanceof UndeclaredErrorCodeError) throw e;          // strict mode (tests): never masked as INTERNAL
      result = { ok: false, error: mapped.code === 'INTERNAL' ? errors.internal(correlationId, internalReasonOf(mapped)) : mapped }; // anything else → INTERNAL (closed reason kept), no internals leaked
    }
  }
  logger[result.ok ? 'debug' : 'info']({ event: 'ipc.op', channel, correlationId, durationMs: Math.round(now() - t0),  // MAIN-01: ok → debug
                outcome: result.ok ? 'ok' : 'error', ...(result.ok ? {} : { code: result.error.code }) });
  return result;
}

async function pipeline(op, event, raw) {
  if (!isTrustedSender(event, origin)) return { ok: false, error: errors.permissionDenied('untrusted_sender', { userMessage: 'This window may not call Relay.' }) }; // 1. sender check (PERMISSION_DENIED is universal)
  const taken = limiter.take(op.channel, op.rateLimit ?? RATE_LIMITS.default);                             // 2. token bucket
  if (!taken.ok) return { ok: false, error: errors.rateLimited(taken.retryAfterMs) };                       //    → RATE_LIMITED
  const input = op.input.safeParse(raw);                                                                     // 3. validation
  if (!input.success) return { ok: false, error: errors.validationFailed(toValidationIssues(input.error.issues)) };
  const result = op.route === 'main' ? await mainHandlers[op.channel](input.data)                          // 4. route
               : op.route === 'runner' ? await supervisor.request(op.channel, input.data)
               : await composite[op.channel](input.data);                                                    //    main+runner
  if (!isPackaged) {                                                                                         // 5. dev-only checks
    if (result.ok) op.output.parse(result.data);           // contract violation throws → INTERNAL (visible in dev)
    else if (![...op.errors, ...UNIVERSAL_ERROR_CODES].includes(result.error.code)) {
      logger.warn({ event: 'ipc.undocumented_error', channel: op.channel, code: result.error.code });
      if (strictErrorCodes) throw new UndeclaredErrorCodeError(op.channel, result.error.code); // default on under NODE_ENV=test / VITEST
    }
  }
  return result;
}
```

- `assertTrustedSender(event)`:
  - `event.senderFrame` is `null` (frame destroyed or navigated away) → reject.
  - Packaged (and any non-dev load): the frame URL with its `#fragment` removed must **equal** `pathToFileURL(join(__dirname, '../renderer/index.html')).href` exactly — not a prefix or origin match (every `file://` URL shares an origin).
  - The electron-vite dev server URL (`process.env.ELECTRON_RENDERER_URL`) is accepted only when `!app.isPackaged`.
  - Anything else → `PERMISSION_DENIED`, logged with `outcome: 'error'`.
- Main-only handlers: `app.getInfo` (includes `providerMode` and `fakeScenario`), `app.openExternal` (https only, confirmation dialog in main, and `shell.openExternal`), `projects.pickDirectory`.
- Composite handlers (`main+runner`). Every runner call from a composite goes through `supervisor.request`, which is typed on `RunnerChannel` (02), so internal channels and their inputs are type-checked:

  | Public op | Main side | Runner call |
  |---|---|---|
  | `projects.previewFiles` | `{selectionId}` → `resolveSelection` → realpath | `projects.previewRoot {rootRealpath, extraExclusions}`; `{projectId}` → `projects.previewRoot {projectId, extraExclusions}` |
  | `projects.create` | `resolveSelection` → realpath + display path; `consumeSelection` after `ok` | `projects.createFromRoot {idempotencyKey, rootRealpath, rootDisplayPath, name, exclusions, allowedProviderIds, monthlyAllowanceMicrousd, isDemo: false}` |
  | `projects.createSample` | H10 copy to `userData/samples/` | `projects.createFromRoot {…, isDemo: true}` |
  | `projects.export` | `pickSaveFile('relay-project-<name>.json')`; cancel → `{exported: false}` | `projects.exportTo {projectId, runIds, destinationRealpath}` |
  | `ledger.export` | `pickSaveFile('relay-ledger-<run\|month>.csv')`; cancel → `{exported: false}` | `ledger.exportTo {…input, destinationRealpath}` |
  | `artifacts.export` | `pickExportDir()`; cancel → `{exported: false, displayPaths: []}` | `artifacts.exportTo {runId, what, destinationRealpath}` |
  | `artifacts.importDiff` | `pickDiffFile()` → `{text, fileName}`; cancel → `null` | `artifacts.importDiffText {projectId, text, fileName}` |
  | `providers.connect` | `vault.save(providerId, apiKey, storage)` | `providers.recordCredentialRef {providerId, storageMode, vaultFile, redactedLabel}`; if it fails, main deletes the vault file / session entry it just wrote |
  | `providers.disconnect` | `vault.remove(providerId)` | `providers.deleteCredentialRef {providerId}` |
  | `providers.list` | overlays `storage: 'session'` presence for session-only keys (held only in main's memory) | forwarded `providers.list {}`: the runner serves `ProviderStatus[]` from its DB (credential refs incl. redacted label + last test status). `providers.listCredentialRefs` is **not** used here; it is used only for main-boot vault reconciliation |
  | `providers.test` | `vault.status`/presence check → `AUTH_REQUIRED` if absent | `providers.test` (the runner requests the key via `credential.request`) |
  | `app.getDiagnostics` | supervisor `state()` + vault status | runner DB info |
  | `app.exportDiagnostics` | redact, `pickSaveFile`, write | runner data obtained via the forwarded `app.getDiagnostics` |

- Rate limiter: an in-memory token bucket per channel, with parameters from `OPERATIONS[c].rateLimit` or the default query bucket (02 §B6).

## H5: Credentials vault (`src/main/credentials.ts`) — §3.3, §18.2, RLY-007

```ts
export interface CredentialVault {
  status(): Promise<{ available: boolean; backend: string; reason?: 'basic_text' | 'unavailable' }>;
  save(providerId, apiKey, mode: 'os_protected' | 'session'): Promise<Result<CredentialRef>>;
  get(providerId): Promise<Result<string>>;              // used only to answer runner credential.request
  remove(providerId): Promise<void>;
}
```
- **API verification (done in H5, recorded in `credentials.ts`):** the Electron 44.5.1 typings have `encryptStringAsync(string) → Promise<Buffer>`, `decryptStringAsync(Buffer) → Promise<{ result, shouldReEncrypt }>` and `isAsyncEncryptionAvailable() → Promise<boolean>`. `isTemporarilyUnavailable` is **not** an Electron 44 API. `credentials.ts` feature-detects at runtime: if the async variants are absent, it falls back to the sync `encryptString`/`decryptString` (with `shouldReEncrypt` treated as `false` and no temporary-unavailability signal). Both paths are unit-tested.
- `os_protected`:
  - Requires `safeStorage.isEncryptionAvailable()` (or the async availability check, when present) after `ready`.
  - On Linux, `getSelectedStorageBackend() !== 'basic_text'`. The basic_text backend uses a hard-coded password, so it is treated as **unavailable**. The desktop target is macOS for P0, but the check is cheap and prevents a silent downgrade.
  - Encrypt → write `secrets/<refId>.bin` with `fs.writeFile(…, { mode: 0o600, flag: 'w' })`. Decrypt on `get`. If `shouldReEncrypt` → re-encrypt and rewrite.
  - `isTemporarilyUnavailable` is not part of Electron 44's `safeStorage`. `SafeStorageLike` declares it as an optional method and `saveProtected` feature-detects it (`s.isTemporarilyUnavailable?.() === true` → `SECURE_STORAGE_UNAVAILABLE`, retryable), so with Electron 44 there is no temporary-unavailability signal and the check is a no-op. A keychain denial or failed write still fails closed (`SECURE_STORAGE_UNAVAILABLE` with `use_session_key`).
- `session`: the key is held in a main-process `Map` only and dropped on quit. The UI labels it "Session only: re-enter after restart".
- **Fail closed:** if the OS is unavailable and the user asked for `os_protected` → `SECURE_STORAGE_UNAVAILABLE` with nextAction `use_session_key`. **Never write plaintext** (§18.2).
- The ref row (`provider_credential_refs`: redacted label, mode, vault file) is written by the **runner** through the internal op `providers.recordCredentialRef` (`INTERNAL_RUNNER_OPS`, never renderer-exposed), preserving the single DB writer (§6.4).
- Redacted label: `redactedLabel(apiKey)` → `sk-…a1F9`.
- `remove` deletes the file and the session entry, and the `providers.disconnect` composite then calls `providers.deleteCredentialRef` (§18.2 "support removing a provider connection and clearing cached credentials").
- The key is never logged, never put in `process.env`, never sent to the renderer, and never included in diagnostics (grep gate + `check:secrets`).

## H6: Runner supervisor (`src/main/runner-supervisor.ts`) — §6.4

```ts
import type { RunnerChannel, RunnerInputOf, RunnerOutputOf } from '@relay/contracts';
export interface RunnerSupervisor {
  start(): Promise<void>;
  request<C extends RunnerChannel>(channel: C, input: RunnerInputOf<C>, opts?: { timeoutMs?: number }): Promise<IpcResult<C>>;  // data: RunnerOutputOf<C>
  shutdown(opts: { graceMs: number }): Promise<void>;
  state(): { state: 'starting'|'ready'|'restarting'|'unavailable'; pid?: number; lastHeartbeatAt?: EpochMs; restarts: number };
}
```
- `utilityProcess.fork(runnerEntryPath, [], { serviceName: 'relay-runner', stdio: 'pipe', env: minimalEnv() })`, where `runnerEntryPath` comes from `import runnerEntryPath from '../runner/runner?modulePath'` (H9).
- `minimalEnv()` contains only:
  - `RELAY_USER_DATA_DIR = app.getPath('userData')` — **always** set, so the runner uses the same (possibly overridden) userData as main;
  - `HOME = os.homedir()` and `TMPDIR = os.tmpdir()` (the runner and Node's `os` need them; the env is otherwise empty);
  - `RELAY_PROVIDER_MODE` (the effective mode from H1), `RELAY_FAKE_SCENARIO` (fake mode only), `RELAY_E2E`, `RELAY_CRASH_AT` (only when `RELAY_E2E=1`), and `NODE_ENV`.

  **No API keys**, and nothing else is inherited from `process.env`.
- **stdout/stderr drain:** `child.stdout` and `child.stderr` are always consumed (`on('data')`) and written line-by-line to the main log as `{ event: 'runner.stdout' | 'runner.stderr', line }` (redacted). An unread pipe can fill and block the child.
- Transport: `const { port1, port2 } = new MessageChannelMain(); child.postMessage({ kind: 'init' }, [port2])`. The supervisor attaches `port1.on('message', …)` and then calls **`port1.start()`**; the runner calls **`port.start()`** on its end (H7). `MessagePortMain` queues messages until `start()` is called, so both ends must call it. All protocol messages flow over the port and are validated with `runnerMessageSchema`/`runnerRequestSchema` (02 §B7).
- **Startup:** the supervisor waits for `ready` (sent after migrations, seeding, and recovery). The startup budget is a separate **60 s** timeout; if `ready` doesn't arrive, the child is killed and the attempt counts as a restart. While starting, requests queue for up to 15 s each, then fail with `RUNNER_UNAVAILABLE`.
- Pending request map `id → { resolve, timer }`. The default timeout is 30 s for queries and 60 s for commands.
- **Heartbeat** (applies only after `ready`; never during startup): if there is no heartbeat for `RUNNER_STALE_AFTER_MS` (10 s), the supervisor marks the runner unhealthy and emits `runner.state=restarting`. It kills the child and **waits for the `exit` event** before forking again, so two runners never touch the DB at once (§6.4 "recovery takes ownership only after confirming the previous runner is no longer active"). The DB lease (03 §C6) is a second guard.
- Restart policy: at most 3 restarts in 60 s (window judged on the **monotonic** clock). Each restart waits `RESTART_BACKOFF_MS = [500, 2000, 8000]` (index = restarts already in the window; `SupervisorConfig.restartBackoffMs`), scheduled through the injected timers; the state stays `restarting` during the delay (requests queue up to 15 s), and `shutdown()` cancels a pending backoff. After the limit the state is `unavailable`, every request → `RUNNER_UNAVAILABLE`, and the UI shows a diagnostics banner. (A renderer-callable `app.restartRunner` op needs a contracts change and is not part of this plan.)
- Internals (MAIN-02): the supervisor's own lifecycle is one `phase: 'idle' | 'running' | 'shut_down'` (`shut_down` is final: `start()` rejects); per-generation state (child, port, startup timer, watchdog, heartbeat clocks, `killRequested`) lives in one `Session` object, and every callback checks `session === current` instead of comparing generation numbers.
- `credential.request {id, providerId, purpose: 'dispatch'|'connection_test', attemptId}` messages are answered by `vault.get(providerId)`. The supervisor refuses with `AUTH_REQUIRED` when the provider isn't connected. `purpose` and `attemptId` are logged (never the key).
- `event` messages are forwarded to all windows on `relay/v1/events`.
- `fatal` (for example, migration failure) → `unavailable`, and the details are logged. The UI shows "Database migration failed. Your data was backed up to …" (§18.3).

## H7: Runner entry (`src/runner/runner.ts`, `src/runner/compose.ts`, `src/runner/protocol-server.ts`)
- `runner.ts` waits for `process.parentPort.once('message', e => { port = e.ports[0]; … port.start(); })`, attaching the port listener before `start()`.
- `compose.ts` is a thin wrapper around `createRuntime` from `@relay/engine` (06 §F16), which opens the DB (embedded migrations, 03), seeds the catalog/templates/default profiles (`seedDatabase`), and builds the provider registry, artifact store, projectFs, context/memory, and engine. H does **no** seeding or wiring of its own.
  ```ts
  import { createRuntime, parseCrashAt /* F's exported crash-hook parser, 06 src/testing/crash-hooks.ts */ } from '@relay/engine';
  import { createJsonlCallLog } from '@relay/providers';

  export async function compose(env: RunnerEnv, protocol: ProtocolServer) {
    const userDataDir = env.RELAY_USER_DATA_DIR;                       // always set by minimalEnv
    const fake = env.RELAY_PROVIDER_MODE === 'fake';
    const e2e = env.RELAY_E2E === '1';
    const runtime = await createRuntime({
      userDataDir,
      providerMode: fake ? 'fake' : 'live',
      fakeScenario: fake ? env.RELAY_FAKE_SCENARIO : undefined,
      callLog: fake ? createJsonlCallLog(join(userDataDir, 'fake-call-log.jsonl')) : undefined,
      credentials: { resolve: (req) => protocol.requestCredential(req) },  // {providerId, purpose, attemptId}
      hooks: e2e && env.RELAY_CRASH_AT ? parseCrashAt(env.RELAY_CRASH_AT, { exit: () => process.exit(137) }) : undefined,
      emit: (e) => protocol.sendEvent(e),                              // engine push events → main → renderer
    });
    await runtime.engine.start();                                        // recovery (06 §F9)
    return runtime;                                                       // { engine, db, projectFs, artifacts, providers, dispose }
  }
  ```
  - `RELAY_CRASH_AT` uses F's grammar `<hook>@<stepKey>[#<n>]` and is parsed **only** by F's exported parser, and **only** when `RELAY_E2E === '1'`. Outside E2E the variable is ignored (and main never forwards it). An unparsable value → `fatal` with a clear message.
  - Only after `engine.start()` resolves does the runner post `ready`.
- `protocol-server.ts`:
  - Validates every inbound message.
  - `op` (public runner-routed channels and `INTERNAL_RUNNER_OPS` alike) → `engine.handle(channel, input)` → `op.result` as an `IpcResult` (`toIpc`, 02).
  - Heartbeat interval 2 s, started after `ready`.
  - `sendEvent(e: PushEvent)` posts `{ kind: 'event', event: e }` (validated with `runnerMessageSchema`); compose passes it to `createRuntime` as `emit`.
  - `shutdown` → `engine.stop({graceMs})` → `runtime.dispose()` (closes the DB) → exit 0.
- Logging: `logs/<YYYY-MM-DD>.jsonl`, redacted structured events with `outcome` (§18.3). Files rotate daily, and 14 days are kept.
- **Main file logger is buffered (MAIN-01).** debug/info/warn lines are formatted + redacted at call time, queued, and appended at most every `LOG_FLUSH_INTERVAL_MS` (100 ms) with one `fs.promises.appendFile` per day file. `error` lines are written **synchronously** together with everything queued before them (a crash keeps the line that explains it); if an async batch is already in flight, the error joins the queue and is written right after that batch, so file order always equals call order. `flushSync()` runs from `before-quit` (`BootServices.flushLogs`, after the runner shutdown and before `app.quit()`), from `app.on('quit')`, and from `process.on('uncaughtExceptionMonitor')` (observes without replacing Electron's default handler). Successful `ipc.op` lines are `debug` (failures stay `info`); the file logger has no level filter, so they are still written — just batched.

## H8: Security hardening (`src/main/security.ts`, `build/vite-plugin-csp.ts`) — Electron security checklist (§6.5, [S1])
- **CSP** is generated per mode by the H-owned Vite plugin `apps/desktop/build/vite-plugin-csp.ts` (`relayCsp({ mode })`, a `transformIndexHtml` hook with `order: 'post'`) that injects `<meta http-equiv="Content-Security-Policy">` into `index.html`. The renderer's `index.html` never hand-writes a CSP (10 §J1). The plugin is used by both `electron.vite.config.ts` (renderer) and `vite.renderer.config.ts`.
  - **Production** (strict; this is the policy 00b §6 references):
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`
  - **Dev** (dev server only): the production policy plus `script-src 'sha256-<hash of the React-Refresh preamble>' http://localhost:*` (the plugin hashes the inline preamble that `@vitejs/plugin-react` injects, which is why it runs `post`) and `connect-src ws://localhost:* http://localhost:*` (HMR).
  - `frame-ancestors` is **ignored in a meta CSP**, so it is not emitted there. Framing is prevented by the navigation/window-open/webview denials below.
  - `session.defaultSession.webRequest.onHeadersReceived` sets the dev CSP header (including `frame-ancestors 'none'`) **only** for responses from the dev server when `!app.isPackaged`. Production loads via `file://` and relies on the meta tag.
  - The dev **header** keeps `script-src 'self' 'unsafe-inline' http://localhost:*` (dev only). The React-Refresh preamble is an inline module script, every CSP in force must allow it, and the static header cannot know its hash. The meta CSP allows only the preamble's `sha256-` hash, and the browser enforces both policies, so the effective dev policy admits exactly that one inline script. Removing `'unsafe-inline'` from the header blocks the preamble and breaks dev HMR.
- `app.on('web-contents-created')`:
  - `will-navigate` → `preventDefault()` unless the URL is the app entry.
  - `setWindowOpenHandler(() => ({ action: 'deny' }))`.
  - `will-attach-webview` → prevent.
- `session.setPermissionRequestHandler((_, _p, cb) => cb(false))` denies camera, mic, notifications, and every other permission.
- Protocol: load the renderer from `file://` via `loadFile` in production and from the electron-vite dev server URL in dev. P0 has no custom protocol.
- IPC sender check: `assertTrustedSender` (H4) — null `senderFrame` rejected, exact file URL in production, dev URL only when unpackaged.
- DevTools are enabled only when `!app.isPackaged`, and never auto-open when `RELAY_E2E=1`.

## H9: Build & packaging (`electron.vite.config.ts`, `vite.renderer.config.ts`, `build/**`, `electron-builder.yml`) — ADR-011
- `electron.vite.config.ts` (electron-vite 5):
  - `main`: entry `src/main/index.ts`, `build.externalizeDeps: false` (bundle every dependency, including workspace packages). The runner is **not** a separate input: main imports it with `import runnerEntryPath from '../runner/runner?modulePath'`, electron-vite's utility-process mechanism, which emits the runner as its own chunk under `out/main/` (the `runner.ts` filename makes the chunk match `out/main/*runner*.js`; confirm the emitted name at H9 start and adjust the gate glob if electron-vite's naming differs). This is the **only** runner build mechanism.
  - `preload`: entry `src/preload/index.ts`, `build.externalizeDeps: false`, output format **CJS** (`rollupOptions.output.format: 'cjs'`), so the sandboxed preload has no runtime `require` of workspace packages.
  - The runner chunk inherits main's `externalizeDeps: false`: engine, storage (with embedded migrations), providers (with the statically imported catalog and fake fixtures), tools, and templates are all inlined.
  - `rollupOptions.external: ['electron']` for main and preload — the **only** external. Node built-ins stay runtime imports; in particular `node:sqlite` is never bundled or polyfilled (gate greps for it).
  - `renderer`: root `src/renderer` with `@vitejs/plugin-react`, `@tailwindcss/vite`, `relayCsp()`, `notices.provide()` and `chunkBudget()`.
  - **Minification (PERF-01).** electron-vite 5 defaults every target to `minify: false`; all three builds set `minify: 'esbuild'` and `sourcemap: 'hidden'` (`.map` files without a `sourceMappingURL` comment). Main and preload (and the runner, whose nested build inherits main's config) also set `esbuild.keepNames: true`, so V8 stack-trace frames, `error.name` and `constructor.name` keep their source names; positions map back through the `.map` files, which stay in `out/` and are excluded from the package (`"!out/**/*.map"`). Measured 2026-10-01: renderer entry 2,112.6 → 915.9 kB, runner chunk 3,780.9 → 1,840.8 kB, main `index.js` 342.8 → 193.6 kB, preload 274.2 → 149.4 kB.
  - **Entry-chunk budget:** `build/vite-plugin-chunk-budget.ts` fails the renderer build when an entry chunk exceeds `RENDERER_ENTRY_BUDGET_BYTES` (1.2 MB, minified, uncompressed).
  - **Third-party notices (LIC-01):** `build/vite-plugin-third-party-notices.ts`. One store (`thirdPartyNotices()`) is shared by `collect('main')` (which also sees the nested runner build: electron-vite reuses main's plugins for it), `collect('preload')`, and the renderer's `provide()`; electron-vite builds main → preload → renderer sequentially in one process. Each collector maps the bundle's module ids and asset `originalFileNames` to package roots (the LAST `node_modules/<name>` or `node_modules/@scope/<name>` segment, so pnpm's `.pnpm/<x>/node_modules/<name>` works), reads `name`/`version`/`license` and every `LICENSE*`/`LICENCE*`/`COPYING*` file, and groups packages by identical text. The renderer imports `virtual:third-party-notices` (lazily, via `features/settings/third-party-notices.ts`, its only importer); `load` emits a placeholder that `generateBundle` (order `post`, after minification) replaces with the JSON — the renderer's own graph is complete only then. `tailwindcss` is added explicitly (its preflight is inlined by the compiler with no module id). A renderer built without the main/preload builds is marked `partial`; dev (serve) gets an empty stub. Settings → About renders one `<details>` per license group with a CopyButton. Chromium's notices ship as `Contents/Resources/LICENSES.chromium.html` and Electron's license as `LICENSE.electron.txt` (`extraResources` from `node_modules/electron/dist`).
  - There is **no** migrations copy step: migrations are embedded TS modules (03), so the runner chunk contains the SQL (gate greps for `CREATE TABLE runs`).
- `vite.renderer.config.ts`: renderer-only Vite config for `pnpm dev:renderer` (root `src/renderer`, same plugins including `relayCsp({ mode: 'development' })`), which serves the renderer on the fake bridge in a normal browser (10 §J).
- `build/vite-plugin-csp.ts`: see H8.
- `electron-builder.yml` (electron-builder 26):
  ```yaml
  appId: dev.relay.prototype
  productName: Relay
  directories: { output: dist, buildResources: resources }
  files: ["out/**/*", "!out/**/*.map", "package.json"]   # everything is bundled into out/**; hidden sourcemaps never ship
  extraResources:
    - { from: "node_modules/electron/dist/LICENSE", to: "LICENSE.electron.txt" }                 # LIC-01
    - { from: "node_modules/electron/dist/LICENSES.chromium.html", to: "LICENSES.chromium.html" }
    - { from: "../../tests/fixtures/sample-api", to: "sample-api", filter: ["**/*", "!.env"] }   # bundled sample (§4.1); fixture .env never shipped
  asar: true
  mac: { target: [{ target: dir, arch: arm64 }, { target: dmg, arch: arm64 }], category: public.app-category.developer-tools,
         hardenedRuntime: false, identity: "-" }    # ad-hoc signature: arm64 macOS refuses to run unsigned code (§18.1) — VERIFY
  electronFuses: { runAsNode: false, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false,
                   enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true,
                   grantFileProtocolExtraPrivileges: true }   # stays enabled: see below
  ```
  - **`GrantFileProtocolExtraPrivileges` stays enabled (decision, 2026-10-01).** The renderer loads from `file://…/out/renderer/index.html` (inside the asar when packaged), and Vite emits `<script type="module" crossorigin>` and `<link rel="stylesheet" crossorigin>`. With the fuse disabled, Chromium treats `file://` as origin `null` and blocks those loads by CORS, so the window stays blank. This was verified by flipping only this fuse on a copy of the Electron 44.5.1 binary and launching the built app: with the fuse on, the renderer mounts; with it off, `index.js` and `index.css` are blocked (`Cross origin requests are only supported for protocol schemes: … http, https`) and `#root` stays empty. Disabling the fuse needs the renderer served from a privileged custom protocol (`protocol.handle`) instead of `file://`, which is a post-P0 change. The setting is explicit in `electron-builder.yml` with this rationale.
  - **Verify task (H9, before M1 packaging):** confirm that electron-builder 26 performs an ad-hoc signature with `identity: "-"` (or find its documented equivalent), and that `codesign -dv dist/mac-arm64/Relay.app` reports `Signature=adhoc`. Record the result in the H9 commit. This is a prototype build: document the Gatekeeper warnings, and never tell users to disable protections. 13 §M1 `verify-package` asserts the ad-hoc signature.
  - **E2E runs against the unpackaged build** (`out/main/index.js`; `apps/desktop/package.json` `main` points there), because Playwright hangs when the `nodeCliInspect` fuse is disabled. The packaged app is smoke-tested separately by `scripts/verify-package.ts` (13 §M1).
- `package.json` scripts (owned by A; requested here): `dev: electron-vite dev`, `dev:renderer: vite --config vite.renderer.config.ts`, `build: electron-vite build`, `package: electron-builder --mac --dir`.

## H10: Samples (`src/main/samples.ts`)
`projects.createSample` copies `process.resourcesPath/sample-api` (or `tests/fixtures/sample-api` in dev) to `userData/samples/sample-api-<n>` with `fs.cp(src, dst, { recursive: true, filter: (p) => basename(p) !== '.env' })`, then calls the internal runner op `projects.createFromRoot` with `isDemo: true` (H4). The `.env` exclusion applies in dev too (the packaged resource already lacks it via the `extraResources` filter). The original fixture is never modified (§1.4).


**Sample location (implementation fix).** The copy must live **outside** userData and `~/Library`, which 05 E1 refuses as project roots. When userData is overridden (dev/E2E) use the sibling `<userData>-samples/`; otherwise `~/Documents/Relay Samples/`. The copy is idempotent per idempotency key.

## Unit tests (owned by H, colocated; `vi.mock('electron')`)

| File | Must cover |
|---|---|
| `main/index.test.ts` | Boot order: userData override → `requestSingleInstanceLock` → `whenReady` → `ipc.register` called **before** `createMainWindow`. `supervisor.start()` rejecting still creates and shows the window. `before-quit`: first call `preventDefault` + awaits `shutdown` then `app.quit()`; second call does not prevent (no re-entry). DevTools not opened when `RELAY_E2E=1` |
| `ipc/router.test.ts` | Null `senderFrame` rejected. Packaged: exact renderer file URL accepted, another `file://` URL rejected, dev URL rejected. Invalid input → `VALIDATION_FAILED` with issues. Thrown error → `INTERNAL` with correlationId and no stack in the result. The rate limit returns `retryAfterMs`. Each call logs `ipc.op` with `outcome`. No `INTERNAL_RUNNER_OPS` channel is registered with `ipcMain`. Unknown channel → `NOT_FOUND`. Dev only: an output violating the catalog schema → `INTERNAL` (packaged passes it through) and an undocumented error code logs `ipc.undocumented_error` (non-strict) or rejects the invoke with `UndeclaredErrorCodeError` (strict, the default under a test runner); a thrown INTERNAL keeps its closed reason. `app.openExternal`: the https-only check behind the schema is an invariant (a non-https URL reaching the handler throws → INTERNAL), not a declared error |
| `ipc/handlers/composite.test.ts` | `projects.create` → `projects.createFromRoot` with the realpath and consumes the token (second use → `NOT_FOUND`). `projects.previewFiles` does not consume. `projects.export`/`ledger.export`/`artifacts.export` → the matching internal `*.exportTo` with a realpath destination; cancel → `exported: false`. `artifacts.importDiff` → `artifacts.importDiffText`. `providers.connect` → `recordCredentialRef`, and a runner failure removes the vault entry. `providers.disconnect` → `deleteCredentialRef`. `app.exportDiagnostics` writes a redacted file (a key seeded in a log line, an error message and an `apiKey` field never reach it). `projects.createSample` → `createFromRoot` with `isDemo: true`. `projects.previewFiles {projectId}` → `previewRoot {projectId}` without touching selections |
| `ipc/handlers/main-handlers.test.ts` | Through the real router: `app.openExternal` https-only (non-https refused before any confirmation; the handler itself also refuses), cancel → `opened: false` and `shell.openExternal` never called, confirm → opens exactly that URL. `app.getInfo` output matches the catalog schema. `projects.pickDirectory` through the `__relayDialogs` seam returns a token + display path (never the realpath); cancel → `selection: null`; an unsafe root → `PERMISSION_DENIED` with no token |
| `ipc/rate-limit.test.ts` | Token bucket refill math with fake timers |
| `credentials.test.ts` | Encryption unavailable → `SECURE_STORAGE_UNAVAILABLE`. `basic_text` → unavailable. The session key is not persisted (no file written). The saved file has mode 0600. The file content ≠ plaintext key. `remove` deletes the file. Async API absent → sync `encryptString` fallback works. `shouldReEncrypt` → rewrite |
| `runner-supervisor.test.ts` | Fake utility process + fake `MessagePortMain` that buffers until `start()`: a supervisor that omits `port1.start()` never sees `ready` (test fails without it). stdout/stderr lines are drained into the log. Waits for `ready`; no `ready` within 60 s → kill + restart. No heartbeat staleness before `ready`. Heartbeat loss after `ready` → kill → waits for exit → backoff → re-fork. Backoff 0.5 s / 2 s / 8 s with fake timers (no fork before the delay; state stays `restarting`; rapid crashes do not exhaust restarts instantly); a runner healthy for longer than the window restarts the backoff at 0.5 s; `shutdown()` during a backoff forks nothing. 3 restarts/60 s → unavailable. `minimalEnv` sets `RELAY_USER_DATA_DIR`, `HOME`, `TMPDIR` and contains no other inherited vars; `RELAY_CRASH_AT` only with `RELAY_E2E=1`. Credential request answered; missing credential → `AUTH_REQUIRED`. Request timeout → `RUNNER_UNAVAILABLE` |
| `dialogs.test.ts` | Selection token expiry. `validateProjectRoot` rejects `/`, the home dir, `/System/…`, `/usr/…`, `/etc` (via `/private/etc`), a root inside userData, and a root **containing** userData; accepts an `os.tmpdir()` subdir. Export dir inside a project → refused by the runner (tested in 05). `__relayDialogs` exists only with `RELAY_E2E=1`; `setStub` merges, `clear` restores native; stubbed paths still validated. `pickDiffFile` refuses a file over 1 MiB (`VALIDATION_FAILED` `too_large`) and accepts exactly 1 MiB |
| `app-paths.test.ts` | `RELAY_USER_DATA_DIR` ignored when packaged without `RELAY_E2E` |
| `security.test.ts` | Fake session/webContents: every permission request and check denied; `will-navigate` blocked except the app entry (exact file URL; dev origin only when unpackaged); `setWindowOpenHandler` denies; `will-attach-webview` prevented; the dev header CSP only for dev-server responses when unpackaged, none when packaged |
| `preload-bridge.test.ts` (in `main/`: the `unit` project collects only `main`/`runner` tests) | `invoke` of a non-allowlisted channel (incl. internal runner ops) → `PERMISSION_DENIED` `channel_not_allowed` and `ipcRenderer.invoke` never called; `subscribe` drops payloads failing `pushEventSchema`; unsubscribe removes the listener; N subscribers share ONE `ipcRenderer` listener and one parse per event; the listener is removed only when the last subscriber leaves and re-attached lazily; unsubscribe is idempotent; a throwing subscriber or one unsubscribing another mid-dispatch does not break the fan-out |
| `logger.test.ts`, `runner/logger.test.ts` | `formatLogLine` / the runner logger redact secret-looking values and drop sensitive keys; daily rotation at UTC midnight with an injected clock; `pruneLogs` keeps 14 days and only touches `YYYY-MM-DD.jsonl`. Buffering (fake fs + fake timers): debug/info/warn reach disk in one async append per window and per day file; `error` is synchronous and lands after the lines queued before it; an error during an in-flight batch keeps file order; `flushSync` writes the queue synchronously; fields are snapshotted at call time; a failing append never rejects. `index.test.ts` asserts `flushLogs` runs after the runner shutdown and before `app.quit()`. Temp dirs only via the ownership-guarded `main/testing/temp-dirs.ts` |
| `samples.test.ts` | Copy skips `.env`; other files (incl. `node_modules/`, `dist/`) copied; calls `projects.createFromRoot` with `isDemo: true` |
| `runner/compose.test.ts` | Calls `createRuntime` (mocked `@relay/engine`) with `fakeScenario` and a JSONL `callLog` at `userData/fake-call-log.jsonl` in fake mode, neither in live mode. `RELAY_CRASH_AT` parsed via F's parser only when `RELAY_E2E=1`; ignored otherwise. `ready` posted only after `engine.start()` resolves. `createRuntime` receives an `emit` function that forwards to `protocol.sendEvent` (assert: calling the captured `emit` with a push event calls `sendEvent` with it) |
| `runner/protocol-server.test.ts` | Runner end calls `port.start()`. Invalid message ignored and logged. `op` (public and internal channels) routed to the engine. `shutdown` → `engine.stop` → `dispose` |
| `build/vite-plugin-csp.test.ts` | Prod meta equals the H8 production policy (no `localhost`, no `unsafe-eval`, no `frame-ancestors`). Dev meta includes the preamble `sha256-` hash and `ws://localhost:*`/`http://localhost:*`. (Requests A's `unit` project include `apps/desktop/build/**/*.test.ts`.) |

## Success Criteria (gate)
- [ ] `pnpm typecheck` → exit 0 (includes the desktop node + web projects)
- [ ] `pnpm test:unit apps/desktop/src/main apps/desktop/src/runner apps/desktop/build` → green
- [ ] `pnpm build` → produces `apps/desktop/out/{main,preload,renderer}` and exactly one `out/main/*runner*.js`
- [ ] `grep -l "node:sqlite" apps/desktop/out/main/*runner*.js` and `grep -l "CREATE TABLE runs" apps/desktop/out/main/*runner*.js` → both match (sqlite is a runtime built-in import; migrations are embedded)
- [ ] `grep -E "require\\([\"']@relay/|require\\([\"']zod" apps/desktop/out/preload/*.js` → no matches (preload is a self-contained CJS bundle)
- [ ] `grep -rE "from [\"']@relay/|require\\([\"']@relay/" apps/desktop/out/main` → no matches (only `electron` and Node built-ins are external)
- [ ] `grep -n "CSP\|Content-Security-Policy" apps/desktop/src/renderer/index.html` → no matches; `apps/desktop/out/renderer/index.html` contains the production meta CSP without `localhost`
- [ ] `pnpm lint` → exit 0 (main imports only `@relay/contracts` + electron)
- [ ] M1 smoke: `RELAY_USER_DATA_DIR=$(mktemp -d) RELAY_PROVIDER_MODE=fake pnpm dev` opens the window, the diagnostics show `runner: ready, schemaVersion: 1`, `fake-call-log.jsonl` is created under that userData after a fake call, and quitting leaves `relay.sqlite` with no `-wal` growth warnings
- [ ] `pnpm package` → `dist/mac-arm64/Relay.app` launches on arm64; `codesign -dv` reports an ad-hoc signature; `Contents/Resources/sample-api/.env` does not exist
- [ ] `grep -rn "apiKey" apps/desktop/src/main | grep -i "log\|console"` → no matches

## Review Checklist
- [ ] Every Electron security checklist item in H8 is present; the CSP comes only from `build/vite-plugin-csp.ts`, and `onHeadersReceived` is dev-only
- [ ] `assertTrustedSender` rejects a null `senderFrame` and requires the exact renderer file URL in production
- [ ] No path supplied by the renderer is ever used for fs access; selection tokens are consumed by `projects.create`; `validateProjectRoot` rejects roots containing userData and system dirs, and allows tmpdir subdirs
- [ ] Composite handlers call only `INTERNAL_RUNNER_OPS` / runner-routed channels via `supervisor.request<RunnerChannel>`; no internal channel is registered with `ipcMain` or allowed by the preload
- [ ] `compose.ts` only wraps `createRuntime`; no seeding or DB/provider wiring in H
- [ ] The runner env contains no secrets and always carries `RELAY_USER_DATA_DIR`, `HOME`, `TMPDIR`
- [ ] Both port ends call `start()`; runner stdout/stderr are drained
- [ ] The supervisor never forks a second runner before the first has exited; heartbeat staleness is applied only after `ready`
- [ ] Boot order matches H1; the window shows even when the runner fails; `before-quit` is guarded against re-entry
- [ ] Fake mode, crash hooks, the `__relayDialogs` seam, and the userData override are impossible in a packaged build without `RELAY_E2E=1`
- [ ] The sample `.env` is excluded from both the packaged resources and the `samples/` copy
- [ ] Build: `externalizeDeps: false` for main/preload/runner, only `electron` external, preload CJS, one `?modulePath` runner build, no migrations copy
- [ ] The `safeStorage` async API names were verified (with sync fallback) and the ad-hoc signing config was verified
