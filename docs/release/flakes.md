# Flake log (12 §L5)

Log a test here when it fails once and then passes on retry, locally or in CI. A retry hides a flake; it does not fix it. Every entry must be **fixed** (not just retried or skipped) before the M6 freeze.

How to investigate (12 §L5): rerun with `RELAY_E2E_KEEP=1`. The userData path is written to `test-results/last-userdata.txt` (DB, logs, `fake-call-log.jsonl`). Open the trace with `npx playwright show-trace test-results/<test>/trace.zip`.

| Date | Test (file › name) | Where (local/CI, OS) | Symptom | Suspected cause | Fix (commit / PR) | Status |
|---|---|---|---|---|---|---|
| | | | | | | |

Status values: `open` · `investigating` · `fixed` (link the fix and the repeated green reruns that confirm it) · `won't fix` (needs a written reason; never for a P0 acceptance flow).

No flakes logged as of 2026-10-01.
