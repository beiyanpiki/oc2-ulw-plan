import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginContext } from "./context.js";
import { UlwError } from "../core/errors.js";
import { isWithin, isSpecSlug } from "../core/spec.js";
import { Runtime } from "./runtime.js";
import { SpecService } from "./spec-service.js";
import { RunService } from "./run-service.js";
import { prepareWorktree } from "./worktree.js";

interface ParsedArgs {
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

interface CommandInvocation {
  sessionID: string;
  prompt: {
    text: string;
    files?: unknown;
    agents?: unknown;
    skills?: unknown;
    metadata?: unknown;
  };
  delivery: "steer" | "queue";
}

function parseArgs(text: string, valueFlags: string[], flags: string[]): ParsedArgs {
  const tokens = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const positionals: string[] = [];
  const set = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (valueFlags.includes(token)) {
      const value = tokens[index + 1];
      if (value === undefined) throw new UlwError("ARGS", `${token} needs a value`);
      values.set(token, value.replace(/^["']|["']$/g, ""));
      index += 1;
    } else if (flags.includes(token)) {
      set.add(token);
    } else {
      positionals.push(token.replace(/^["']|["']$/g, ""));
    }
  }
  return { positionals, flags: set, values };
}

function commandText(invocation: CommandInvocation): string {
  return invocation.prompt.text.trim();
}

function promptRequest(invocation: CommandInvocation, text: string): Record<string, unknown> {
  return {
    sessionID: invocation.sessionID,
    text,
    delivery: invocation.delivery,
    ...(invocation.prompt.files === undefined ? {} : { files: invocation.prompt.files }),
    ...(invocation.prompt.agents === undefined ? {} : { agents: invocation.prompt.agents }),
    ...(invocation.prompt.skills === undefined ? {} : { skills: invocation.prompt.skills }),
    ...(invocation.prompt.metadata === undefined ? {} : { metadata: invocation.prompt.metadata }),
  };
}

export async function registerCommands(ctx: PluginContext, runtime: Runtime): Promise<void> {
  const specs = new SpecService(runtime);
  const runs = new RunService(runtime);

  await ctx.command.transform((editor) => {
    editor.add({
      name: "ulw-plan",
      description: "Explore a request or existing spec and produce a frozen, reviewed implementation spec.",
      execute: async (invocation: CommandInvocation) => {
        const args = parseArgs(commandText(invocation), ["--spec", "--id"], ["--consult", "--strict"]);
        const sourceSpec = args.values.get("--spec");
        const requestedID = args.values.get("--id");
        const request = args.positionals.join(" ").trim();
        if (sourceSpec === undefined && request === "") throw new UlwError("ARGS", "usage: /ulw-plan <request> or /ulw-plan --spec <path>");
        if (requestedID !== undefined && !isSpecSlug(requestedID)) throw new UlwError("ARGS", "--id must be a lowercase kebab-case slug");
        const session = await runtime.session(invocation.sessionID);
        const workspace = runtime.sessionWorkspace(session);
        if (!(await runtime.agentExists("ulw-plan"))) throw new UlwError("AGENT_PROFILE_MISSING", "ulw-plan profile is not installed; run oc2-ulw-plan init");
        await runtime.store(workspace).setPlan(invocation.sessionID, {
          schema: "ulw-plan-session/v1",
          strict: args.flags.has("--strict"),
          ...(sourceSpec === undefined ? {} : { source: sourceSpec }),
          createdAt: Date.now(),
        });
        await runtime.switchAgent(invocation.sessionID, "ulw-plan");
        let specInput = "";
        if (sourceSpec !== undefined) {
          const absolute = join(workspace, sourceSpec);
          if (!isWithin(workspace, absolute)) throw new UlwError("SOURCE_OUTSIDE", "spec source must stay inside the workspace");
          const content = await readFile(absolute, "utf8").catch(() => {
            throw new UlwError("SOURCE_MISSING", `spec source does not exist: ${sourceSpec}`);
          });
          specInput =
            content.length <= 128 * 1024
              ? `\nExisting source spec (${sourceSpec}), treat it as the scope input and do not modify it:\n\n${content}`
              : `\nExisting source spec: ${sourceSpec}. Read it with the read tool; it is too large to inline. Do not modify it.`;
        }
        const skill = await runtime.readAsset("skills", "ulw-plan", "SKILL.md");
        const prompt = [
          skill,
          "",
          "COMMAND",
          sourceSpec === undefined ? "The user invoked /ulw-plan with a new request." : `The user invoked /ulw-plan --spec ${sourceSpec}.`,
          requestedID === undefined ? "Choose and record a canonical spec id through ulw_spec action=begin." : `Use spec id: ${requestedID}`,
          args.flags.has("--strict") ? "Strict review is required: use ulw_spec action=begin strict=true and require adversarial review." : "",
          args.flags.has("--consult") ? "Run the consultant role once before practical review." : "",
          "",
          "REQUEST",
          request || "(derived from the source spec)",
          specInput,
          "",
          "Do not implement. Finish by publishing the reviewed spec and stopping with the handoff command.",
        ].filter(Boolean).join("\n");
        await ctx.session.prompt(promptRequest(invocation, prompt) as never);
      },
    } as never);

    editor.add({
      name: "ulw-execute",
      description: "Authorize and execute a published ulw spec; --resume continues a paused run.",
      execute: async (invocation: CommandInvocation) => {
        const args = parseArgs(commandText(invocation), ["--resume", "--worktree"], ["--parallel", "--recover"]);
        const session = await runtime.session(invocation.sessionID);
        const canonical = runtime.sessionWorkspace(session);
        let resumeID = args.values.get("--resume");
        const specID = args.positionals[0];
        const worktreeRequest = args.values.get("--worktree");
        if (resumeID === undefined && args.flags.has("--recover")) {
          const candidates = (await runtime.store(canonical).listRuns<{ id: string; specId: string; ownerSessionID: string; status: string; updatedAt: number }>())
            .map((entry) => entry.value)
            .filter((run) => run.ownerSessionID === invocation.sessionID && run.status === "paused" && (specID === undefined || run.specId === specID))
            .sort((left, right) => right.updatedAt - left.updatedAt);
          if (candidates.length === 0) throw new UlwError("ARGS", "--recover found no paused run for this session and spec");
          resumeID = candidates[0]?.id;
        }
        if (resumeID === undefined && (specID === undefined || !isSpecSlug(specID))) {
          throw new UlwError("ARGS", "usage: /ulw-execute <spec-id> [--parallel] [--worktree auto|path] or /ulw-execute --resume <run-id>");
        }
        if (resumeID !== undefined && worktreeRequest !== undefined) {
          throw new UlwError("ARGS", "--worktree cannot be combined with --resume; the run already records its workspace");
        }
        const targetWorkspace = worktreeRequest === undefined ? canonical : await prepareWorktree(ctx, runtime, canonical, specID as string, worktreeRequest);
        if (!(await runtime.agentExists("ulw-exec"))) throw new UlwError("AGENT_PROFILE_MISSING", "ulw-exec profile is not installed; run oc2-ulw-plan init");
        const run =
          resumeID !== undefined
            ? await runs.resume(resumeID, invocation.sessionID)
            : await runs.start({
                specId: specID as string,
                sessionID: invocation.sessionID,
                agent: "ulw-exec",
                projectID: session.projectID ?? ctx.location.project.id,
                workspace: targetWorkspace,
                sessionWorkspace: canonical,
              });
        try {
          await runtime.switchAgent(invocation.sessionID, "ulw-exec");
        } catch (error) {
          await runs.pause(run.id, invocation.sessionID, "agent switch failed").catch(() => undefined);
          throw error;
        }
        const status = await runs.status(run.id, invocation.sessionID);
        const skill = await runtime.readAsset("skills", "ulw-execute", "SKILL.md");
        const prompt = [
          skill,
          "",
          "AUTHORIZED RUN",
          status.text,
          "",
          `Parallel implementation workers: ${args.flags.has("--parallel") ? "allowed only for independent non-overlapping tasks." : "not requested; implement directly."}`,
          args.values.has("--worktree") ? `Worktree request: ${args.values.get("--worktree")}. The execution adapter must validate it before any edit.` : "Workspace: current checkout.",
          "",
          "Execute the authorized spec now. Do not create a new run, do not edit the spec, and do not claim success before freeze, independent verification, code review and finalize.",
        ].join("\n");
        await ctx.session.prompt(promptRequest(invocation, prompt) as never);
      },
    } as never);

    editor.add({
      name: "ulw-status",
      description: "Show the Host-computed ulw spec/run status, evidence, reviews and next action.",
      execute: async (invocation: CommandInvocation) => {
        const raw = commandText(invocation);
        const target = raw.split(/\s+/)[0] ?? "";
        const session = await runtime.session(invocation.sessionID);
        const workspace = runtime.sessionWorkspace(session);
        const store = runtime.store(workspace);
        let text: string;
        if (target !== "" && target.startsWith("run-")) {
          text = (await runs.status(target, invocation.sessionID)).text;
        } else {
          const active = await runs.findActiveRun(workspace, invocation.sessionID);
          const sessionRun = active ?? (await runs.findSessionRun(workspace, invocation.sessionID));
          if (sessionRun !== undefined) {
            text = (await runs.status(sessionRun.id, invocation.sessionID)).text;
          } else if (target !== "") {
            const record = await specs.status(target, invocation.sessionID);
            text = [
              `# ulw spec ${record.id}`,
              `status: ${record.status}`,
              `risk: ${record.risk}`,
              `hash: ${record.contentHash}`,
              `practical: ${record.practical?.verdict ?? "none"}`,
              `adversarial: ${record.adversarial?.verdict ?? "none"}`,
              `next: ${record.status === "ready" ? `/ulw-execute ${record.id}` : "finish validation and independent review, then ulw_spec action=publish"}`,
            ].join("\n");
          } else {
            const list = await specs.list(invocation.sessionID);
            const runList = (await store.listRuns<{ id: string; status: string; specId: string }>()).map((entry) => entry.value);
            text = [
              "# ulw status",
              "",
              "## Specs",
              ...(list.length === 0 ? ["- none"] : list.map((entry) => `- ${entry.id}: ${entry.status} (${entry.risk})`)),
              "",
              "## Runs",
              ...(runList.length === 0 ? ["- none"] : runList.map((entry) => `- ${entry.id}: ${entry.status} (${entry.specId})`)),
            ].join("\n");
          }
        }
        const prompt = [
          "The Host computed the following ulw status. Present it to the user faithfully; do not invent or upgrade any state.",
          "",
          text,
        ].join("\n");
        await ctx.session.prompt(promptRequest(invocation, prompt) as never);
      },
    } as never);
  });
}
