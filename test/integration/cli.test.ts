import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, "../..");

async function cli(args: string[], home: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await exec(process.execPath, ["--import", "tsx", join(packageRoot, "src/cli.ts"), ...args], {
      cwd: packageRoot,
      env: { ...process.env, HOME: home },
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

test("init preserves JSONC config, is idempotent and uninstall removes only owned files", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc2-ulw-cli-"));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(join(project, ".opencode"), { recursive: true });
  await writeFile(
    join(project, ".opencode", "opencode.jsonc"),
    `{
  // keep this comment
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["existing-plugin"],
}
`,
  );
  try {
    const first = await cli(["init", "--project", project, "--plugin", "oc2-ulw-plan"], home);
    assert.equal(first.code, 0, first.stderr);
    const config = await readFile(join(project, ".opencode", "opencode.jsonc"), "utf8");
    assert.match(config, /keep this comment/);
    assert.match(config, /existing-plugin/);
    assert.match(config, /oc2-ulw-plan/);
    const planProfile = await readFile(join(project, ".opencode", "agents", "ulw-plan.md"), "utf8");
    assert.match(planProfile, /ulw planner/);

    const second = await cli(["init", "--project", project, "--plugin", "oc2-ulw-plan"], home);
    assert.equal(second.code, 0, second.stderr);
    assert.equal((await readFile(join(project, ".opencode", "opencode.jsonc"), "utf8")).match(/oc2-ulw-plan/g)?.length, 1);

    const doctor = await cli(["doctor", "--project", project, "--plugin", "oc2-ulw-plan"], home);
    assert.equal(doctor.code, 0, doctor.stderr);

    const removed = await cli(["uninstall", "--project", project], home);
    assert.equal(removed.code, 0, removed.stderr);
    const after = await readFile(join(project, ".opencode", "opencode.jsonc"), "utf8");
    assert.match(after, /existing-plugin/);
    assert.doesNotMatch(after, /oc2-ulw-plan/);
    await assert.rejects(() => readFile(join(project, ".opencode", "agents", "ulw-plan.md"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnose validates specs, reports drafts and reads the diagnostics journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc2-ulw-cli-"));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(project, ".opencode", "ulw", "specs"), { recursive: true });
  await mkdir(join(project, ".opencode", "ulw", "drafts"), { recursive: true });
  await mkdir(home, { recursive: true });
  const valid = `---
schema: ulw-spec/v1
id: good
title: Good spec
requirements:
  - id: R1
    text: The behavior exists.
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

A valid minimal spec used by the diagnose integration test. It has one deterministic check and a narrow body.
`;
  await writeFile(join(project, ".opencode", "ulw", "specs", "good.md"), valid);
  await writeFile(join(project, ".opencode", "ulw", "specs", "bad.md"), valid.replace("id: good", "id: bad").replace("    files: [src/a.ts]", "    files: [src/a.ts]\n    acceptance: true"));
  await writeFile(join(project, ".opencode", "ulw", "drafts", "pending.md"), "---\nid: pending\n---\n");
  await writeFile(
    join(project, ".opencode", "ulw", "diagnostics.jsonl"),
    `${JSON.stringify({ schema: "ulw-diagnostic/v1", at: Date.now(), workspace: project, tool: "ulw_spec", action: "write", code: "SPEC_UNKNOWN_KEY", message: "tasks[0]: unknown key" })}\n`,
  );
  try {
    const result = await cli(["diagnose", "--project", project], home);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /good: valid/);
    assert.match(result.stdout, /bad: INVALID/);
    assert.match(result.stdout, /SPEC_UNKNOWN_KEY/);
    assert.match(result.stdout, /pending: draft/);
    assert.match(result.stdout, /ulw_spec\/write SPEC_UNKNOWN_KEY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init refuses to overwrite a user profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc2-ulw-cli-"));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(join(project, ".opencode", "agents"), { recursive: true });
  await writeFile(join(project, ".opencode", "agents", "ulw-plan.md"), "user-owned\n");
  try {
    const result = await cli(["init", "--project", project, "--plugin", "oc2-ulw-plan"], home);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /refusing to overwrite/);
    assert.equal(await readFile(join(project, ".opencode", "agents", "ulw-plan.md"), "utf8"), "user-owned\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
