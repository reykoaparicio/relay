# Rehearsal checklist (M6, spec §15.5)

Do this on the demo machine, on the day before the pitch and again one hour before it.

## Reset and verify (run each pair twice in a row)

```sh
export RELAY_USER_DATA_DIR="$HOME/Library/Application Support/Relay-Demo"
pnpm demo:reset && pnpm demo:verify
pnpm demo:reset && pnpm demo:verify   # second pass proves the reset is repeatable
```

- [ ] Both `demo:verify` runs end with `demo:verify OK` and print `[ok]` for: profile restored, sample project present and opens, 1 approved rule, completed run with report, budget-blocked run, and interrupted run checkpointed after Plan.
- [ ] `Saved provider keys carried over` shows at least 1 key file. If it shows none, connect the providers in **Settings → Providers** and run **Test** once, then reset again so the keys carry over.

What `demo:reset` does and does not do:

- It refuses any dir not named exactly `Relay-Demo`. Unless `RELAY_USER_DATA_DIR` names the dir explicitly, it also refuses any dir outside `~/Library/Application Support`.
- It refuses to run while Relay is open on that profile. Quit Relay first.
- It moves the old profile aside to `Relay-Demo.previous-<timestamp>` and keeps the newest one. Older ones are deleted only if `demo:reset` created them.
- It restores the sample project to `~/Documents/Relay Demo Samples/sample-api`, because the runner refuses project roots inside `~/Library`. It then points the demo project at that copy.
- It carries over `secrets/` (OS-protected key files) and the matching credential records, so saved keys don't need re-entry. The snapshot itself never contains `secrets/`.

`demo:verify` deviates from plan 13 §M3, which asked for Playwright. It checks the states headlessly through `createRuntime`, using the same runner IPC handlers the UI calls, on a scratch copy of the profile and with the engine not started. There are two reasons:

1. Launching the app runs crash recovery and the engine loop, which would change the very states being checked.
2. Playwright can't attach to the packaged build, because the `nodeCliInspect` fuse is off.

A manual click-through of the pitch script, below, covers the UI.

## Launch

The packaged app honors `RELAY_USER_DATA_DIR` only together with `RELAY_E2E=1`, which also enables test seams. Do not use that for a pitch. Launch the **unpackaged production build** on the demo profile instead:

```sh
pnpm build
RELAY_USER_DATA_DIR="$HOME/Library/Application Support/Relay-Demo" apps/desktop/node_modules/.bin/electron apps/desktop
```

(`pnpm dev` also works, but it serves the renderer from a dev server.) See "Founder decisions" in `docs/product/m0-status.md`.

## Machine and room

- [ ] The demo account and network were tested on the demo machine: one live run reaches **Approve plan** with the providers in use, and `Settings → Providers → Test` succeeds for each.
- [ ] The pitch run uses at least two providers, if you plan to say "coordinates two providers". Use a profile override, for example *Balanced · OpenAI* on one step.
- [ ] Battery: on a charger. Sleep: off (System Settings → Lock Screen → "Turn display off" = Never, or run `caffeinate -dims` in a terminal). Notifications: Do Not Disturb on.
- [ ] Font size: renderer zoomed (⌘+) so code and costs are readable from the back of the room. Terminal font is large.
- [ ] Recording: a complete recorded run exists, plays offline, and shows a visible **"Recorded"** caption the whole time.
- [ ] Clicked through `docs/demo/pitch-script.md` once, end to end, at speaking pace. Every button label matches the script.
- [ ] Ran `docs/demo/recovery-script.md` once: quit mid-run, relaunched, saw **interrupted**.
- [ ] Ran `pnpm demo:reset && pnpm demo:verify` again after the click-through, because rehearsal changes the prepared runs.
- [ ] Every claim you plan to make is on the allowed list, or comes with `evidence-table.ts` output (`docs/demo/pitch-script.md` → Claims discipline).
