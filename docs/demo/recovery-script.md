# Recovery script (live demo)

Stay calm, say what happened, and label what you switch to. A failure you handle openly can still make the reliability point. Don't debug live.

## The provider is down, slow, or rate-limited

The signals: the run sits on a step longer than about 40 s, or it pauses with *rate limited*, *provider unavailable*, or *auth required*.

1. Say: "The provider isn't answering right now. I'll switch to a prepared run."
2. Leave the live run alone (it is paused, not lost). Go to **Runs** and open the **completed prepared run**. Say "Prepared, made with a scripted test provider."
3. Continue the script from 1:40 on that run: plan, patch, review outcome, report.
4. If you need to show a real model output, play the **recorded** complete run with its "Recorded" caption on screen.
5. Afterwards, the paused live run shows the honest state, for example "rate limited, retry after …". You can show it as an example of the recovery design.

## The app crashes or freezes

1. Say: "That's a crash. Relay checkpoints every step, so let's reopen it."
2. If the window is frozen, quit with ⌘Q, or force-quit with ⌥⌘⎋. Relaunch it the same way as before: same command, same `RELAY_USER_DATA_DIR`.
3. **Runs**: the run that was in flight shows **interrupted**. Its succeeded steps are not run again. Open it and point at the unresolved-charges panel if one appears. An in-flight request is labeled *unknown*, never silently dropped.
4. Continue at segment 3:10 with the run that was in flight, or with the prepared interrupted run.
5. If Relay doesn't relaunch, play the recording and say "Recorded".

## Wi-Fi or network fails

1. Say: "We've lost the network. Everything local still works."
2. Prepared segments don't need the network: memory, profiles, the completed run, the budget-blocked run, the interrupted run, the report and the ledger.
3. Do the live segments (1:00–2:40) with the prepared completed run, or play the recording. Label each one.
4. Phone hotspot: only if you tested it at rehearsal. Switching networks mid-run can leave a request *unknown*. That's correct behavior, but explaining it costs time.

## After the pitch

- Don't reuse the demo profile for anything else. Run `pnpm demo:reset` and then `pnpm demo:verify` before the next session.
- If a live run left an *unknown* charge, settle it in the run (**Choose how to continue**). Then check the provider console for the real bill. Tracked usage is not the provider bill.
