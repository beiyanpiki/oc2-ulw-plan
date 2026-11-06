import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFakeContext } from "../helpers/fake-context.js";
import { readLock } from "../../src/io/lock.js";
import { Runtime } from "../../src/opencode/runtime.js";
import { SpecService } from "../../src/opencode/spec-service.js";
import { RunService } from "../../src/opencode/run-service.js";
import type { ReportRecord, RoleInvocation, RunRecord, SpecRecord } from "../../src/core/types.js";

const exec = promisify(execFile);

const SPEC = `---
schema: ulw-spec/v1
id: service-sample
title: Service sample
requirements:
  - id: R1
    text: The add function returns the sum.
nonGoals: [No extra work.]
tasks:
  - id: T1
    title: Add the function and its test
    requirements: [R1]
    dependsOn: []
    files: [src/math.js, test/math.test.mjs]
    checks: [V1]
checks:
  - id: V1
    type: command
    description: Run the math test
    argv: [node, --test, test/math.test.mjs]
    cwd: .
    expect:
      exitCode: 0
review:
  risk: low
---

## Design

The sample implementation adds a pure addition function and one deterministic test. It intentionally avoids external services, new dependencies, and unrelated behavior.
`;

test("an interrupted owner's run can be taken over explicitly", { timeout: 30_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "oc2-ulw-takeover-"));
  await exec("git", ["-C", workspace, "init", "-q"]);
  await exec("git", ["-C", workspace, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", workspace, "config", "user.name", "Test"]);
  await writeFile(join(workspace, "README.md"), "fixture\n");
  await exec("git", ["-C", workspace, "add", "."]);
  await exec("git", ["-C", workspace, "commit", "-qm", "initial"]);

  const fake = createFakeContext({ workspace });
  const owner = await fake.ctx.session.create({ title: "owner", agent: "ulw-exec", location: { directory: workspace } });
  const next = await fake.ctx.session.create({ title: "next", agent: "ulw-exec", location: { directory: workspace } });
  const runtime = new Runtime(fake.ctx);
  const store = runtime.store(workspace);
  const specs = new SpecService(runtime);
  const runs = new RunService(runtime);
  const spec = `---
schema: ulw-spec/v1
id: takeover-sample
title: Takeover sample
requirements:
  - id: R1
    text: The takeover behavior exists.
nonGoals: [No extra work.]
tasks:
  - id: T1
    title: Implement it
    requirements: [R1]
    files: [src/a.ts]
    checks: [V1]
checks:
  - id: V1
    type: procedure
    steps: [Inspect the result]
    expected: The result is correct
review:
  risk: low
---

## Design

A minimal procedure-only spec used to test explicit run takeover after the owner session is interrupted.
`;
  const validation = await specs.write({ id: "takeover-sample", content: spec }, owner.id);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  const record = await store.getSpec<SpecRecord>("takeover-sample");
  assert.ok(record !== undefined);
  record.status = "ready";
  const report: ReportRecord = {
    schema: "ulw-report/v1",
    id: "report-takeover",
    invocationId: "role-takeover",
    role: "practical-reviewer",
    workspace,
    childSessionID: "ses_takeover",
    specId: "takeover-sample",
    targetHash: record.contentHash,
    payload: { verdict: "approved", blockers: [], notes: [], escalate: false } as never,
    createdAt: Date.now(),
  };
  await store.setReport(report.id, report);
  await store.setInvocation("role-takeover", {
    schema: "ulw-role-invocation/v1",
    id: "role-takeover",
    role: "practical-reviewer",
    workspace,
    parentSessionID: owner.id,
    childSessionID: "ses_takeover",
    agent: "ulw-readonly",
    specId: "takeover-sample",
    targetHash: record.contentHash,
    status: "completed",
    reportId: report.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  record.practical = { hash: record.contentHash, round: 1, verdict: "approved", invocationId: "role-takeover", at: Date.now() };
  await store.setSpec("takeover-sample", record);

  const run = await runs.start({ specId: "takeover-sample", sessionID: owner.id, agent: "ulw-exec", projectID: "project" });
  await runs.claim(run.id, "T1", owner.id);
  await assert.rejects(() => runs.resume(run.id, next.id), /belongs to another session/);
  const ownerSession = fake.sessions.get(owner.id);
  assert.ok(ownerSession !== undefined);
  ownerSession.outcome = "interrupted";
  ownerSession.time = { ...ownerSession.time, busy: Date.now() - 1000, idle: Date.now() };
  const resumed = await runs.resume(run.id, next.id, undefined, true);
  assert.equal(resumed.ownerSessionID, next.id);
  assert.equal(resumed.status, "running");
  const lock = await readLock(workspace);
  assert.equal(lock?.sessionID, next.id);
});

test("a spec can be written, executed, checked, frozen, verified and finalized", { timeout: 30_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "oc2-ulw-service-"));
  await exec("git", ["-C", workspace, "init", "-q"]);
  await exec("git", ["-C", workspace, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", workspace, "config", "user.name", "Test"]);
  await writeFile(join(workspace, "README.md"), "fixture\n");
  await exec("git", ["-C", workspace, "add", "."]);
  await exec("git", ["-C", workspace, "commit", "-qm", "initial"]);

  const fake = createFakeContext({ workspace });
  const created = await fake.ctx.session.create({ title: "exec", agent: "ulw-exec", location: { directory: workspace } });
  const sessionID = created.id;
  const runtime = new Runtime(fake.ctx);
  const store = runtime.store(workspace);
  const specs = new SpecService(runtime);
  const runs = new RunService(runtime);

  const validation = await specs.write({ id: "service-sample", content: SPEC }, sessionID);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  const record = await store.getSpec<SpecRecord>("service-sample");
  assert.ok(record !== undefined);
  record.status = "ready";
  const practicalReport: ReportRecord = {
    schema: "ulw-report/v1",
    id: "report-practical",
    invocationId: "role-practical",
    role: "practical-reviewer",
    workspace,
    childSessionID: "ses_practical",
    specId: "service-sample",
    targetHash: record.contentHash,
    payload: { verdict: "approved", blockers: [], notes: [], escalate: false } as never,
    createdAt: Date.now(),
  };
  await store.setReport(practicalReport.id, practicalReport);
  await store.setInvocation("role-practical", {
    schema: "ulw-role-invocation/v1",
    id: "role-practical",
    role: "practical-reviewer",
    workspace,
    parentSessionID: sessionID,
    childSessionID: "ses_practical",
    agent: "ulw-readonly",
    specId: "service-sample",
    targetHash: record.contentHash,
    status: "completed",
    reportId: practicalReport.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  record.practical = { hash: record.contentHash, round: 1, verdict: "approved", invocationId: "role-practical", at: Date.now() };
  await store.setSpec("service-sample", record);

  const run = await runs.start({ specId: "service-sample", sessionID, agent: "ulw-exec", projectID: "project" });
  assert.equal(run.status, "running");
  await runs.claim(run.id, "T1", sessionID);
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(join(workspace, "src", "math.js"), "export const add = (a, b) => a + b;\n");
  await writeFile(
    join(workspace, "test", "math.test.mjs"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  );

  const check = await runs.check({ checkId: "V1", taskId: "T1" }, sessionID, new AbortController().signal, async (id) => {
    assert.equal(id, "V1");
  });
  assert.equal(check.evidence.passed, true, check.content);
  const checkpoint = await runs.checkpoint(run.id, "T1", sessionID);
  assert.equal(checkpoint.run.tasks.T1?.status, "checked");

  const frozen = await runs.freeze(run.id, sessionID);
  assert.equal(frozen.run.status, "final_verification");
  assert.ok(frozen.run.verificationFingerprint);
  assert.ok((await readFile(frozen.diff, "utf8")).includes("math.js"));

  const targetHash = frozen.run.verificationFingerprint as string;
  const verifierReport: ReportRecord = {
    schema: "ulw-report/v1",
    id: "report-verifier",
    invocationId: "role-verifier",
    role: "verifier",
    workspace,
    childSessionID: "ses_verifier",
    specId: "service-sample",
    runId: run.id,
    targetHash,
    payload: {
      verdict: "approved",
      requirements: [{ id: "R1", status: "satisfied", evidence: [check.evidence.outputPath ?? "check"] }],
      procedures: [],
      notes: [],
    } as never,
    createdAt: Date.now(),
  };
  const codeReport: ReportRecord = {
    schema: "ulw-report/v1",
    id: "report-code",
    invocationId: "role-code",
    role: "code-reviewer",
    workspace,
    childSessionID: "ses_code",
    specId: "service-sample",
    runId: run.id,
    targetHash,
    payload: { verdict: "approved", findings: [], notes: [] } as never,
    createdAt: Date.now(),
  };
  const invocation = (id: string, role: "verifier" | "code-reviewer", reportId: string): RoleInvocation => ({
    schema: "ulw-role-invocation/v1",
    id,
    role,
    workspace,
    parentSessionID: sessionID,
    childSessionID: `ses_${role}`,
    agent: role === "verifier" ? "ulw-verifier" : "ulw-readonly",
    specId: "service-sample",
    runId: run.id,
    targetHash,
    status: "completed",
    reportId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await store.setReport(verifierReport.id, verifierReport);
  await store.setReport(codeReport.id, codeReport);
  await store.setInvocation("role-verifier", invocation("role-verifier", "verifier", verifierReport.id));
  await store.setInvocation("role-code", invocation("role-code", "code-reviewer", codeReport.id));

  const finalized = await runs.finalize(run.id, sessionID);
  assert.equal(finalized.run.status, "succeeded");
  assert.ok(finalized.run.reportPath);
  const report = await readFile(finalized.run.reportPath as string, "utf8");
  assert.match(report, /R1/);
  assert.match(report, /succeeded/);
  const status = await runs.status(run.id, sessionID);
  assert.match(status.text, /status: succeeded/);
});
