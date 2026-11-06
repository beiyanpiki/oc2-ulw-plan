import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpec } from "../../src/core/spec.js";
import { validateRoleReport, isApprovedPlanReport } from "../../src/core/reports.js";
import type { ReportRecord } from "../../src/core/types.js";

const parsed = parseSpec(`---
schema: ulw-spec/v1
id: report-sample
title: Report sample
requirements:
  - id: R1
    text: Return the expected value.
nonGoals: [No extra work.]
tasks:
  - id: T1
    title: Implement it
    requirements: [R1]
    dependsOn: []
    files: [src/a.ts, test/a.test.ts]
    checks: [V1]
  - id: T2
    title: Verify it
    requirements: [R1]
    dependsOn: [T1]
    files: [src/a.ts]
    checks: [V1]
checks:
  - id: V1
    type: command
    argv: [node, --test, test/a.test.ts]
    cwd: .
  - id: V2
    type: procedure
    description: Observe the real surface
    steps: [Open the app, call the endpoint]
    expected: 200 with the new value
review:
  risk: low
---

## Design

The sample design is explicit and bounded. It does not add unrelated behavior.
`);

function report(role: ReportRecord["role"], payload: unknown): ReportRecord {
  return {
    schema: "ulw-report/v1",
    id: "r1",
    invocationId: "i1",
    role,
    workspace: "/tmp/ws",
    childSessionID: "s1",
    targetHash: "a".repeat(64),
    payload: payload as never,
    createdAt: 1,
  };
}

test("practical approval with blockers is contradictory", () => {
  assert.throws(
    () =>
      validateRoleReport(
        "practical-reviewer",
        { verdict: "approved", blockers: [{ description: "gap", evidence: ["spec:1"], category: "requirement_gap" }], notes: [] } as never,
        { spec: parsed.spec },
      ),
    /approved review cannot carry blockers/,
  );
});

test("practical approval with no blockers is approved", () => {
  validateRoleReport("practical-reviewer", { verdict: "approved", blockers: [], notes: [], escalate: false } as never, { spec: parsed.spec });
  assert.equal(isApprovedPlanReport(report("practical-reviewer", { verdict: "approved", blockers: [] })), true);
});

test("verifier must cover every requirement and procedure", () => {
  assert.throws(
    () => validateRoleReport("verifier", { verdict: "approved", requirements: [{ id: "R1", status: "satisfied", evidence: ["test"] }], procedures: [] } as never, { spec: parsed.spec }),
    /did not report procedure V2/,
  );
  validateRoleReport(
    "verifier",
    {
      verdict: "approved",
      requirements: [{ id: "R1", status: "satisfied", evidence: ["test"] }],
      procedures: [{ checkId: "V2", status: "passed", evidence: ["manual run"] }],
      notes: [],
    } as never,
    { spec: parsed.spec },
  );
});

test("code review approval with a major finding is contradictory", () => {
  assert.throws(
    () =>
      validateRoleReport(
        "code-reviewer",
        { verdict: "approved", findings: [{ severity: "major", file: "src/a.ts", line: 2, description: "bug" }], notes: [] } as never,
        { spec: parsed.spec },
      ),
    /blocker or major/,
  );
});

test("worker cannot report files outside its task", () => {
  assert.throws(
    () =>
      validateRoleReport(
        "worker",
        { taskId: "T1", status: "completed", changedFiles: ["src/other.ts"], summary: "done", knownIssues: [] } as never,
        { spec: parsed.spec, task: parsed.spec.tasks[0] },
      ),
    /outside task scope/,
  );
});
