import type { Json } from "../core/types.js";
import { UlwError } from "../core/errors.js";
import type { PluginContext } from "./context.js";
import { Runtime } from "./runtime.js";
import { SpecService } from "./spec-service.js";
import { RunService } from "./run-service.js";
import { RoleService } from "./roles.js";

type ToolInput = Record<string, unknown>;
type ToolResult = { content: string; metadata?: Record<string, unknown> };
interface ToolContextLike {
  sessionID: string;
  agent: string;
  messageID: never;
  id: never;
  signal: AbortSignal;
}

function textResult(content: string, metadata?: Record<string, unknown>): ToolResult {
  return metadata === undefined ? { content } : { content, metadata };
}

function stringInput(input: ToolInput, key: string, required = true): string | undefined {
  const value = input[key];
  if (value === undefined) {
    if (required) throw new UlwError("INPUT_REQUIRED", `${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new UlwError("INPUT_TYPE", `${key} must be a string`);
  return value;
}

function numberInput(input: ToolInput, key: string, fallback: number): number {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new UlwError("INPUT_TYPE", `${key} must be a number`);
  return value;
}

function boolInput(input: ToolInput, key: string): boolean {
  return input[key] === true;
}

export async function registerTools(ctx: PluginContext, runtime: Runtime): Promise<void> {
  const specs = new SpecService(runtime);
  const runs = new RunService(runtime);
  const roles = new RoleService(runtime);

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "ulw_spec",
      description: "Create, read, validate, review and publish an oc2-ulw executable spec.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["begin", "write", "read", "validate", "publish", "reopen", "list", "status"] },
          id: { type: "string" },
          content: { type: "string" },
          kind: { type: "string", enum: ["spec", "draft"] },
          offset: { type: "number" },
          limit: { type: "number" },
          expectedHash: { type: "string" },
          strict: { type: "boolean" },
          request: { type: "string" },
          intent: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      async execute(raw: unknown, tool: ToolContextLike) {
        const input = raw as ToolInput;
        const action = stringInput(input, "action");
        const { workspace } = await runtime.workspaceOfSession(tool.sessionID);
        const sessionStore = runtime.store(workspace);
        if ((await sessionStore.getBinding(tool.sessionID)) !== undefined) {
          throw new UlwError("ROLE_FORBIDDEN", "role sessions may not create or modify specs");
        }
        const activeRun = await runs.findSessionRun(workspace, tool.sessionID);
        if (activeRun?.status === "running" || activeRun?.status === "final_verification") {
          throw new UlwError("RUN_ACTIVE", "the spec is frozen while an execution run is active");
        }
        if (action === "begin") {
          const result = await specs.begin(
            {
              id: stringInput(input, "id") as string,
              ...(stringInput(input, "request", false) === undefined ? {} : { request: stringInput(input, "request", false) as string }),
              ...(stringInput(input, "intent", false) === undefined ? {} : { intent: stringInput(input, "intent", false) as string }),
              strict: boolInput(input, "strict"),
            },
            tool.sessionID,
          );
          return textResult(`spec draft ready: ${result.draftPath}\nstatus: ${result.status}`, { ...result });
        }
        if (action === "write") {
          const result = await specs.write(
            {
              id: stringInput(input, "id") as string,
              content: stringInput(input, "content") as string,
              strict: boolInput(input, "strict"),
              ...(stringInput(input, "expectedHash", false) === undefined ? {} : { expectedHash: stringInput(input, "expectedHash", false) as string }),
            },
            tool.sessionID,
          );
          return textResult(JSON.stringify(result, null, 2), { ...result });
        }
        if (action === "read") {
          const result = await specs.read(
            stringInput(input, "id") as string,
            tool.sessionID,
            stringInput(input, "kind", false) === "draft" ? "draft" : "spec",
            numberInput(input, "offset", 0),
            numberInput(input, "limit", 8192),
          );
          return textResult(result.text, { path: result.path, next: result.next, total: result.total });
        }
        if (action === "validate") {
          const result = await specs.validate(stringInput(input, "id") as string, tool.sessionID);
          return textResult(JSON.stringify(result, null, 2), { ...result });
        }
        if (action === "publish") {
          const result = await specs.publish(stringInput(input, "id") as string, tool.sessionID);
          return textResult(`spec published: ${result.path}\nstatus=${result.status} risk=${result.risk}\nreviews=${JSON.stringify(result.reviews)}`, { ...result });
        }
        if (action === "reopen") {
          const result = await specs.reopen(stringInput(input, "id") as string, tool.sessionID);
          return textResult(`spec reopened: ${result.id}; prior reviews are cleared`, { id: result.id, status: result.status });
        }
        if (action === "list") {
          const result = await specs.list(tool.sessionID);
          return textResult(JSON.stringify(result, null, 2), { specs: result });
        }
        if (action === "status") {
          const result = await specs.status(stringInput(input, "id") as string, tool.sessionID);
          return textResult(JSON.stringify(result, null, 2), { ...result });
        }
        throw new UlwError("ACTION_UNKNOWN", `unknown ulw_spec action: ${String(action)}`);
      },
    } as never);

    editor.add({
      name: "ulw_run",
      description: "Inspect, claim, check-point, pause or finalize an authorized ulw run.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "claim", "checkpoint", "block", "pause", "freeze", "reopen", "finalize"] },
          runId: { type: "string" },
          taskId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      async execute(raw: unknown, tool: ToolContextLike) {
        const input = raw as ToolInput;
        const action = stringInput(input, "action");
        const { workspace } = await runtime.workspaceOfSession(tool.sessionID);
        if ((await runtime.store(workspace).getBinding(tool.sessionID)) !== undefined) {
          throw new UlwError("ROLE_FORBIDDEN", "role sessions may not mutate run state");
        }
        const runId = stringInput(input, "runId", false) ?? (action === "status" ? (await runs.findSessionRun(workspace, tool.sessionID))?.id : (await runs.findActiveRun(workspace, tool.sessionID))?.id);
        if (runId === undefined) throw new UlwError("RUN_REQUIRED", "no active run for this session");
        if (action === "status") {
          const result = await runs.status(runId, tool.sessionID);
          return textResult(result.text, { run: result.run });
        }
        if (action === "claim") {
          const run = await runs.claim(runId, stringInput(input, "taskId") as string, tool.sessionID);
          return textResult(`task ${String(input.taskId)} claimed; attempts=${run.tasks[String(input.taskId)]?.attempts ?? 0}`);
        }
        if (action === "checkpoint") {
          const result = await runs.checkpoint(runId, stringInput(input, "taskId") as string, tool.sessionID);
          return textResult(`task ${String(input.taskId)} checked at ${result.run.tasks[String(input.taskId)]?.fingerprint?.slice(0, 12) ?? "?"}`);
        }
        if (action === "block") {
          const reason = stringInput(input, "reason") as string;
          const run = await runs.block(runId, stringInput(input, "taskId") as string, reason, tool.sessionID);
          return textResult(`task ${String(input.taskId)} blocked: ${run.tasks[String(input.taskId)]?.blockedReason ?? reason}`);
        }
        if (action === "pause") {
          const run = await runs.pause(runId, tool.sessionID, stringInput(input, "reason", false));
          return textResult(`run ${run.id} paused; workspace lock released`);
        }
        if (action === "freeze") {
          const result = await runs.freeze(runId, tool.sessionID);
          return textResult(`run ${result.run.id} frozen for final verification\ncode fingerprint: ${result.run.verificationFingerprint}\ndiff: ${result.diff}\nchanged: ${result.changed.join(", ") || "none"}`);
        }
        if (action === "reopen") {
          const run = await runs.reopen(runId, stringInput(input, "taskId") as string, tool.sessionID, stringInput(input, "reason", false));
          return textResult(`task ${String(input.taskId)} reopened; run ${run.id} is running again`);
        }
        if (action === "finalize") {
          const result = await runs.finalize(runId, tool.sessionID);
          return textResult(`RUN SUCCEEDED: ${result.run.id}\nreport: ${result.run.reportPath ?? ""}`, { run: result.run });
        }
        throw new UlwError("ACTION_UNKNOWN", `unknown ulw_run action: ${action}`);
      },
    } as never);

    editor.add({
      name: "ulw_check",
      description: "Run one frozen command check from the active spec and persist real exit/output evidence.",
      input: {
        type: "object",
        properties: {
          runId: { type: "string" },
          taskId: { type: "string" },
          checkId: { type: "string" },
        },
        required: ["checkId"],
        additionalProperties: false,
      },
      async execute(raw: unknown, tool: ToolContextLike) {
        const input = raw as ToolInput;
        const checkId = stringInput(input, "checkId") as string;
        const result = await runs.check(
          { ...(stringInput(input, "runId", false) === undefined ? {} : { runId: stringInput(input, "runId", false) as string }), ...(stringInput(input, "taskId", false) === undefined ? {} : { taskId: stringInput(input, "taskId", false) as string }), checkId },
          tool.sessionID,
          tool.signal,
          async (id) => {
            await ctx.permission.assert({
              sessionID: tool.sessionID,
              agent: tool.agent,
              source: { type: "tool", messageID: tool.messageID, id: tool.id },
              action: "ulw-check",
              resources: [id],
              save: [id],
            });
          },
        );
        return textResult(result.content, { evidence: result.evidence });
      },
    } as never);

    editor.add({
      name: "ulw_role",
      description: "Start or wait for an independent ulw research, review, verification, implementation or code-review role.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "wait", "cancel", "list"] },
          role: {
            type: "string",
            enum: ["explorer", "librarian", "consultant", "practical-reviewer", "adversarial-reviewer", "worker", "verifier", "code-reviewer"],
          },
          invocationId: { type: "string" },
          specId: { type: "string" },
          runId: { type: "string" },
          taskId: { type: "string" },
          assignment: { type: "string" },
          background: { type: "boolean" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      async execute(raw: unknown, tool: ToolContextLike) {
        const input = raw as ToolInput;
        const action = stringInput(input, "action");
        const { workspace } = await runtime.workspaceOfSession(tool.sessionID);
        if ((await runtime.store(workspace).getBinding(tool.sessionID)) !== undefined) {
          throw new UlwError("ROLE_NESTED", "a role session cannot start, wait for, or cancel another role");
        }
        if (action === "list") {
          const list = await roles.list(tool.sessionID, workspace);
          return textResult(JSON.stringify(list, null, 2), { invocations: list });
        }
        if (action === "wait") {
          const result = await roles.wait(stringInput(input, "invocationId") as string, tool.sessionID, workspace, tool.signal);
          return textResult(result.summary, { ...result });
        }
        if (action === "cancel") {
          const result = await roles.cancel(stringInput(input, "invocationId") as string, tool.sessionID, workspace);
          return textResult(result.summary, { ...result });
        }
        if (action === "start") {
          const role = stringInput(input, "role") as Parameters<RoleService["start"]>[0]["role"];
          const result = await roles.start(
            {
              role,
              ...(stringInput(input, "specId", false) === undefined ? {} : { specId: stringInput(input, "specId", false) as string }),
              ...(stringInput(input, "runId", false) === undefined ? {} : { runId: stringInput(input, "runId", false) as string }),
              ...(stringInput(input, "taskId", false) === undefined ? {} : { taskId: stringInput(input, "taskId", false) as string }),
              ...(stringInput(input, "assignment", false) === undefined ? {} : { assignment: stringInput(input, "assignment", false) as string }),
              background: boolInput(input, "background"),
            },
            { sessionID: tool.sessionID, agent: tool.agent, signal: tool.signal },
          );
          return textResult(result.summary, { ...result });
        }
        throw new UlwError("ACTION_UNKNOWN", `unknown ulw_role action: ${action}`);
      },
    } as never);

    editor.add({
      name: "ulw_report",
      description: "Submit a structured report from a bound ulw role session. The Host binds identity and target; callers cannot self-approve.",
      input: {
        type: "object",
        properties: {
          payload: { type: "object" },
          summary: { type: "string" },
        },
        required: ["payload"],
        additionalProperties: false,
      },
      async execute(raw: unknown, tool: ToolContextLike) {
        const input = raw as ToolInput;
        const payload = input.payload;
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
          throw new UlwError("REPORT_SHAPE", "payload must be an object");
        }
        const report = await roles.report(tool.sessionID, payload as Json);
        return textResult(`report accepted: ${report.id}\nrole=${report.role} target=${report.targetHash?.slice(0, 12) ?? "unversioned"}`, {
          reportId: report.id,
          role: report.role,
          targetHash: report.targetHash,
        });
      },
    } as never);
  });
}
