import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFakeContext } from "../helpers/fake-context.js";
import { Runtime } from "../../src/opencode/runtime.js";
import { SpecService } from "../../src/opencode/spec-service.js";
import { RunService } from "../../src/opencode/run-service.js";
import { prepareWorktree } from "../../src/opencode/worktree.js";
import type { SpecRecord } from "../../src/core/types.js";

const exec = promisify(execFile);

const SPEC = `---
schema: ulw-spec/v1
id: worktree-sample
title: Worktree sample
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

A minimal fixture used only to test copying a frozen spec into a Git worktree. It has one deterministic check and no product behavior.
`;

test("an auto worktree receives the frozen spec and the run resolves back to it", { timeout: 30_000 }, async () => {
  const canonical = await mkdtemp(join(tmpdir(), "oc2-ulw-wt-"));
  await exec("git", ["-C", canonical, "init", "-q"]);
  await exec("git", ["-C", canonical, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", canonical, "config", "user.name", "Test"]);
  await writeFile(join(canonical, "README.md"), "fixture\n");
  await exec("git", ["-C", canonical, "add", "."]);
  await exec("git", ["-C", canonical, "commit", "-qm", "initial"]);
  const fake = createFakeContext({ workspace: canonical });
  const session = await fake.ctx.session.create({ title: "exec", agent: "ulw-exec", location: { directory: canonical } });
  const runtime = new Runtime(fake.ctx);
  const specs = new SpecService(runtime);
  await specs.write({ id: "worktree-sample", content: SPEC }, session.id);
  const store = runtime.store(canonical);
  const record = await store.getSpec<SpecRecord>("worktree-sample");
  assert.ok(record !== undefined);
  record.status = "ready";
  const practicalReport = {
    schema: "ulw-report/v1",
    id: "report-practical",
    invocationId: "role-practical",
    role: "practical-reviewer",
    workspace: canonical,
    childSessionID: "ses_practical",
    specId: "worktree-sample",
    targetHash: record.contentHash,
    payload: { verdict: "approved", blockers: [], notes: [], escalate: false },
    createdAt: Date.now(),
  } as const;
  await store.setReport(practicalReport.id, practicalReport);
  await store.setInvocation("role-practical", {
    schema: "ulw-role-invocation/v1",
    id: "role-practical",
    role: "practical-reviewer",
    workspace: canonical,
    parentSessionID: session.id,
    childSessionID: "ses_practical",
    agent: "ulw-readonly",
    specId: "worktree-sample",
    targetHash: record.contentHash,
    status: "completed",
    reportId: practicalReport.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  record.practical = { hash: record.contentHash, round: 1, verdict: "approved", invocationId: "role-practical", at: Date.now() };
  await store.setSpec("worktree-sample", record);

  const worktree = join(canonical, "..", `${canonical.split("/").pop()}-wt`);
  (fake.ctx.worktree as unknown as { create: () => Promise<{ directory: string }> }).create = async () => {
    await exec("git", ["-C", canonical, "worktree", "add", "--detach", worktree, "HEAD"]);
    return { directory: worktree };
  };
  try {
    const target = await prepareWorktree(fake.ctx, runtime, canonical, "worktree-sample", "auto");
    assert.notEqual(target, canonical);
    assert.match(await readFile(join(target, ".opencode", "ulw", "specs", "worktree-sample.md"), "utf8"), /worktree-sample/);
    const copied = await runtime.store(target).getSpec<SpecRecord>("worktree-sample");
    assert.equal(copied?.contentHash, record.contentHash);

    const runs = new RunService(runtime);
    const run = await runs.start({ specId: "worktree-sample", sessionID: session.id, agent: "ulw-exec", projectID: "project", workspace: target, sessionWorkspace: canonical });
    assert.equal(run.workspace, target);
    const status = await runs.status(run.id, session.id);
    assert.match(status.text, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await runs.pause(run.id, session.id, "test cleanup");
  } finally {
    await exec("git", ["-C", canonical, "worktree", "remove", "--force", worktree]).catch(() => undefined);
    await rm(worktree, { recursive: true, force: true });
  }
});
