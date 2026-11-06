export const SPEC_SCHEMA_GUIDE = `oc2-ulw executable spec — schema ulw-spec/v1

The file is a YAML frontmatter block followed by a required Markdown body that
explains the design, decisions, references and risks.

For a large spec, write a small valid skeleton first (one requirement, one task,
one check, a short body), then grow it with ulw_spec action=patch. write always
saves the content, reports every structural error and keeps the file in draft,
so a typo never costs a full regeneration.

Top-level keys (no others are allowed):
  schema: ulw-spec/v1            required
  id: lowercase-kebab-slug       required (1-80 chars, a-z 0-9 and single dashes)
  title: string                  required
  sources:                       optional
    - path: workspace-relative path
      sha256: lowercase hex      optional
  requirements:                  required, at least one
    - id: R1                     R<number> (R1, R2, ...)
      text: string
  nonGoals: [string]             optional (strict mode requires at least one)
  tasks:                         required, at least one
    - id: T1                     T<number> (T1, T2, ...)
      title: string
      requirements: [R1]         requirement ids closed by this task
      dependsOn: [T0]            optional task ids
      files: [src/a.ts]          exact paths this task may change, at least one
      checks: [V1]               check ids from the top-level checks list
  checks:                        required, at least one
    - id: V1                     V<number> (V1, V2, ...). Do NOT use C1.
      type: command
      description: string        optional
      argv: [node, --test, x]    non-empty, executed without a shell
      cwd: .                     optional workspace-relative directory
      timeoutMs: 120000          optional, 1..900000
      expect:                    optional
        exitCode: 0              0..255 (default 0)
        stdoutIncludes: [text]   optional
        stderrIncludes: [text]   optional
    - id: V2
      type: procedure
      description: string        optional
      steps: [string]            at least one
      expected: string
      requiredTools: [string]    optional
  review:                        optional
    risk: low|medium|high        default low
    requireAdversarial: boolean  default false

Rules enforced before review:
  - every requirement is referenced by at least one task;
  - every check is referenced by at least one task;
  - every task lists at least one file, requirement and check;
  - dependencies must exist and must not form a cycle;
  - unknown keys anywhere are errors;
  - placeholders such as TODO, TBD, <fill ...> are errors.

Task keys are exactly: id, title, requirements, dependsOn, files, checks.
Do not add task fields such as acceptance, description, owner or estimate; put
that prose in the task title or the Markdown body.
Command-check keys are exactly: id, type, description, argv, cwd, timeoutMs, expect.
Procedure-check keys are exactly: id, type, description, steps, expected, requiredTools.

Minimal valid example (replace the content, keep the shape):

---
schema: ulw-spec/v1
id: example-spec
title: Example executable spec
requirements:
  - id: R1
    text: The example behavior is implemented and tested.
nonGoals:
  - No unrelated refactoring.
tasks:
  - id: T1
    title: Implement the example behavior and its test
    requirements: [R1]
    dependsOn: []
    files: [src/example.ts, test/example.test.ts]
    checks: [V1]
checks:
  - id: V1
    type: command
    description: Run the example test
    argv: [node, --test, test/example.test.ts]
    cwd: .
    expect:
      exitCode: 0
review:
  risk: low
  requireAdversarial: false
---

## Design

Explain the design, the decisions that are not obvious, the references that
were used and the risks that the checks cover. Keep the scope equal to the task
list above.
`;
export function specTemplate(id = "example-spec") {
    const safeId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ? id : "example-spec";
    return `---
schema: ulw-spec/v1
id: ${safeId}
title: Replace with a short imperative title
requirements:
  - id: R1
    text: Describe one observable outcome that must be true when the task is done.
nonGoals:
  - State one thing that is explicitly out of scope.
tasks:
  - id: T1
    title: Implement the first observable outcome and its test
    requirements: [R1]
    dependsOn: []
    files: [src/replace-me.ts, test/replace-me.test.ts]
    checks: [V1]
checks:
  - id: V1
    type: command
    description: Run the focused test
    argv: [node, --test, test/replace-me.test.ts]
    cwd: .
    expect:
      exitCode: 0
review:
  risk: low
  requireAdversarial: false
---

## Design

Replace this body with the design, decisions, references and risks. The body
must explain why this task list is sufficient and what is intentionally out of
scope.
`;
}
//# sourceMappingURL=guide.js.map