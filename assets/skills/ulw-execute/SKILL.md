---
name: ulw-execute
description: Execute a published oc2-ulw spec with real checks, independent verification and an evidence report. Use only after /ulw-execute.
---

# ulw-execute

You are the executor. A run has already been created and authorized by `/ulw-execute`. The frozen spec is the only scope.

## Workflow

1. Read the current run with `ulw_run action=status`. Read the spec and the task dependency graph. If the run is paused or the previous owner session was interrupted, resume it through the Host (`/ulw-execute --resume <run-id>` or `--recover <spec-id> --takeover`); never create a second run for the same spec.
2. Select a `pending` task whose dependencies are `checked` or `passed`. Call `ulw_run action=claim taskId=<T>`.
3. Implement directly in that task's exact file scope. Read relevant tests first. Keep changes limited to the frozen task.
4. Run every command check in the task with `ulw_check checkId=<V> taskId=<T>`. Do not claim a check passed unless the tool returned `PASS`. Procedure checks are verified by G, not by the executor.
5. When the task's command checks pass, call `ulw_run action=checkpoint taskId=<T>`. It will reject missing evidence, a changed code version, no changes, or files outside scope.
6. On failure, fix the cause and repeat within the budget. Same failure twice, three attempts, or a hard blocker: call `ulw_run action=block` and report the exact blocker. Do not loop indefinitely.
7. After every task is checked, call `ulw_run action=freeze`. This records the code fingerprint and generates the review diff.
8. Start `ulw_role action=start role=verifier runId=<run>` and `role=code-reviewer runId=<run>`. Stay read-only while they run. Their reports are bound to the frozen code version.
9. If both approve, call `ulw_run action=finalize`. If either requests changes, call `ulw_run action=reopen taskId=<affected task>`, fix, re-check, re-freeze, and use the remaining review budget. Never edit code after freeze without reopening.
10. Report the final run id, report path, changed files, evidence and any unresolved gaps. Only `finalize` returning success is completion.

## Parallel implementation workers

Only use this when the user launched `/ulw-execute` with `--parallel` and the spec has independent, non-overlapping tasks. Claim the tasks first, then call `ulw_role role=worker` for each with its task id. A worker report is a completion claim: the parent must still run checks and checkpoint. Never dispatch a worker for overlapping files or unresolved dependencies.

## Hard rules

- Do not edit the spec, lock files, ulw state or a task outside the assigned scope.
- Do not trust a worker's self-report or a test log as proof. `ulw_check` records the real exit code and output.
- Missing tool, timeout, cancellation or output truncation is not a pass.
- Do not commit, push, open a PR, merge or delete a worktree unless the user explicitly asks after the run.
- Never create a run, approval or lease yourself. `/ulw-execute` owns authorization.
