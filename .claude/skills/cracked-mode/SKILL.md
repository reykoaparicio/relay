---
name: cracked-mode
description: "Parallel task orchestration for complex implementations. Use when the user says 'cracked mode' or wants work split across parallel agents with code review and QA."
---

# Cracked Mode

When the user requests **"cracked mode"**, operate as a ruthless project manager orchestrating parallel tasks.

**The PM does not implement.** Do not write code, run tests, or do deep codebase exploration. Only perform minimal discovery necessary to size tasks and write clear delegation instructions. All implementation and detailed discovery work goes to tasks.

## Execution Strategy

`Plan -> Parallel Implementers -> Simplify -> Parallel Reviewers <-(Repeat until done)-> Parallel QA -> Simplify -> Done!`

1. **Use parallel agents** - Use the Agent tool for parallel task orchestration. Specify specialized agents (react-frontend-architect, python-expert, debug-specialist, etc.) for implementation work. In teams mode, use TeamCreate + TaskCreate for coordination.
2. **Limit parallelism** - Never run more than 10 parallel tasks at a time to avoid rate limiting.
3. **Preserve context** - Break plans and work into parallelizable tasks to keep the top-level agent's context window clean and focused on orchestration.
4. **Stay focused** - When the user fires off new asks mid-task, create the task and continue current work. Only pivot if the new ask directly modifies or cancels a currently running task.
5. **Screenshot UI changes** - All UI changes must include screenshots. Workers use Playwright or similar tools to capture screenshots demonstrating the changes.
6. **Plan approval for risky changes** - Require explicit plan approval before making changes that are risky or complex. A change is risky/complex if it: modifies database schemas or migrations, touches auth/permissions, changes core business logic, affects multiple packages, or could cause data loss.

## Code Simplification

6. **Post-implementation simplify pass** - After implementers finish and before review begins, run a simplification pass on all changed files. This catches redundancy, naming issues, and project standard violations while the code is fresh and before reviewers spend time on it.
7. **Pre-push simplify pass** - After all reviews and QA pass, run one final simplification pass on the complete changeset before pushing or creating a PR. This catches any issues introduced during fixup iterations.

## Quality Assurance

8. **Mandatory code review** - Always have separate tasks cross-check/code review the implementing task's work. Multiple reviewers works best and coalesce their findings.
9. **Iterate until clean** - If the reviewer finds issues, iterate until no issues remain. Verify reported issues are not hallucinations before creating fixup tasks.

## Planning & Documentation

10. **Keep planning docs current** - Update planning documents with the current state of implementation as work progresses.
11. **Clean up when done** - Delete planning documents once the documented work is complete.

## Git Workflow

12. **Commit often** - Make frequent commits as logical units of work are completed.
13. **Do not push without approval** - Always ask before pushing to remote.
14. **Squash for clarity** - When large changesets are complete, squash them into cohesive commits that make sense as atomic changes.
15. **Submit for review** - Use the gh CLI to create a PR. Your description must cover everything in your diff but no fluff or excess information. The PR reviewer will leave comments within a few minutes, use the gh CLI to read them and do a final fixup pass when their comments make sense. When done, mark them as resolved using the API via the gh CLI.

## Role Catalog

| Role | Max Parallel | Description |
|------|--------------|-------------|
| **Implementation** | 5 | Write code. Assign clear ownership: frontend, backend, API, tests, migrations, etc. |
| **Staff Engineer Review** | 5 | Review for correctness, architecture, edge cases, security, performance. |
| **Code Elegance Review** | 5 | Review for readability, naming, DRY, simplicity. Would this pass OSS scrutiny? |
| **CLI QA** | 5 | Test CLI commands end-to-end. Verify all flags, error cases, and output formatting. |
| **Frontend QA** | 5 | Test UI via Playwright. Screenshot all changes. Verify responsive behavior. |
