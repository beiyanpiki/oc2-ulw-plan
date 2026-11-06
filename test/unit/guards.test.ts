import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeContext } from "../helpers/fake-context.js";
import { Runtime } from "../../src/opencode/runtime.js";
import { registerGuards } from "../../src/opencode/guards.js";

test("plan profile refuses product edits and shell", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "oc2-ulw-guard-"));
  const fake = createFakeContext({ workspace });
  const session = await fake.ctx.session.create({ title: "plan", agent: "ulw-plan", location: { directory: workspace } });
  await registerGuards(fake.ctx, new Runtime(fake.ctx));
  const hook = fake.toolHooks[0];
  assert.ok(hook !== undefined);
  await assert.rejects(() => Promise.resolve(hook({ tool: "edit", sessionID: session.id, agent: "ulw-plan", input: { path: "src/a.ts" } })), /product edits and shell/);
  await assert.rejects(() => Promise.resolve(hook({ tool: "shell", sessionID: session.id, agent: "ulw-plan", input: { command: "ls" } })), /product edits and shell/);
});

test("exec profile without a run refuses product edits but leaves ordinary agents alone", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "oc2-ulw-guard-"));
  const fake = createFakeContext({ workspace });
  const session = await fake.ctx.session.create({ title: "exec", agent: "ulw-exec", location: { directory: workspace } });
  await registerGuards(fake.ctx, new Runtime(fake.ctx));
  const hook = fake.toolHooks[0];
  assert.ok(hook !== undefined);
  await assert.rejects(() => Promise.resolve(hook({ tool: "edit", sessionID: session.id, agent: "ulw-exec", input: { path: "src/a.ts" } })), /no active ulw run/);
  await assert.doesNotReject(() => Promise.resolve(hook({ tool: "edit", sessionID: session.id, agent: "build", input: { path: "src/a.ts" } })));
});

test("read-only roles cannot edit even with a binding", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "oc2-ulw-guard-"));
  const fake = createFakeContext({ workspace });
  const child = await fake.ctx.session.create({ title: "review", agent: "ulw-readonly", location: { directory: workspace } });
  const store = new Runtime(fake.ctx).store(workspace);
  await store.setBinding(child.id, {
    schema: "ulw-role-binding/v1",
    invocationID: "role-1",
    workspace,
    role: "practical-reviewer",
    parentSessionID: "parent",
    specId: "x",
    targetHash: "hash",
  });
  await store.setInvocation("role-1", {
    schema: "ulw-role-invocation/v1",
    id: "role-1",
    role: "practical-reviewer",
    workspace,
    parentSessionID: "parent",
    childSessionID: child.id,
    agent: "ulw-readonly",
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await registerGuards(fake.ctx, new Runtime(fake.ctx));
  const hook = fake.toolHooks[0];
  assert.ok(hook !== undefined);
  await assert.rejects(() => Promise.resolve(hook({ tool: "edit", sessionID: child.id, agent: "ulw-readonly", input: { path: "src/a.ts" } })), /read-only/);
});
