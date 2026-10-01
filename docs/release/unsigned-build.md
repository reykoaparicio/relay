# Opening the Relay prototype build (macOS)

The Relay prototype is shared with invited testers as a **prototype build**. It is **ad-hoc signed** and **not notarized** by Apple: it has no Developer ID signature yet (spec §18.1). This page explains what macOS will show you and how to open the app anyway, while leaving your Mac's security settings unchanged.

## What you will see

Gatekeeper checks every app downloaded from the internet. Relay has no Developer ID signature or Apple notarization, so the first time you double-click it macOS shows a warning similar to:

> "Relay" cannot be opened because Apple cannot check it for malicious software.

or

> Apple could not verify "Relay" is free of malware that may harm your Mac or compromise your privacy.

This is expected for this build. Gatekeeper is doing its job: it cannot confirm who made the app.

## Before you open it

Only open a build you received directly from the Relay team, through the channel you were invited on. If you are unsure where a copy came from, delete it and ask us for a fresh one.

## Opening this one app (recommended)

This allows **only Relay**. Every other app on your Mac is still checked as usual.

1. In Finder, open the folder that contains `Relay.app` (for example, Applications).
2. **Right-click** (or Control-click) `Relay.app` and choose **Open**.
3. In the dialog that appears, click **Open** again.

macOS remembers this choice for this copy of Relay, so later launches open normally.

On recent macOS versions the dialog may offer only **Done** or **Move to Trash**. In that case:

1. Click **Done**.
2. Open **System Settings → Privacy & Security** and scroll to the **Security** section.
3. Next to the message about "Relay", click **Open Anyway** and confirm with your password or Touch ID.

This button approves this one app only. It appears for about an hour after the blocked launch.

## What we will never ask you to do

We will never ask you to turn off Gatekeeper or System Integrity Protection, run `spctl` or `xattr` commands, or change your Mac's security settings to "allow apps from anywhere". If any instructions claiming to be from Relay ask for that, do not follow them, and tell us.

## What changes later

When Relay moves beyond the prototype, builds will be signed with an Apple Developer ID and **notarized** by Apple. Notarized builds open without this warning, and the steps on this page will no longer be needed.

## For the team: what the build is

- `pnpm package` produces `apps/desktop/dist/mac-arm64/Relay.app` (`electron-builder --mac --dir`, 08 §H9). The signing identity is `-`, so the app is ad-hoc signed. Apple silicon refuses to run unsigned code, so the ad-hoc signature is required for the app to launch at all.
- `hardenedRuntime: false` is a known, accepted risk until a Developer ID exists. Notarization requires the hardened runtime, so both change together when the app is signed for distribution.
- `pnpm exec tsx --conditions=development scripts/verify-package.ts` checks the build before it is shared: `codesign -dv` reports `Signature=adhoc`, the fuses are set (`RunAsNode` disabled, `OnlyLoadAppFromAsar` enabled), `app.asar` holds the runner with its embedded migrations and contains no `.env`, `.sqlite`, or `tests/` files, the bundled sample is present, and a smoke launch seeds a fresh profile (13 §M1).
- Share the build only with invited testers, and say in the invitation that it is an unnotarized prototype.
