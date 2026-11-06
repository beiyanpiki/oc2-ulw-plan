import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeContext } from "../helpers/fake-context.js";
import { Runtime } from "../../src/opencode/runtime.js";
import { SpecService } from "../../src/opencode/spec-service.js";
import { loadSpecRecord, recordPlanReview, saveSpecRecord } from "../../src/core/spec-record.js";
import type { ReportRecord, RoleInvocation } from "../../src/core/types.js";

function spec(id: string, file: string): string {
  return `---
schema: ulw-spec/v1
id: ${id}
title: Publish sample
requirements:
  - id: R1
    text: The behavior is implemented.
nonGoals: [No extra work.]
tasks:
  - id: T1
    title: Implement it
    requirements: [R1]
    dependsOn: []
    files: [${file}]
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

A complete design description with enough detail to be executable and bounded. It deliberately avoids unrelated scope.
`;
}

async function addReview(store: ReturnType<Runtime["store"]>, workspace: string, sessionID: string, specId: string, hash: string, role: "practical-reviewer" | "adversarial-reviewer"): Promise<void> {
  const report: ReportRecord = {
    schema: "ulw-report/v1",
    id: `report-${role}`,
    invocationId: `role-${role}`,
    role,
    workspace,
    childSessionID: `ses_${role}`,
    specId,
    targetHash: hash,
    payload: { verdict: "approved", blockers: [], notes: [], escalate: false } as never,
    createdAt: Date.now(),
  };
  const invocation: RoleInvocation = {
    schema: "ulw-role-invocation/v1",
    id: `role-${role}`,
    role,
    workspace,
    parentSessionID: sessionID,
    childSessionID: `ses_${role}`,
    agent: "ulw-readonly",
    specId,
    targetHash: hash,
    status: "completed",
    reportId: report.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const record = await loadSpecRecord(store, specId);
  recordPlanReview(record, report, invocation.id, role === "practical-reviewer" ? "practical" : "adversarial");
  await saveSpecRecord(store, record);
  await store.setReport(report.id, report);
  await store.setInvocation(invocation.id, invocation);
}

test("publish requires a bound practical approval and high-risk adversarial approval", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "oc2-ulw-publish-"));
  const fake = createFakeContext({ workspace });
  const session = await fake.ctx.session.create({ title: "plan", agent: "ulw-plan", location: { directory: workspace } });
  const runtime = new Runtime(fake.ctx);
  const store = runtime.store(workspace);
  const specs = new SpecService(runtime);

  const low = await specs.write({ id: "low-risk", content: spec("low-risk", "src/a.ts") }, session.id);
  await assert.rejects(() => specs.publish("low-risk", session.id), /missing practical review/);
  const lowRecord = await loadSpecRecord(store, "low-risk");
  await addReview(store, workspace, session.id, "low-risk", low.hash, "practical-reviewer");
  const published = await specs.publish("low-risk", session.id);
  assert.equal(published.status, "ready");
  assert.equal(lowRecord.contentHash, low.hash);

  const high = await specs.write({ id: "high-risk", content: spec("high-risk", "src/auth/session.ts") }, session.id);
  const highRecord = await loadSpecRecord(store, "high-risk");
  assert.equal(highRecord.risk, "high");
  await addReview(store, workspace, session.id, "high-risk", high.hash, "practical-reviewer");
  await assert.rejects(() => specs.publish("high-risk", session.id), /missing adversarial review/);
  await addReview(store, workspace, session.id, "high-risk", high.hash, "adversarial-reviewer");
  const highPublished = await specs.publish("high-risk", session.id);
  assert.equal(highPublished.status, "ready");
});
