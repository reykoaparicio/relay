# Manual baseline notes (spec §17.3 "current manual workflow")

For each evaluation task (`tests/evaluations/tasks/*.json`), the founder or a participant does the task **the way they do it today**, without Relay, and records it here. Use the same task goal, the same input files, and the same rules as the Relay runs. Record the score as a `manual` row in the results folder's `scores.csv`, so `scripts/evidence-table.ts` can count it:

```
config,task,repeat,accepted,correctness,coverage,unintended_changes,explanation,review_minutes,setup_minutes,notes
manual,T1-validate-user-body,1,<yes|no>,<0-2>,<0-2>,<0-2>,<0-2>,<review minutes>,<setup minutes>,"<tools used>"
```

The angle-bracket fields above are placeholders, not values.

Score with `tests/evaluations/rubric.md`. Randomize the order of manual and Relay attempts where you can (§17.3). Don't do a task manually right after reading Relay's answer to it.

## Attempt template

### <task id> · attempt <n> · <YYYY-MM-DD> · by <pseudonym>

- **Tools used (in order):**
- **Context moved by hand (what, how often):**
- **Wall-clock minutes:** · **Human intervention minutes:**
- **Model cost, if known (source: provider console / unknown):**
- **Outcome:** accepted / not accepted, judged with the rubric
- **Rubric:** correctness _ · coverage _ · unintended changes _ · explanation _ · review effort _ min
- **Notes:**

No manual baseline attempts recorded as of 2026-09-30.
