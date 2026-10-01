# Known limitations (P0 prototype)

These limits are deliberate for the November 2026 prototype. Read them before trusting Relay with real work, and say them out loud in any pitch that touches the area (`docs/demo/pitch-script.md`).

## Platform and distribution

- **One OS.** The prototype is built and tested only on **macOS on Apple silicon (arm64)**. No Intel Mac, Windows, or Linux build exists (ADR-0002).
- **Unsigned (ad-hoc) build, no hardened runtime. This is an accepted risk until a Developer ID exists.** `Relay.app` is ad-hoc signed (`identity: "-"`), not notarized, and runs with `hardenedRuntime: false`. Without a hardened runtime, the OS does not block code injection or debugger attachment from other local processes. **Another process running as the same user could inject code into Relay and decrypt the API keys Relay stored** through the OS-protected storage (Electron `safeStorage` / Keychain). The Electron fuses, which disable `RunAsNode`, `NODE_OPTIONS` and the CLI inspector and enforce asar integrity, narrow this risk but do not remove it. We accept it for invited testers on known machines until there is a Developer ID certificate with hardened runtime and notarization. Do not install the prototype on a machine you share with untrusted software. Opening the build is covered in `docs/release/unsigned-build.md`. Never disable macOS protections to get around this.
- **No automatic updates.** Pilot builds are versioned by hand. Back up before installing a new build (`docs/release/backup-restore.md`).

## What Relay does and does not do

- **No code execution.** Relay never runs generated code, tests, or shell commands. Its output is a patch artifact for a person to review and apply (ADR-0007, ADR-0014). Any benchmark tests in the evaluation run in a disposable environment you prepare yourself, outside Relay (§17.4).
- **No schedules or background work.** Runs happen only while the desktop app is open (ADR-0010). Closing the app stops the run, and a run that was in flight is shown as **interrupted** on the next launch.
- **One fixed workflow template** (review → plan → approve → implement → verify), plus the editor's constrained variants. Agents do not use tools (ADR-0014).

## Money

- **Unknown charges are possible.** A request whose outcome can't be confirmed is recorded as **unknown**, never as $0. Examples: a crash or network loss after the request left the machine, a timeout, an ambiguous gateway answer. Its reserved amount stays as a liability until you decide what to do with it. The provider may or may not have billed it.
- **Tracked usage ≠ provider bill.** Relay's ledger is **tracked usage**: provider-reported, calculated from the price catalog, or estimated, and each amount is labeled. Your provider's invoice is the source of truth. Prices change, catalogs go stale, and some charges (unknown outcomes, provider-side rounding, taxes, minimums) never show up in the tracked total.
- **Budgets limit reservations, not bills.** Relay blocks a new request when the configured reservation policy would be exceeded. It cannot guarantee that the provider bill stays under any amount: an in-flight request can overrun its reservation (§9.5), and unknown outcomes exist.
- **Setup calls that time out create an unknown liability with no way to resolve it.** A provider **connection test** (`Settings → Providers → Test`) is admitted against the monthly **setup allowance**. If the test times out (15 s) or ends ambiguously after the request was sent, its full reservation becomes an **unknown setup liability**. The P0 build has **no screen or action to resolve it**, and it **counts against that month's setup allowance** until the month rolls over. Repeated timed-out tests can use up the setup allowance and block further tests until next month.

## Privacy

- **Local persistence ≠ private inference.** Relay stores projects, memory, runs, and the ledger only on your Mac (SQLite in the app's data folder, no Relay server). However, every model step **sends the selected file contents, your approved rules, and the goal to the provider you chose**, under that provider's data terms. "Local" describes where Relay keeps data, not where inference happens. Use the input preview to see exactly what leaves the machine.
- Secret-looking files (`.env`, key files, credential directories) are excluded and never sent. This exclusion uses patterns and is not a guarantee. Review the preview.
- **Credentials:** keys are stored with OS-protected storage, or kept in memory only (session) if you choose. They never go into exports, logs, or backups. See the hardened-runtime limit above.

## Recovery and data

- Restoring a backup is a manual procedure (`docs/release/backup-restore.md`). The P0 UI has no restore button.
- Completed steps are never re-run automatically. An interrupted run needs your decision to continue.
- The demo profile (`Relay-Demo`) is separate from real use. `pnpm demo:reset` only ever replaces that profile.
