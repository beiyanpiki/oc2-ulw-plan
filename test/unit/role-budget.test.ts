import { test } from "node:test";
import assert from "node:assert/strict";
import { assertBudget, roleBudget } from "../../src/core/roles.js";
import type { RoleInvocation } from "../../src/core/types.js";

function invocation(id: string, status: RoleInvocation["status"], extra: Partial<RoleInvocation> = {}) {
  const value: RoleInvocation = {
    schema: "ulw-role-invocation/v1", id, role: "practical-reviewer", workspace: "/repo",
    parentSessionID: "parent", childSessionID: `child-${id}`, agent: "ulw-readonly",
    specId: "sample", budgetKey: "sample", targetHash: "version-one", status,
    createdAt: 1, updatedAt: 1, ...extra,
  };
  return { id, value };
}

test("one timeout does not consume the second substantive review", () => {
  const entries = [invocation("first", "completed", { reportId: "report-first" }), invocation("second", "timed_out", { targetHash: "version-two" })];
  const target = { workspace: "/repo", specId: "sample" };
  assert.doesNotThrow(() => assertBudget(entries, "practical-reviewer", target));
  assert.deepEqual(roleBudget(entries, "practical-reviewer", target), { reports: 1, attempts: 2, maxReports: 2, maxAttempts: 3, grantsUsed: 0 });
  assert.throws(() => assertBudget([...entries, invocation("third", "completed", { reportId: "report-third" })], "practical-reviewer", target), /ROLE_BUDGET|budget exhausted/);
});

test("infrastructure retries remain bounded and changing the hash does not reset budget", () => {
  const entries = [invocation("one", "failed"), invocation("two", "timed_out"), invocation("three", "cancelled", { targetHash: "version-three" })];
  assert.throws(() => assertBudget(entries, "practical-reviewer", { workspace: "/repo", specId: "sample" }), /attempts 3\/3/);
  assert.throws(() => assertBudget([invocation("one", "completed"), invocation("two", "completed")], "practical-reviewer", { specId: "sample" }), /reports 2\/2/);
});

test("same spec id in another workspace does not consume this workspace's budget", () => {
  const entries = [invocation("one", "completed"), invocation("two", "completed")];
  assert.doesNotThrow(() => assertBudget(entries, "practical-reviewer", { workspace: "/other", specId: "sample" }));
});

test("an explicitly granted attempt does not reset the ordinary budget or in-flight guard", () => {
  const entries = [invocation("one", "completed"), invocation("two", "completed"), invocation("extra", "failed", { budgetGrantId: "grant-one" })];
  assert.equal(roleBudget(entries, "practical-reviewer", { specId: "sample" }).grantsUsed, 1);
  assert.throws(() => assertBudget(entries, "practical-reviewer", { specId: "sample" }), /reports 2\/2/);
  assert.throws(() => assertBudget([...entries, invocation("running", "running", { budgetGrantId: "grant-two" })], "practical-reviewer", { specId: "sample" }), /already has an invocation/);
});

test("worker failures never create extra side-effecting attempts", () => {
  const entries = ["one", "two", "three"].map((id) => invocation(id, "failed", { role: "worker", runId: "run-one", taskId: "T1" }));
  assert.throws(() => assertBudget(entries, "worker", { workspace: "/repo", runId: "run-one", taskId: "T1" }), /attempts 3\/3/);
});
