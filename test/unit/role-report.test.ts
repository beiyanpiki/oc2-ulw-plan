import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeContext } from "../helpers/fake-context.js";
import { Runtime } from "../../src/opencode/runtime.js";
import { SpecService } from "../../src/opencode/spec-service.js";
import { RoleService } from "../../src/opencode/roles.js";
import { loadSpecRecord } from "../../src/core/spec-record.js";
import type { RoleInvocation } from "../../src/core/types.js";

const SPEC = `---
schema: ulw-spec/v1
id: report-binding
title: Report binding
requirements:
  - id: R1
    text: The fixture exists.
nonGoals: [No extra work.]
tasks:
  - id: T1
    title: Create the fixture
    requirements: [R1]
    dependsOn: []
    files: [fixture.txt]
    checks: [V1]
checks:
  - id: V1
    type: command
    argv: [node, -e, "process.exit(0)"]
    cwd: .
review:
  risk: low
---

## Design

A minimal fixture used only to test that role reports are bound to the Host-created child session. It has one deterministic check.
`;

test("only the bound child session can submit a plan-review report", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "oc2-ulw-report-"));
  const fake = createFakeContext({ workspace });
  const parent = await fake.ctx.session.create({ title: "parent", agent: "ulw-plan", location: { directory: workspace } });
  const child = await fake.ctx.session.create({ title: "child", agent: "ulw-readonly", parentID: parent.id, location: { directory: workspace } });
  const runtime = new Runtime(fake.ctx);
  const specs = new SpecService(runtime);
  const written = await specs.write({ id: "report-binding", content: SPEC }, parent.id);
  const store = runtime.store(workspace);
  const invocation: RoleInvocation = {
    schema: "ulw-role-invocation/v1",
    id: "role-review",
    role: "practical-reviewer",
    workspace,
    parentSessionID: parent.id,
    childSessionID: child.id,
    agent: "ulw-readonly",
    specId: "report-binding",
    targetHash: written.hash,
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.setInvocation(invocation.id, invocation);
  await store.setBinding(child.id, {
    schema: "ulw-role-binding/v1",
    invocationID: invocation.id,
    workspace,
    role: "practical-reviewer",
    parentSessionID: parent.id,
    specId: "report-binding",
    targetHash: written.hash,
  });

  const roles = new RoleService(runtime);
  const forged = await fake.ctx.session.create({ title: "forged", agent: "ulw-readonly", location: { directory: workspace } });
  await assert.rejects(
    () => roles.report(forged.id, { verdict: "approved", blockers: [], notes: [], escalate: false } as never),
    /only a role session/,
  );
  const report = await roles.report(child.id, { verdict: "approved", blockers: [], notes: [], escalate: false } as never);
  assert.equal(report.role, "practical-reviewer");
  assert.equal(report.targetHash, written.hash);
  const completed = await store.getInvocation<RoleInvocation>(invocation.id);
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.reportId, report.id);
  const record = await loadSpecRecord(store, "report-binding");
  assert.equal(record.practical?.verdict, "approved");
});
