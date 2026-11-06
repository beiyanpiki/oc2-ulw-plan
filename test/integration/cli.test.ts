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
