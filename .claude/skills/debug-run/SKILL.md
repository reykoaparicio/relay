---
name: debug-run
description: Diagnose a failed or stalled Crucible agent run. Reads run steps, observations, and error messages to identify root cause and suggest a fix. Trigger on: "debug run", "why did the run fail", "run failed", "diagnose run", "run error".
user-invocable: true
---

# Debug Run

Diagnose why a Crucible agent run failed or stalled, and produce a clear fix recommendation.

## Steps

1. **Fetch run details**
   ```
   GET /projects/:projectId/goals/:goalId/tasks/:taskId/runs/:runId
   ```
   Note the `status`, `failureReason`, and `iterationCount`.

2. **Fetch run steps** (last 20 suffice for most failures)
   ```
   GET /projects/:projectId/goals/:goalId/tasks/:taskId/runs/:runId/steps?limit=20&offset=0
   ```
   Look for steps where `observation.error`, `observation.exitCode !== 0`, or `observation.success === false`.

3. **Fetch tool events** for timing/error patterns
   ```
   GET /projects/:projectId/goals/:goalId/tasks/:taskId/runs/:runId/tool-events
   ```
   Check `summary.errorCount` and `summary.slowToolCount`.

4. **Categorize the failure**
   - `budget_exceeded` → increase `maxBudgetCents` or reduce task scope
   - `max_iterations_hit` → task is too broad; split into smaller tasks
   - `loop_detected` → agent repeated the same action ≥3 times; inject clarifying instructions via `/inject`
   - `failed` with shell errors → check the last step's `observation.stderr` for the command that failed
   - `failed` with LLM errors → infrastructure issue; retry the run

5. **Output a structured diagnosis**
   ```
   ## Run Diagnosis: <runId>

   Status: <status>
   Root cause: <1 sentence>
   Failing step: #<stepNumber> — <actionType>
   Error: <observation.error or stderr>

   ## Recommended Fix
   <specific actionable recommendation>
   ```

## Tips

- A `loop_detected` status means `loopDetectionCount` hit the threshold. Use the inject endpoint to break the loop with explicit instructions.
- For `budget_exceeded`, check `costCents` on each step — a single expensive LLM call or runaway loop is usually the culprit.
- Always check the last 3 steps first; failure context is usually in the final observations.
