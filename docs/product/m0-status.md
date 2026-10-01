# M0 status

Reviewed at the M1 gate. Status as of **2026-09-30**. Source: spec §15.5 (M0 checklist), §20.1, §20.4. The founder updates this file. Nothing here is assumed: an item is "done" only with evidence linked.

| M0 item (§15.5) | Status | Evidence / note |
|---|---|---|
| Five interview attempts completed or documented; aim for five actual conversations | **Not started** | Interviews: **0 completed, 0 attempted** as of 2026-09-30. Template: `docs/product/interviews/TEMPLATE.md` |
| At least one recurring workflow demonstrated by an interviewee | **Not started** | Depends on the interviews |
| Sample project is owned or public and contains no confidential material | Done | `tests/fixtures/sample-api` is founder-owned (README license line); its only secret is the fake marker `sk-fixture-DO-NOT-READ` |
| One supported OS is selected | **Done: macOS on Apple silicon (arm64)**, confirmed by the founder | ADR-0002; builds are `--mac --dir`, arm64 only |
| Initial provider spending cap agreed by the person funding the project | **Not yet confirmed** | No cap has been agreed. §20.4's "$50" is only an example, **not** an agreed cap. Record the cap here only once the funder confirms it, with the date and who confirmed it |
| Deferred features are recorded | Done | ADR-0009 (no hosted backend), ADR-0010 (scheduling after pitch), §21.1 scope-cut order, `docs/release/known-limitations.md` |

## Confirmed product facts

- **Target OS:** macOS, Apple silicon (arm64). Confirmed by the founder.
- **Providers:** Anthropic, OpenAI, Gemini (three BYOK adapters).
- **Product shape:** **BYOK for companies.** Customers bring their own provider keys. Relay ships no provider credits (§20.3).
- **Spending cap:** **not yet confirmed.** Until it is, `pnpm evaluate` and the live tests run only with an explicit per-invocation cap (`--cap-usd`, `RELAY_LIVE_*` caps), chosen and approved by the founder each time.

## Interview count to date

| Date | Interviews completed (cumulative) | Attempts (cumulative) |
|---|---|---|
| 2026-09-30 | 0 | 0 |

## Founder decisions needed

1. **Spending cap.** Agree the initial provider spending cap with the funder (§15.5 M0, §20.4) and record it in the table above.
2. **Single-agent baseline.** The plan wants a baseline of exactly one implementer call. The shipped workflow rules make that unrepresentable: FR-08 requires plan → approval before implement, and every spec needs a `review.v1` revision trigger. `pnpm evaluate --config single-agent` therefore runs a reduced pipeline (plan + one implementer pass + verify, no revision loop), described in `tests/evaluations/rubric.md`. Choose one:
   - (a) accept the reduced baseline and label it as such;
   - (b) add an evaluation-only one-call path outside the shipped engine;
   - (c) record the one-agent baseline by hand, like the manual baseline.
3. **Demo launch mode.** The packaged app honors `RELAY_USER_DATA_DIR` only with `RELAY_E2E=1`, which also enables test seams. The rehearsal checklist therefore launches the unpackaged production build on the `Relay-Demo` profile. Decide whether that is acceptable for the pitch, or whether the packaged app needs a supported way to open a demo profile.
4. **Prepared runs come from the fake provider.** The committed snapshot was generated with the deterministic fake provider, so the pitch must label those runs "prepared with a scripted test provider". If you want prepared runs with real model output, prepare a `Relay-Demo` profile by hand with live providers, then run `scripts/demo-snapshot.ts --from <dir>`.
