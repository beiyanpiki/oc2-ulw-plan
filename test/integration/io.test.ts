import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildDiffArtifact, captureBaseline, fingerprintWorkspace, isGitWorkspace } from "../../src/io/repository.js";
import { acquireLock, inspectRecoverable, readLock, releaseLock } from "../../src/io/lock.js";
import { evaluateExpectation, persistCommandEvidence, runProcess } from "../../src/core/evidence.js";
import type { CommandCheck } from "../../src/core/types.js";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args]);
  return stdout;
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oc2-ulw-"));
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "a.txt"), "one\n");
  await writeFile(join(dir, "b.txt"), "two\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "initial");
  return dir;
}

const check: CommandCheck = {
  id: "V1",
  type: "command",
  description: "echo",
  argv: [process.execPath, "-e", "process.stdout.write('ok')"],
  cwd: ".",
  timeoutMs: 5000,
  expect: { exitCode: 0, stdoutIncludes: ["ok"], stderrIncludes: [] },
};

test("captureBaseline detects modified, added and deleted files and builds a diff", async () => {
  const dir = await repo();
  assert.equal(await isGitWorkspace(dir), true);
  const baseline = await captureBaseline(dir, "run-1");
  assert.ok(baseline.commit.length > 0);
  assert.equal(baseline.files["a.txt"]?.sha256.length, 64);
  await writeFile(join(dir, "a.txt"), "changed\n");
  await writeFile(join(dir, "c.txt"), "new\n");
  const fp = await fingerprintWorkspace(dir, baseline.files, baseline.commit);
  assert.deepEqual(fp.changed, ["a.txt"]);
  assert.deepEqual(fp.added, ["c.txt"]);
  const diff = await buildDiffArtifact(dir, "run-1", baseline.files, baseline.commit, fp.dirtyFiles);
  assert.ok(diff.bytes > 0);
  const patch = await readFile(diff.path, "utf8");
  assert.match(patch, /changed/);
  assert.match(patch, /c\.txt/);
});

test("dirty baseline snapshots user changes instead of including them in the run diff", async () => {
  const dir = await repo();
  await writeFile(join(dir, "a.txt"), "user-dirty\n");
  const baseline = await captureBaseline(dir, "run-2");
  await writeFile(join(dir, "a.txt"), "user-dirty\nrun-change\n");
  const fp = await fingerprintWorkspace(dir, baseline.files, baseline.commit);
  assert.deepEqual(fp.changed, ["a.txt"]);
  const diff = await buildDiffArtifact(dir, "run-2", baseline.files, baseline.commit, fp.dirtyFiles);
  const patch = await readFile(diff.path, "utf8");
  assert.match(patch, /\+run-change/);
  assert.doesNotMatch(patch, /-one/);
});

test("workspace lock is exclusive and releases with the same token", async () => {
  const dir = await repo();
  const lock = await acquireLock(dir, { sessionID: "s1", runID: "run-1" });
  assert.equal((await readLock(dir))?.token, lock.token);
  await assert.rejects(() => acquireLock(dir, { sessionID: "s2", runID: "run-2" }), /another run owns/);
  assert.equal((await releaseLock(dir, "wrong")).valueOf(), false);
  assert.equal(await releaseLock(dir, lock.token), true);
  const next = await acquireLock(dir, { sessionID: "s2", runID: "run-2" });
  assert.equal(next.sessionID, "s2");
});

test("lock recovery refuses a live foreign owner", async () => {
  const dir = await repo();
  await acquireLock(dir, { sessionID: "s1", runID: "run-1" });
  const decision = await inspectRecoverable(dir, "s2", "run-2");
  assert.equal(decision.recoverable, false);
  const same = await inspectRecoverable(dir, "s1", "run-1");
  assert.equal(same.recoverable, true);
});

test("command checks capture success and failure with real exit codes", async () => {
  const dir = await repo();
  const ok = await runProcess({ argv: [process.execPath, "-e", "process.stdout.write('ok')"], cwd: dir, timeoutMs: 5000 });
  const okEval = evaluateExpectation(check, ok);
  assert.equal(okEval.passed, true);
  const fail = await runProcess({ argv: [process.execPath, "-e", "process.stdout.write('no'); process.exit(3)"], cwd: dir, timeoutMs: 5000 });
  const failEval = evaluateExpectation(check, fail);
  assert.equal(failEval.passed, false);
  assert.match(failEval.reason, /exit code 3/);
  const evidence = await persistCommandEvidence({
    workspace: dir,
    runId: "run-1",
    taskId: "T1",
    check,
    attempt: 1,
    codeFingerprint: "fp",
    result: ok,
    passed: true,
    reason: okEval.reason,
  });
  assert.equal(evidence.passed, true);
  assert.ok(evidence.outputPath !== undefined);
  assert.match(await readFile(evidence.outputPath as string, "utf8"), /ok/);
});

test("command checks time out and cancellation is never a pass", async () => {
  const dir = await repo();
  const slow: CommandCheck = { ...check, timeoutMs: 100, expect: { exitCode: 0, stdoutIncludes: [], stderrIncludes: [] } };
  const timeout = await runProcess({ argv: [process.execPath, "-e", "setTimeout(() => {}, 1000)"], cwd: dir, timeoutMs: 100 });
  assert.equal(timeout.timedOut, true);
  assert.equal(evaluateExpectation(slow, timeout).passed, false);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const cancelled = await runProcess({ argv: [process.execPath, "-e", "setTimeout(() => {}, 1000)"], cwd: dir, timeoutMs: 5000, signal: controller.signal });
  assert.equal(cancelled.cancelled, true);
  assert.equal(evaluateExpectation(slow, cancelled).passed, false);
});
