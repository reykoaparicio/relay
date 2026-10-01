# Pitch script

This script covers the narrative from spec §22.1 and the four-minute demo from §22.2. Every demo segment carries one of three labels, and the presenter says the label out loud:

- **Live**: real providers, running now, on the demo machine.
- **Prepared**: restored from `docs/demo/snapshot/` by `pnpm demo:reset`. The committed snapshot was made with the **deterministic fake provider** (`snapshot.json` → `"generator": "fake-provider"`). Say "prepared with a scripted test provider". **Never present a prepared run as a live model result** (§22.2).
- **Recorded**: a screen recording made earlier. A visible "Recorded" caption stays on screen the whole time it plays.

Before you present, run `docs/demo/rehearsal-checklist.md`. If something breaks, use `docs/demo/recovery-script.md`.

## Narrative (§22.1), about 1 minute before the demo

1. **Problem.** Describe the observed customer problem. Use only interview material the participant allowed you to share, and nothing that identifies confidential work (see `docs/product/interviews/`). If no interview has happened yet, say so. Do not imply that you have observed anything you have not.
2. **Current handoff.** Show how the work moves today: copy context between tools, lose track of decisions, find out the cost afterwards.
3. **What Relay supports.** One fixed workflow: review → plan → **your approval** → implement → verify. It has project memory you approve, a per-run budget enforced in code, and checkpoints that survive a crash.
4. Then the demo (below).
5. **Measurements.** Show the `scripts/evidence-table.ts` output as it stands, with the sample size. If a cell reads "Not yet measured", show it that way. Never round it up into a claim.
6. **Next step and business model.** State the next validation step (pilot sessions, `docs/product/pilot-log.md`) and the hypothesis: a paid personal app, BYOK for companies. Pricing is **not validated** (§20.3).

## Demo sequence (§22.2)

Launch the demo profile (see `docs/demo/rehearsal-checklist.md` → "Launch"). The sidebar has **Projects**, **Runs**, **Memory**, and **Settings**. The button labels below were taken from the renderer source on 2026-10-01; confirm each one at rehearsal.

| Time | Label | Exact clicks | Say (point demonstrated) |
|---|---|---|---|
| 0:00–0:30 | Prepared | **Projects** → *Sample API* → **Manage memory** (or **Memory**) → open the approved rule "Keep the public response format" | "This rule was approved once. Every run of this project gets it." (context persists) |
| 0:30–1:00 | Live (UI only, no request) | **Settings** → **Model profiles**: show Economy / Balanced / Capable and *Balanced · OpenAI*. Back to the project → **New run**: show the **Model profile for each role** and the **Run allowance** | "Every step names its provider and model, and every run has a spending limit." (providers and spending are explicit) |
| 1:00–1:40 | **Live** if providers respond; otherwise **Prepared** | **New run** → **Goal**: "Review the user and order handlers for input-handling and error-handling problems, and propose a fix that keeps the public response format." → **Files to include**: the six `src/` files → **Start**. Fallback: **Runs** → the completed prepared run | "Each step shows up as it happens." (observable step progression) |
| 1:40–2:10 | Live (or Prepared) | In the run inspector, open **The plan that was proposed** → **Files the plan may change** → **Approve plan** | "Nothing gets implemented until a person approves this exact plan." (human control) |
| 2:10–2:40 | Live (or Prepared) | **Proposed patch** → **Copy patch**; open the verify step's review outcome | "The output is a patch you can review. Relay never edits your files." (concrete artifact) |
| 2:40–3:10 | Prepared | **Runs** → the run marked **Blocked** (paused, budget) → show the budget breakdown and **Raise the run allowance** (don't click it) | "No request was sent. The application refused to reserve more than the limit." (limits enforced by application code) |
| 3:10–3:40 | Prepared | Quit Relay (⌘Q) → relaunch → **Runs** → the interrupted run → **Continue from last checkpoint** | "Review and plan finished before the crash and are not run again." (durable recovery) |
| 3:40–4:00 | Live (or Prepared) | **Open the run report** → **Open usage ledger** | "Every charge is labeled reported, calculated, estimated, or unknown." (transparent outcome) |

At 3:10, **Continue from last checkpoint** sends the run to approval. Approving it would start live provider calls on a run whose earlier steps came from the fake provider. **Stop at the approval screen.** Do not approve it during the pitch.

## Claims discipline (§22.3)

You may say these only:

- [ ] "This prototype coordinates two providers." Say it only if the live run actually used two providers, for example with a profile override that moves one step to *Balanced · OpenAI*. The prototype ships three adapters (Anthropic, OpenAI, Gemini). Do not claim more than you show.
- [ ] "It preserves approved project context."
- [ ] "It blocks new requests when the configured reservation policy would be exceeded."

These need measured evidence. Say them only together with `evidence-table.ts` output and its sample size:

- [ ] "It saves time." · "It reduces cost." · "It improves code quality."

Never say these:

- [ ] "Guaranteed never to exceed your provider bill". Unknown charges can happen, and tracked usage is not the provider bill (`docs/release/known-limitations.md`).
- [ ] "Fully autonomous". A human approves every plan.
- [ ] "Enterprise secure". The build is ad-hoc signed, with no hardened runtime.
- [ ] "Works with every agent".
- [ ] "The first platform to do this".

Also check before you present:

- [ ] Every number you say traces to a results file or to `evidence-table.ts` output.
- [ ] Every prepared or recorded segment was labeled out loud.
