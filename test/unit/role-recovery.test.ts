import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeContext } from "../helpers/fake-context.js";
import { Runtime } from "../../src/opencode/runtime.js";
import { SpecService } from "../../src/opencode/spec-service.js";
import { RoleService } from "../../src/opencode/roles.js";
import { registerCommands } from "../../src/opencode/commands.js";
import { registerTools } from "../../src/opencode/tools.js";
import type { ModelRef, RoleBudgetGrant, RoleInvocation } from "../../src/core/types.js";

const SPEC = `---
schema: ulw-spec/v1
id: recovery-sample
title: Review recovery
requirements:
  - id: R1
    text: The fixture exists.
tasks:
  - id: T1
    title: Implement the fixture
    requirements: [R1]
    files: [fixture.txt]
    checks: [V1]
checks:
  - id: V1
    type: command
    argv: [node, --version]
review:
  risk: low
---

## Design

An isolated fixture for testing review recovery without starting any real model.
`;

async function fixture(agentModels?: Record<string, ModelRef>) {
  const workspace = await mkdtemp(join(tmpdir(), "oc2-ulw-recovery-"));
  const fake = createFakeContext({ workspace, ...(agentModels === undefined ? {} : { agentModels }) });
  const parent = await fake.ctx.session.create({ title: "parent", agent: "ulw-plan", location: { directory: workspace } });
  const runtime = new Runtime(fake.ctx);
  const specs = new SpecService(runtime);
  const written = await specs.write({ id: "recovery-sample", content: SPEC }, parent.id);
  const roles = new RoleService(runtime);
  // Complete admission without model I/O, so foreground waiting terminates.
  fake.ctx.session.prompt = (async ({ sessionID }: { sessionID: string }) => {
    fake.sessions.get(sessionID)!.outcome = "succeeded";
  }) as never;
  const start = (sessionID = parent.id) => roles.start({ role: "practical-reviewer", specId: "recovery-sample", background: false }, { sessionID, agent: "ulw-plan" });
  const seed = async (status: RoleInvocation["status"], id: string) => {
    await runtime.store(workspace).setInvocation(id, {
      schema: "ulw-role-invocation/v1", id, role: "practical-reviewer", workspace,
      parentSessionID: parent.id, childSessionID: `child-${id}`, agent: "ulw-readonly",
      specId: "recovery-sample", budgetKey: "recovery-sample", targetHash: written.hash,
      status, ...(status === "completed" ? { reportId: `report-${id}` } : {}), createdAt: 1, updatedAt: 1,
    } satisfies RoleInvocation);
  };
  return { ...fake, workspace, parent, runtime, specs, roles, written, start, seed };
}

test("child roles inherit the parent's chosen model and variant", async () => {
  const f = await fixture();
  const model = { providerID: "fixture", id: "parent-model", variant: "careful" };
  f.sessions.get(f.parent.id)!.model = model;
  const result = await f.start();
  assert.deepEqual(f.sessions.get(result.childSessionID)?.model, model);
  assert.deepEqual((await f.runtime.store(f.workspace).getInvocation<RoleInvocation>(result.invocationID))?.model, model);
});

test("an explicitly configured role model takes precedence over inheritance", async () => {
  const roleModel = { providerID: "fixture", id: "review-model" };
  const f = await fixture({ "ulw-readonly": roleModel });
  f.sessions.get(f.parent.id)!.model = { providerID: "fixture", id: "parent-model" };
  const result = await f.start();
  assert.deepEqual(f.sessions.get(result.childSessionID)?.model, roleModel);
});

test("a parent agent model is inherited when no session override was selected", async () => {
  const model = { providerID: "fixture", id: "configured-parent-model" };
  const f = await fixture({ "ulw-plan": model });
  const result = await f.start();
  assert.deepEqual(f.sessions.get(result.childSessionID)?.model, model);
});

test("the incident's completed review plus timeout permits exactly one automatic retry", async () => {
  const f = await fixture();
  await f.seed("completed", "first");
  await f.seed("timed_out", "timeout");
  assert.equal((await f.start()).status, "failed");
  await assert.rejects(f.start, /budget exhausted/);
  assert.equal((await f.runtime.store(f.workspace).getInvocation<RoleInvocation>("timeout"))?.status, "timed_out");
});

