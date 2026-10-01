# Evaluation rubric (spec §17.4, plan 13 §M4)

The founder scores every run **by hand** in `tests/evaluations/results/<date>/scores.csv`. `scripts/evaluate.ts` never scores quality (§7.7: no self-rating). Score from the run's copied artifacts: the plan, the patch, the review, and the report. Apply the patch in a **disposable** copy of `sample-api` if you want to run its tests. Relay itself never runs code (§17.4).

Each task file lists its own `acceptance` criteria. They are fixed **before** any run, and the model never sees them: only `goal`, `input`, and `approvedRules` are sent.

## Scale (0–2)

| Criterion | 0 | 1 | 2 |
|---|---|---|---|
| **Correctness** (`correctness`) | The change is wrong, would not compile, or breaks behavior | Partly right: the main defect is addressed but an edge case in the acceptance list is wrong | Every acceptance item about behavior holds |
| **Requirement coverage** (`coverage`) | Misses the task's main requirement | Covers some acceptance items | Covers every acceptance item |
| **Unintended changes** (`unintended_changes`) | Changes public response fields, unrelated files, or behavior the task did not ask about | Small unrelated edits (style, renames) a reviewer has to undo | Only what the task needs |
| **Explanation usefulness** (`explanation`) | Missing or misleading | Present, but the reviewer must reconstruct the reasoning | States what changed, why, and what to check |
| **Review effort** (`review_minutes`) | Minutes the reviewer actually spent: reading, checking, and fixing up. A measured number, not a 0–2 score | | |

Optional: `setup_minutes` is the time from a fresh start to the first run started, measured in pilot sessions. It feeds the "Median setup time" row.

## Acceptance rule

A run is **accepted** only if `accepted = yes` **and** correctness = 2 **and** coverage = 2. `scripts/evidence-table.ts` enforces this: `accepted = yes` with any lower correctness or coverage is **not** counted as accepted.

The **denominator** is every attempted run: completed, `incomplete`, `failed`, `cancelled`, and runs stopped by the cost cap (§17.4: "record incomplete and failed runs in the denominator"). A run that didn't complete is not accepted, and needs no quality score. You can still record `review_minutes` for it.

## scores.csv

```
config,task,repeat,accepted,correctness,coverage,unintended_changes,explanation,review_minutes,setup_minutes,notes
```

- `config`: `relay` | `single-agent` | `manual` (manual rows come from `docs/product/baseline-notes.md`).
- `evaluate.ts` writes a blank template with one row per run. Leave a cell blank when it was not measured. Never estimate a value you did not measure.

## Configurations compared (§17.3)

| Config | What runs | Notes |
|---|---|---|
| `relay` | The shipped `review-propose-fix` template: review → plan → approve → implement → verify, up to 2 revision cycles | Same profiles, limits, context, and approved rules for every task |
| `single-agent` | `tests/evaluations/templates/single-step.workflow.json`: plan → approve → implement → verify, `maxRevisionCycles: 0` | **Not literally one call.** The shipped rules require an approved plan before any implementer (FR-08) and a `review.v1` revision trigger in every spec, so this is the smallest valid pipeline: no separate review step and a single implementer pass. Report it as "reduced pipeline", never as "single agent". Evaluation-only; never shipped |
| `manual` | The current manual workflow, recorded by hand | `docs/product/baseline-notes.md` |

In live evaluation, approvals are given by the harness exactly as the UI would show them (the `approvals` count in each result). The run order is randomized (`--seed`). Repeat selected tasks (`--repeat`) to expose variability. Don't spend the whole prototype budget on benchmarking (§17.3).
