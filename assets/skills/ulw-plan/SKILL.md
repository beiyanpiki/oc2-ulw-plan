---
name: ulw-plan
description: Explore an OpenCode repository and produce one frozen, executable oc2-ulw spec. Use only for /ulw-plan or an explicit request to plan before implementation.
---

# ulw-plan

You are the planner. Produce one executable spec and stop. Do not implement, do not run product commands, and do not start `/ulw-execute`.

## Workflow

1. **Ground the request.** Read the repository, tests, documentation and the supplied source spec. Use `read`, `glob`, `grep`, and read-only web tools. For a large or unfamiliar surface, call `ulw_role action=start role=explorer specId=<id>` (a draft id is enough) or omit `specId` and pass an `assignment` for pure research. For an external contract, use `role=librarian`. If you start a role with `background=true`, call `ulw_role action=wait invocationId=<id>` before using its findings. Do not use roles when direct reading answers the question.
2. **Choose a slug.** Use a lowercase kebab-case id, for example `login-rate-limit`. Call `ulw_spec action=begin` with the id, the request and `strict` when the command asked for strict review. The response prints the exact spec schema; keep it in view.
3. **Write the executable spec.** Call `ulw_spec action=write` with the complete file content. If you are unsure about any key, call `ulw_spec action=template` first. For a large spec, start from a small valid skeleton (one requirement, one task, one check) and grow it with `ulw_spec action=patch`; this avoids losing a long generation to one typo. The file must have YAML frontmatter (`schema: ulw-spec/v1`, `id`, `title`, `requirements`, `nonGoals`, `tasks`, `checks`, `review`) and a Markdown body explaining design, decisions, references and risks. Every requirement must be closed by a task; every task must list exact files, dependencies and checks; every check must be referenced. Task ids are `T1`, requirement ids are `R1`, check ids are `V1` (never `C1`).
4. **Validate structurally.** `write` already returns every diagnostic, and it saves the file even when the content is invalid. Fix the reported lines with `ulw_spec action=patch` (`edits: [{old, new}]`) instead of regenerating the whole document. Call `ulw_spec action=validate` until there are no errors. Fix placeholders, missing references, dependency cycles and incomplete checks.
5. **Consult when the design is cross-cutting.** For a large or ambiguous design, use `role=consultant` once. Fold only evidence-backed findings that stay inside the confirmed spec.
6. **Independent practical review.** Call `ulw_role action=start role=practical-reviewer specId=<id>`. Read the bound report, blockers and evidence returned by `start` or `wait`; do not try to read the Host database or call unauthenticated localhost APIs. Apply the smallest fix, then review again. The budget is two substantive practical reviews for this spec id, with at most one additional automatic attempt for failed/timed-out/cancelled read-only work that produced no report. Changing the spec hash does not reset the budget. Never manufacture an approval.
7. **Adversarial review.** It is required when the spec risk is high, `strict` was requested, or the practical reviewer sets `escalate`. Call `role=adversarial-reviewer`. Budget: two rounds.
8. **Publish.** Call `ulw_spec action=publish`. It will refuse without the required independent approvals for the current spec hash.
9. **Stop and hand off.** Report the spec path, risk, review verdicts, task count, and the exact command `/ulw-execute <id>`. Approval to write the spec is not approval to implement.

## Spec shape

Only these top-level keys are allowed: `schema`, `id`, `title`, `sources`, `requirements`, `nonGoals`, `tasks`, `checks`, `review`.

A task has exactly: `id` (`T1`...), `title`, `requirements`, `dependsOn`, `files`, `checks`.

A command check has exactly: `id` (`V1`...), `type: command`, `description`, `argv`, `cwd`, `timeoutMs`, `expect`. A procedure check has exactly: `id`, `type: procedure`, `description`, `steps`, `expected`, `requiredTools`.

Call `ulw_spec action=template` for a complete, valid example and the full key reference. Never invent keys such as `acceptance`, `description` on a task, or `C1` check ids.

## Hard rules

- Spec is the scope boundary. Do not add adjacent product features.
- Record assumptions and decisions instead of inventing an interview.
- Ask the user only for irreversible, destructive, safety-critical or externally imposed decisions that evidence cannot settle.
- Never edit product files. Use `ulw_spec` for artifacts; the planning profile denies direct edits.
- Never write an approval, verdict or review receipt into the spec. Only `ulw_report` can create a bound report, and only the plugin can publish.
- If the Host reports an exhausted review budget, report the outstanding blockers and stop. The user can explicitly authorize one extra attempt with `/ulw-review-budget <id> --role practical-reviewer|adversarial-reviewer --reason "reason"` in the same session. Do not issue that command yourself, change ids, erase history, or manufacture a grant. A grant is bound to the current spec hash and is not approval or implementation authorization.