test("a user command grants one audited attempt without resuming or approving the spec", async () => {
  const f = await fixture();
  await f.seed("completed", "first");
  await f.seed("completed", "second");
  await assert.rejects(f.start, /budget exhausted/);
  await registerCommands(f.ctx, f.runtime);
  let confirmation: Record<string, unknown> | undefined;
  f.ctx.session.synthetic = (async (input: Record<string, unknown>) => { confirmation = input; }) as never;
  const command = f.commands.find((entry) => entry.name === "ulw-review-budget") as { execute: (input: unknown) => Promise<void> };
  await command.execute({ sessionID: f.parent.id, prompt: { text: 'recovery-sample --role practical-reviewer --reason "Host timeout recovery"' }, delivery: "steer" });
  assert.equal(confirmation?.resume, false);
  const grants = await f.runtime.store(f.workspace).listBudgetGrants<RoleBudgetGrant>();
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.value.reason, "Host timeout recovery");
  assert.equal(grants[0]?.value.targetHash, f.written.hash);
  const result = await f.start();
  const invocation = await f.runtime.store(f.workspace).getInvocation<RoleInvocation>(result.invocationID);
  assert.equal(invocation?.budgetGrantId, grants[0]?.id);
  assert.equal((await f.runtime.store(f.workspace).listBudgetGrants<RoleBudgetGrant>())[0]?.value.consumedBy, result.invocationID);
  await assert.rejects(f.start, /budget exhausted/);
  assert.equal((await f.specs.status("recovery-sample", f.parent.id)).practical, undefined);
});

test("a grant cannot be reused by another parent or after a spec hash change", async () => {
  const f = await fixture();
  await f.seed("completed", "first");
  await f.seed("completed", "second");
  await f.roles.grantPlanReviewAttempt("recovery-sample", "practical-reviewer", "one retry", f.parent.id);
  const other = await f.ctx.session.create({ title: "other", agent: "ulw-plan", location: { directory: f.workspace } });
  await assert.rejects(() => f.start(other.id), /budget exhausted/);
  await f.specs.patch({ id: "recovery-sample", edits: [{ old: "title: Review recovery", new: "title: Revised review recovery" }] }, f.parent.id);
  await assert.rejects(f.start, /budget exhausted/);
  assert.equal((await f.runtime.store(f.workspace).listBudgetGrants<RoleBudgetGrant>())[0]?.value.consumedBy, undefined);
});

test("bound child sessions cannot grant their own review budget", async () => {
  const f = await fixture();
  await f.runtime.store(f.workspace).setBinding(f.parent.id, { schema: "ulw-role-binding/v1" });
  await assert.rejects(() => f.roles.grantPlanReviewAttempt("recovery-sample", "practical-reviewer", "self grant", f.parent.id), /cannot grant/);
});

test("budget status is Host-computed and neither grants budget nor resumes a model", async () => {
  const f = await fixture();
  await f.seed("completed", "first");
  await f.seed("timed_out", "timeout");
  await registerCommands(f.ctx, f.runtime);
  let confirmation: Record<string, unknown> | undefined;
  f.ctx.session.synthetic = (async (input: Record<string, unknown>) => { confirmation = input; }) as never;
  f.ctx.session.prompt = (() => { throw new Error("must not resume the model"); }) as never;
  const command = f.commands.find((entry) => entry.name === "ulw-review-budget") as { execute: (input: unknown) => Promise<void> };
  await command.execute({ sessionID: f.parent.id, prompt: { text: "recovery-sample --status" }, delivery: "steer" });
  assert.equal(confirmation?.resume, false);
  assert.match(String(confirmation?.text), /practical-reviewer budget: reports=1\/2 attempts=2\/3/);
  assert.equal((await f.runtime.store(f.workspace).listBudgetGrants()).length, 0);
});

test("concurrent starts reserve the target budget atomically", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([f.start(), f.start()]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await f.roles.list(f.parent.id, f.workspace)).length, 1);
});

test("ULW workflow tools remain directly callable with execute denied", async () => {
  const f = await fixture();
  await registerTools(f.ctx, f.runtime);
  for (const name of ["ulw_spec", "ulw_run", "ulw_check", "ulw_role", "ulw_report", "ulw_diagnose"]) {
    const tool = f.tools.find((entry) => entry.name === name);
    assert.deepEqual(tool?.options, { codemode: false });
  }
  assert.ok(!f.tools.some((entry) => /grant|budget/.test(String(entry.name))));
});
