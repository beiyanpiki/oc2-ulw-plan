import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeContext } from "../helpers/fake-context.js";
import { Runtime } from "../../src/opencode/runtime.js";
import { SpecService } from "../../src/opencode/spec-service.js";
import { DiagnoseService } from "../../src/opencode/diagnose-service.js";
import { appendDiagnostic } from "../../src/io/diagnostics.js";
import { acquireLock } from "../../src/io/lock.js";
import type { RoleInvocation } from "../../src/core/types.js";

const SPEC = `---
schema: ulw-spec/v1
id: diagnose-sample
title: Diagnose sample
requirements:
  - id: R1
    text: The sample exists.
nonGoals: [No extra work.]
tasks:
  - id: T1
    title: Implement it
    requirements: [R1]
    files: [src/a.ts]
    checks: [V1]
checks:
  - id: V1
    type: command
    argv: [node, -e, "process.exit(0)"]
review:
  risk: low
---

## Design

A minimal valid spec used only to exercise the read-only diagnose snapshot. It has one deterministic check and no external dependencies.
`;

test("diagnose reports spec validity, failed roles, the lock and diagnostics", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "oc2-ulw-diagnose-"));
  const fake = createFakeContext({ workspace });
  const session = await fake.ctx.session.create({ title: "plan", agent: "ulw-plan", location: { directory: workspace } });
  const runtime = new Runtime(fake.ctx);
  const store = runtime.store(workspace);
  const specs = new SpecService(runtime);
  const validation = await specs.write({ id: "diagnose-sample", content: SPEC }, session.id);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));

  const failed: RoleInvocation = {
    schema: "ulw-role-invocation/v1",
    id: "role-failed",
    role: "explorer",
    workspace,
    parentSessionID: session.id,
    childSessionID: "ses_failed",
    agent: "ulw-readonly",
    specId: "diagnose-sample",
    status: "failed",
    error: "role finished without submitting ulw_report",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.setInvocation(failed.id, failed);
  await appendDiagnostic(workspace, {
    sessionID: session.id,
    tool: "ulw_spec",
    action: "write",
    code: "SPEC_UNKNOWN_KEY",
    message: "tasks[0]: unknown key",
  });
  const lock = await acquireLock(workspace, { sessionID: session.id, runID: "run-diagnose" });

  const report = await new DiagnoseService(runtime).report(session.id, 10);
  assert.match(report.text, /# ulw diagnose/);
  assert.match(report.text, /diagnose-sample: status=validating/);
  assert.match(report.text, /valid/);
  assert.match(report.text, /role-failed/);
  assert.match(report.text, /finished without a report/);
  assert.match(report.text, /run-diagnose/);
  assert.match(report.text, /SPEC_UNKNOWN_KEY/);
  assert.ok((report.metadata.warnings as number) >= 1);
  assert.equal(lock.sessionID, session.id);
});
