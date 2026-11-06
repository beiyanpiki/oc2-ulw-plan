import { relative, resolve } from "node:path";
import type { PluginContext } from "./context.js";
import { Runtime } from "./runtime.js";
import { RunService } from "./run-service.js";
import { isWithin, parseSpec } from "../core/spec.js";
import type { RoleInvocation } from "../core/types.js";
import { loadRun } from "../core/run.js";
import type { RoleBinding } from "./roles.js";

const EDIT_TOOLS = new Set(["edit", "write", "patch"]);
const SHELL_TOOLS = new Set(["shell"]);
const PRODUCT_SCOPE_AGENTS = new Set(["ulw-plan", "ulw-exec", "ulw-worker", "ulw-verifier", "ulw-readonly"]);

function pathsFromInput(input: unknown): string[] {
  if (input === null || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of ["path", "filePath", "file_path"]) {
    if (typeof record[key] === "string") paths.push(record[key] as string);
  }
  if (typeof record.patchText === "string") {
    for (const match of (record.patchText as string).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      if (match[1] !== undefined) paths.push(match[1].trim());
    }
    for (const match of (record.patchText as string).matchAll(/^\*\*\* Move to: (.+)$/gm)) {
      if (match[1] !== undefined) paths.push(match[1].trim());
    }
  }
  return paths;
}

function relativeTarget(workspace: string, target: string): string | undefined {
  const trimmed = target.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (trimmed === "" || trimmed.includes("\0")) return undefined;
  const absolute = resolve(workspace, trimmed);
  if (!isWithin(workspace, absolute)) return undefined;
  return relative(workspace, absolute).replaceAll("\\", "/");
}

export async function registerGuards(ctx: PluginContext, runtime: Runtime): Promise<void> {
  const runs = new RunService(runtime);

  await ctx.tool.hook("execute.before", async (event) => {
    if (!EDIT_TOOLS.has(event.tool) && !SHELL_TOOLS.has(event.tool) && event.tool !== "subagent") return;
    const agent = String(event.agent);
    if (!PRODUCT_SCOPE_AGENTS.has(agent)) return;
    const { workspace } = await runtime.workspaceOfSession(event.sessionID);
    const store = runtime.store(workspace);

    if (agent === "ulw-plan") {
      throw new Error("ulw-plan mode: product edits and shell are disabled. Write planning artifacts through ulw_spec, publish the spec, then stop.");
    }

    const binding = await store.getBinding<RoleBinding>(event.sessionID);
    if (binding !== undefined) {
      const invocation = await store.getInvocation<RoleInvocation>(binding.invocationID);
      if (invocation === undefined || invocation.status !== "running") {
        throw new Error(`ulw role is ${invocation?.status ?? "unbound"}; it may not perform product side effects`);
      }
      if (binding.role !== "worker") throw new Error(`ulw ${binding.role} role is read-only`);
      if (!EDIT_TOOLS.has(event.tool)) {
        throw new Error("ulw worker may only use edit/write and ulw_check; shell and delegation are disabled");
      }
      if (binding.runId === undefined || binding.taskId === undefined || binding.specId === undefined) {
        throw new Error("ulw worker binding is incomplete");
      }
      const run = await loadRun(store, binding.runId);
      if (run.status !== "running") throw new Error(`ulw run is ${run.status}; worker edits are closed`);
      const state = run.tasks[binding.taskId];
      if (state?.status !== "running") throw new Error(`ulw task is ${state?.status ?? "missing"}; worker edits are closed`);
      const file = await runtime.loadSpec(run.specId, workspace);
      if (file === undefined) throw new Error("ulw spec file is missing");
      const parsed = parseSpec(file.content);
      const task = parsed.spec.tasks.find((entry) => entry.id === binding.taskId);
      if (task === undefined) throw new Error("ulw task is missing from the spec");
      const paths = pathsFromInput(event.input);
      if (paths.length === 0) throw new Error("ulw worker edit has no identifiable target path");
      for (const target of paths) {
        const normalized = relativeTarget(workspace, target);
        if (normalized === undefined || !task.files.includes(normalized)) {
          throw new Error(`ulw worker may only edit assigned files; refused: ${target}`);
        }
      }
      return;
    }

    if (agent === "ulw-exec") {
      const active = await runs.findActiveRun(workspace, event.sessionID);
      if (active === undefined) throw new Error("no active ulw run for this session; start one with /ulw-execute");
      if (active.status !== "running") throw new Error(`ulw run is ${active.status}; product side effects are closed`);
      if (!EDIT_TOOLS.has(event.tool)) {
        if (SHELL_TOOLS.has(event.tool)) return;
        throw new Error("ulw executor may not delegate; use ulw_role for independent roles");
      }
      const file = await runtime.loadSpec(active.specId, active.workspace);
      if (file === undefined) throw new Error("ulw spec file is missing");
      const parsed = parseSpec(file.content);
      const scope = new Set(parsed.spec.tasks.flatMap((task) => task.files));
      const paths = pathsFromInput(event.input);
      if (paths.length === 0) throw new Error("ulw edit has no identifiable target path");
      for (const target of paths) {
        const normalized = relativeTarget(active.workspace, target);
        if (normalized === undefined || !scope.has(normalized)) {
          throw new Error(`ulw edit is outside every task scope; refused: ${target}`);
        }
      }
      return;
    }

    throw new Error(`ulw ${agent} is read-only; product side effects are disabled`);
  });
}
