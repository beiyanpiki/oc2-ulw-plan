import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeContext } from "../helpers/fake-context.js";
import { Runtime } from "../../src/opencode/runtime.js";
import { SpecService } from "../../src/opencode/spec-service.js";
import { RoleService } from "../../src/opencode/roles.js";
import { registerTools } from "../../src/opencode/tools.js";
import { createRun, saveRun } from "../../src/core/run.js";
import { parseSpec, sha256 } from "../../src/core/spec.js";
import type { Json, RoleInvocation, RoleName } from "../../src/core/types.js";

const SPEC = `---
schema: ulw-spec/v1
id: hash-fixture
title: Report hash fixture
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

An isolated fixture that distinguishes the frozen executable spec hash from the frozen implementation fingerprint.
`;

async function fixture(role: RoleName) {
  const workspace = await mkdtemp(join(tmpdir(), "oc2-ulw-hash-"));
  const fake = createFakeContext({ workspace });
  const parent = await fake.ctx.session.create({ title: "parent", agent: "ulw-plan", location: { directory: workspace } });
  const child = await fake.ctx.session.create({ title: "child", agent: "ulw-readonly", parentID: parent.id, location: { directory: workspace } });
  const runtime = new Runtime(fake.ctx);
  const store = runtime.store(workspace);
  const specs = new SpecService(runtime);
  const written = await specs.write({ id: "hash-fixture", content: SPEC }, parent.id);
  const runRole = role === "verifier" || role === "code-reviewer" || role === "worker";
  const run = createRun({
    spec: parseSpec(SPEC).spec, specHash: written.hash, sourceHashes: {}, workspace, projectID: "project",
    ownerSessionID: parent.id, ownerAgent: "ulw-exec", baselineCommit: "baseline", baselineFiles: {},
    lockToken: "lock", evidenceDir: join(workspace, "evidence"),
  });
  run.status = role === "worker" ? "running" : "final_verification";
  run.tasks.T1!.status = "running";
  run.verificationFingerprint = sha256("implementation fingerprint, not the spec");
  await saveRun(store, run);
  const targetHash = runRole ? run.verificationFingerprint : written.hash;
  const invocation: RoleInvocation = {
    schema: "ulw-role-invocation/v1", id: "role-fixture", role, workspace, parentSessionID: parent.id,
    childSessionID: child.id, agent: "ulw-readonly", specId: "hash-fixture", targetHash,
    ...(runRole ? { runId: run.id } : {}), ...(role === "worker" ? { taskId: "T1" } : {}),
    status: "running", createdAt: 1, updatedAt: 1,
  };
  await store.setInvocation(invocation.id, invocation);
  await store.setBinding(child.id, {
    schema: "ulw-role-binding/v1", invocationID: invocation.id, role, workspace,
    parentSessionID: parent.id, specId: "hash-fixture", targetHash,
    ...(runRole ? { runId: run.id } : {}), ...(role === "worker" ? { taskId: "T1" } : {}),
  });
  const roles = new RoleService(runtime);
  const payload: Json = role === "verifier"
    ? { verdict: "approved", requirements: [{ id: "R1", status: "satisfied", evidence: ["fixture:1"] }], procedures: [], notes: [] }
    : role === "code-reviewer"
      ? { verdict: "approved", findings: [], notes: [] }
      : role === "worker"
        ? { taskId: "T1", status: "completed", changedFiles: ["fixture.txt"], summary: "Implemented", knownIssues: [] }
        : { verdict: "changes_requested", blockers: [{ description: "Add a deterministic check", evidence: ["fixture:1"], category: "check_gap" }], notes: [], escalate: false };
  return { ...fake, runtime, store, specs, roles, parent, child, workspace, written, run, invocation, payload };
}

for (const role of ["verifier", "code-reviewer"] as const) {
  test(`${role} accepts the correct code fingerprint without comparing it to the spec hash`, async () => {
    const f = await fixture(role);
    assert.notEqual(f.run.specHash, f.run.verificationFingerprint);
    const report = await f.roles.report(f.child.id, f.payload);
    assert.equal(report.targetHash, f.run.verificationFingerprint);
    assert.equal((await f.store.getInvocation<RoleInvocation>(f.invocation.id))?.status, "completed");
  });

  test(`${role} still rejects a changed code fingerprint`, async () => {
    const f = await fixture(role);
    f.run.verificationFingerprint = sha256("changed implementation");
    await saveRun(f.store, f.run);
    await assert.rejects(() => f.roles.report(f.child.id, f.payload), /run fingerprint changed/);
    assert.equal((await f.store.getInvocation<RoleInvocation>(f.invocation.id))?.status, "running");
  });
}

for (const role of ["practical-reviewer", "verifier", "code-reviewer", "worker"] as const) {
  test(`${role} still rejects a changed spec`, async () => {
    const f = await fixture(role);
    await f.specs.patch({ id: "hash-fixture", edits: [{ old: "title: Report hash fixture", new: "title: Changed report hash fixture" }] }, f.parent.id);
    await assert.rejects(() => f.roles.report(f.child.id, f.payload), /spec changed/);
    assert.equal((await f.store.getInvocation<RoleInvocation>(f.invocation.id))?.status, "running");
    assert.equal((await f.store.listReports()).length, 0);
  });
}

test("wait returns the full bound report and blockers in model-visible tool text", async () => {
  const f = await fixture("practical-reviewer");
  const report = await f.roles.report(f.child.id, f.payload);
  const result = await f.roles.wait(f.invocation.id, f.parent.id, f.workspace);
  assert.deepEqual(result.report, report);
  await registerTools(f.ctx, f.runtime);
  const tool = f.tools.find((entry) => entry.name === "ulw_role") as { execute: (input: unknown, context: unknown) => Promise<{ content: string }> };
  const output = await tool.execute({ action: "wait", invocationId: f.invocation.id }, { sessionID: f.parent.id, agent: "ulw-plan" });
  assert.match(output.content, /Add a deterministic check/);
  assert.match(output.content, /fixture:1/);
  assert.match(output.content, new RegExp(f.written.hash));
  await assert.rejects(() => f.roles.wait(f.invocation.id, "another-parent", f.workspace), /another session/);
});

test("cancellation and an already-aborted wait cannot overwrite an accepted report", async () => {
  const f = await fixture("practical-reviewer");
  const report = await f.roles.report(f.child.id, f.payload);
  const controller = new AbortController();
  controller.abort();
  const results = await Promise.all([
    f.roles.cancel(f.invocation.id, f.parent.id, f.workspace),
    f.roles.wait(f.invocation.id, f.parent.id, f.workspace, controller.signal),
  ]);
  assert.ok(results.every((result) => result.status === "completed" && result.reportId === report.id));
  assert.equal((await f.store.getInvocation<RoleInvocation>(f.invocation.id))?.status, "completed");
});

test("reports after cancellation remain closed instead of manufacturing approval", async () => {
  const f = await fixture("practical-reviewer");
  await f.roles.cancel(f.invocation.id, f.parent.id, f.workspace);
  await assert.rejects(() => f.roles.report(f.child.id, f.payload), /role invocation is cancelled/);
  assert.equal((await f.specs.status("hash-fixture", f.parent.id)).practical, undefined);
});
