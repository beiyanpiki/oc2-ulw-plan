import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, "../..");

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function authHeader(): string {
  return `Basic ${Buffer.from("opencode:test").toString("base64")}`;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`timed out waiting for ${label}: ${String(last)}`);
}

async function json(url: string, method = "GET", body?: unknown): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method,
    headers: { authorization: authHeader(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}: ${await response.text()}`);
  return (await response.json()) as Record<string, any>;
}

test("isolated OpenCode 2 host loads the plugin, commands, agents and skills", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "oc2-ulw-host-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "README.md"), "host fixture\n");
  await exec("git", ["-C", workspace, "init", "-q"]);
  await exec("git", ["-C", workspace, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", workspace, "config", "user.name", "Test"]);
  await exec("git", ["-C", workspace, "add", "."]);
  await exec("git", ["-C", workspace, "commit", "-qm", "initial"]);
  await exec(process.execPath, [join(packageRoot, "dist/cli.js"), "init", "--project", workspace, "--plugin", packageRoot], { env: { ...process.env, HOME: home } });

  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_PASSWORD: "test",
  };
  let server: ChildProcess | undefined;
  try {
    server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    server.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const base = `http://127.0.0.1:${port}`;
    await waitFor(
      async () => {
        const response = await fetch(`${base}/api/info`, { headers: { authorization: authHeader() } });
        return response.ok;
      },
      20_000,
      "OpenCode server",
    );
    const query = new URLSearchParams({ "location[directory]": workspace }).toString();
    const session = await json(`${base}/api/session`, "POST", { title: "host test", location: { directory: workspace } });
    assert.ok(typeof session.data?.id === "string");
    await waitFor(
      async () => {
        const commands = await json(`${base}/api/command?${query}`);
        return Array.isArray(commands.data) && commands.data.some((entry: { name?: string }) => entry.name === "ulw-plan");
      },
      20_000,
      "ulw commands",
    );
    const commands = await json(`${base}/api/command?${query}`);
    for (const name of ["ulw-plan", "ulw-execute", "ulw-status"]) {
      assert.ok(commands.data.some((entry: { name?: string }) => entry.name === name), `missing command ${name}`);
    }
    const agents = await json(`${base}/api/agent?${query}`);
    for (const id of ["ulw-plan", "ulw-exec", "ulw-readonly", "ulw-verifier", "ulw-worker"]) {
      assert.ok(agents.data.some((entry: { id?: string }) => entry.id === id), `missing agent ${id}`);
    }
    const plugins = await json(`${base}/api/plugin?${query}`);
    assert.ok(plugins.data.some((entry: { id?: string }) => entry.id === "oc2-ulw-plan"), "plugin is not active");
    const skills = await json(`${base}/api/skill?${query}`);
    assert.ok(skills.data.some((entry: { id?: string }) => entry.id === "ulw-plan"), "missing ulw-plan skill");
    assert.ok(skills.data.some((entry: { id?: string }) => entry.id === "ulw-execute"), "missing ulw-execute skill");
  } finally {
    server?.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});
