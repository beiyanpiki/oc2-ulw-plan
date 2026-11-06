import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpec } from "../../src/core/spec.js";
import { MemoryStore, WorkspaceStore } from "../../src/core/store.js";
import { checkpointTask, claimTask, completeRun, createRun, recordTaskFailure, saveRun } from "../../src/core/run.js";
import type { CheckEvidence } from "../../src/core/types.js";

const parsed = parseSpec(`---
schema: ulw-spec/v1
id: run-sample
title: Run sample
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
    files: [src/b.ts]
    checks: [V1]
checks:
  - id: V1
    type: command
    argv: [node, --test, test/a.test.ts]
    cwd: .
review:
  risk: low
---

## Design

The sample design is explicit and bounded. It does not add unrelated behavior.
`);

const now = Date.now();

function newRun() {
  const store = new WorkspaceStore(new MemoryStore(), "ws");
  const run = createRun({
    spec: parsed.spec,
    specHash: parsed.sha256,
    sourceHashes: {},
    workspace: "/tmp/ws",
    projectID: "p1",
    ownerSessionID: "s1",
    ownerAgent: "ulw-exec",
    baselineCommit: "abc",
    baselineFiles: {},
    lockToken: "lock",
    evidenceDir: "/tmp/ws/.opencode/ulw/evidence/run",
  });
  return { store, run };
}

function evidence(taskId: string, fingerprint: string, checkId = "V1"): CheckEvidence {
  return {
    schema: "ulw-check-evidence/v1",
    id: `${taskId}-${checkId}`,
    runId: "run",
    taskId,
    checkId,
    attempt: 1,
    kind: "command",
    codeFingerprint: fingerprint,
    argv: ["node", "--test"],
    cwd: ".",
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    passed: true,
    outputTruncated: false,
    summary: "ok",
    startedAt: now,
    finishedAt: now,
  };
}

test("claim respects dependencies and checkpoint needs matching evidence", async () => {
  const { store, run } = newRun();
  await saveRun(store, run);
  await claimTask(store, run, parsed.spec, "T1", "s1");
  assert.equal(run.tasks.T1?.status, "running");
  await assert.rejects(() => claimTask(store, run, parsed.spec, "T2", "s1"), /waits for T1/);
  await assert.rejects(
    () => checkpointTask(store, run, parsed.spec, "T1", "fp", ["src/a.ts"], []),
    /no passing evidence/,
  );
  const checked = await checkpointTask(store, run, parsed.spec, "T1", "fp", ["src/a.ts"], [evidence("T1", "fp")]);
  assert.equal(checked.tasks.T1?.status, "checked");
  assert.equal(checked.tasks.T1?.fingerprint, "fp");
});

test("checkpoint rejects changes outside task scope", async () => {
  const { store, run } = newRun();
  await saveRun(store, run);
  await claimTask(store, run, parsed.spec, "T1", "s1");
  await assert.rejects(
    () => checkpointTask(store, run, parsed.spec, "T1", "fp", ["src/b.ts"], [evidence("T1", "fp")]),
    /outside its scope/,
  );
});

test("repeated identical failures block a task", async () => {
  const { store, run } = newRun();
  await saveRun(store, run);
  await claimTask(store, run, parsed.spec, "T1", "s1");
  const first = await recordTaskFailure(store, run, "T1", "V1: exit code 1");
  assert.equal(first.blocked, false);
  const second = await recordTaskFailure(store, run, "T1", "V1: exit code 1");
  assert.equal(second.blocked, true);
  assert.equal(run.tasks.T1?.status, "blocked");
});

test("completion requires both final approvals and a matching code version", async () => {
  const { store, run } = newRun();
  await saveRun(store, run);
  await claimTask(store, run, parsed.spec, "T1", "s1");
  await checkpointTask(store, run, parsed.spec, "T1", "fp", ["src/a.ts"], [evidence("T1", "fp")]);
  await claimTask(store, run, parsed.spec, "T2", "s1");
  await checkpointTask(store, run, parsed.spec, "T2", "fp", ["src/b.ts"], [evidence("T2", "fp")]);
  run.status = "final_verification";
  run.verificationFingerprint = "fp";
  await saveRun(store, run);
  const report = (role: "verifier" | "code-reviewer") => ({
    targetHash: "fp",
    role,
    payload: { verdict: "approved" },
  });
  const base = {
    run,
    spec: parsed.spec,
    currentSpecHash: parsed.sha256,
    currentFingerprint: "fp",
    changedFiles: ["src/a.ts"],
    verifierInvocation: { targetHash: "fp", status: "completed", reportId: "r1" },
    codeInvocation: { targetHash: "fp", status: "completed", reportId: "r2" },
    verifierReport: report("verifier"),
    codeReport: report("code-reviewer"),
    reportPath: "/tmp/report.md",
  };
  await assert.rejects(
    () => completeRun(store, { ...base, changedFiles: ["src/c.ts"] }),
    /outside every task scope/,
  );
  const completed = await completeRun(store, base);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.tasks.T1?.status, "passed");
});
