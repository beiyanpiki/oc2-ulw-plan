import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeContext } from "../helpers/fake-context.js";
import { Runtime } from "../../src/opencode/runtime.js";
import { SpecService } from "../../src/opencode/spec-service.js";
import { RoleService } from "../../src/opencode/roles.js";
import type { SessionInfo } from "../../src/opencode/session.js";

const SPEC = `---
schema: ulw-spec/v1
id: role-wait
title: Role wait
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

A minimal fixture used only to test bounded role waiting. It has one deterministic command check and no external dependencies.
`;

test("foreground role waits by polling session state instead of the experimental wait API", { timeout: 10_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "oc2-ulw-role-"));
  const fake = createFakeContext({ workspace });
  (fake.ctx as unknown as { options: Record<string, unknown> }).options = { roleTimeoutMs: 3000 };
  const session = await fake.ctx.session.create({ title: "parent", agent: "ulw-plan", location: { directory: workspace } });
  const runtime = new Runtime(fake.ctx);
  const specs = new SpecService(runtime);
  await specs.write({ id: "role-wait", content: SPEC }, session.id);

  // The fake prompt marks the child idle shortly after admission.
  const prompt = fake.ctx.session.prompt as unknown as (input: { sessionID: string }) => Promise<void>;
  (fake.ctx.session as unknown as { prompt: (input: { sessionID: string }) => Promise<void> }).prompt = async (input) => {
    await prompt(input);
    setTimeout(() => {
      const child = fake.sessions.get(input.sessionID) as SessionInfo | undefined;
      if (child !== undefined) {
        child.outcome = "succeeded";
        child.time = { ...child.time, busy: Date.now(), idle: Date.now() + 1 };
      }
    }, 50);
  };

  const roles = new RoleService(runtime);
  const started = Date.now();
  const result = await roles.start(
    { role: "explorer", specId: "role-wait", assignment: "Inspect the fixture.", background: false },
    { sessionID: session.id, agent: "ulw-plan" },
  );
  const elapsed = Date.now() - started;
  assert.notEqual(result.status, "timed_out");
  assert.equal(result.status, "failed");
  assert.ok(elapsed < 2500, `role wait took ${elapsed}ms`);
});
