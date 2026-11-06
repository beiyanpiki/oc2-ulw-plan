import { SPEC_SCHEMA_GUIDE, specTemplate } from "../core/guide.js";
import { UlwError } from "../core/errors.js";
import { recordSpecDiagnostics } from "../io/diagnostics.js";
import { SpecService } from "./spec-service.js";
import { RunService } from "./run-service.js";
import { RoleService } from "./roles.js";
import { DiagnoseService } from "./diagnose-service.js";
function textResult(content, metadata) {
    return metadata === undefined ? { content } : { content, metadata };
}
function validationText(result) {
    const errors = result.diagnostics.filter((entry) => entry.severity === "error");
    const warnings = result.diagnostics.filter((entry) => entry.severity === "warning");
    const shown = [...errors.slice(0, 24), ...warnings.slice(0, 8)];
    return JSON.stringify({
        valid: result.valid,
        hash: result.hash,
        path: result.path,
        errorCount: errors.length,
        diagnostics: shown,
        truncated: errors.length + warnings.length > shown.length,
        ...(result.valid
            ? { next: "validate is clean; request an independent plan review with ulw_role, then publish" }
            : {
                next: "the file is saved as a draft; fix the reported lines with ulw_spec action=patch (edits: [{old,new}]) and call validate again. Check ids are V1, V2, ...; task keys are id, title, requirements, dependsOn, files, checks",
            }),
    }, null, 2);
}
function stringInput(input, key, required = true) {
    const value = input[key];
    if (value === undefined) {
        if (required)
            throw new UlwError("INPUT_REQUIRED", `${key} is required`);
        return undefined;
    }
    if (typeof value !== "string")
        throw new UlwError("INPUT_TYPE", `${key} must be a string`);
    return value;
}
function numberInput(input, key, fallback) {
    const value = input[key];
    if (value === undefined)
        return fallback;
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new UlwError("INPUT_TYPE", `${key} must be a number`);
    return value;
}
function boolInput(input, key) {
    return input[key] === true;
}
export async function registerTools(ctx, runtime) {
    const specs = new SpecService(runtime);
    const runs = new RunService(runtime);
    const roles = new RoleService(runtime);
    const diagnose = new DiagnoseService(runtime);
    await ctx.tool.transform((editor) => {
        editor.add({
            name: "ulw_spec",
            description: "Create, read, validate, review and publish an oc2-ulw executable spec. Start with action=template when unsure about the YAML shape.",
            input: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["begin", "write", "patch", "read", "validate", "publish", "reopen", "list", "status", "template"] },
                    id: { type: "string" },
                    content: { type: "string" },
                    edits: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                old: { type: "string" },
                                new: { type: "string" },
                                replaceAll: { type: "boolean" },
                            },
                            required: ["old", "new"],
                            additionalProperties: false,
                        },
                    },
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
            async execute(raw, tool) {
                const input = raw;
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
                if (action === "template") {
                    const id = stringInput(input, "id", false);
                    return textResult([SPEC_SCHEMA_GUIDE, "", "Filled template:", "", "```markdown", specTemplate(id), "```"].join("\n"), { id: id ?? "example-spec" });
                }
                if (action === "begin") {
                    const result = await specs.begin({
                        id: stringInput(input, "id"),
                        ...(stringInput(input, "request", false) === undefined ? {} : { request: stringInput(input, "request", false) }),
                        ...(stringInput(input, "intent", false) === undefined ? {} : { intent: stringInput(input, "intent", false) }),
                        strict: boolInput(input, "strict"),
                    }, tool.sessionID);
                    return textResult(`spec draft ready: ${result.draftPath}\nstatus: ${result.status}\n\n${result.template}`, {
                        id: result.id,
                        draftPath: result.draftPath,
                        specPath: result.specPath,
                        status: result.status,
                    });
                }
                if (action === "write") {
                    const result = await specs.write({
                        id: stringInput(input, "id"),
                        content: stringInput(input, "content"),
                        strict: boolInput(input, "strict"),
                        ...(stringInput(input, "expectedHash", false) === undefined ? {} : { expectedHash: stringInput(input, "expectedHash", false) }),
                    }, tool.sessionID);
                    if (!result.valid) {
                        await recordSpecDiagnostics(workspace, {
                            sessionID: tool.sessionID,
                            agent: tool.agent,
                            action: "write",
                            diagnostics: result.diagnostics,
                        }).catch(() => undefined);
                    }
                    return textResult(validationText(result), { valid: result.valid, hash: result.hash, path: result.path });
                }
                if (action === "patch") {
                    const rawEdits = input.edits;
                    if (!Array.isArray(rawEdits))
                        throw new UlwError("INPUT_REQUIRED", "edits is required for action=patch");
                    const edits = rawEdits.map((entry, index) => {
                        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
                            throw new UlwError("INPUT_TYPE", `edits[${index}] must be an object`);
                        }
                        const edit = entry;
                        if (typeof edit.old !== "string" || edit.old === "")
                            throw new UlwError("INPUT_TYPE", `edits[${index}].old must be a non-empty string`);
                        if (typeof edit.new !== "string")
                            throw new UlwError("INPUT_TYPE", `edits[${index}].new must be a string`);
                        return {
                            old: edit.old,
                            new: edit.new,
                            ...(edit.replaceAll === true ? { replaceAll: true } : {}),
                        };
                    });
                    const result = await specs.patch({
                        id: stringInput(input, "id"),
                        edits,
                        strict: boolInput(input, "strict"),
                        ...(stringInput(input, "expectedHash", false) === undefined ? {} : { expectedHash: stringInput(input, "expectedHash", false) }),
                    }, tool.sessionID);
                    if (!result.valid) {
                        await recordSpecDiagnostics(workspace, {
                            sessionID: tool.sessionID,
                            agent: tool.agent,
                            action: "patch",
                            diagnostics: result.diagnostics,
                        }).catch(() => undefined);
                    }
                    return textResult(validationText(result), { valid: result.valid, hash: result.hash, path: result.path });
                }
                if (action === "read") {
                    const result = await specs.read(stringInput(input, "id"), tool.sessionID, stringInput(input, "kind", false) === "draft" ? "draft" : "spec", numberInput(input, "offset", 0), numberInput(input, "limit", 8192));
                    return textResult(result.text, { path: result.path, next: result.next, total: result.total });
                }
                if (action === "validate") {
                    const result = await specs.validate(stringInput(input, "id"), tool.sessionID);
                    if (!result.valid) {
                        await recordSpecDiagnostics(workspace, {
                            sessionID: tool.sessionID,
                            agent: tool.agent,
                            action: "validate",
                            diagnostics: result.diagnostics,
                        }).catch(() => undefined);
                    }
                    return textResult(validationText(result), { valid: result.valid, hash: result.hash, path: result.path });
                }
                if (action === "publish") {
                    const result = await specs.publish(stringInput(input, "id"), tool.sessionID);
                    return textResult(`spec published: ${result.path}\nstatus=${result.status} risk=${result.risk}\nreviews=${JSON.stringify(result.reviews)}`, { ...result });
                }
                if (action === "reopen") {
                    const result = await specs.reopen(stringInput(input, "id"), tool.sessionID);
                    return textResult(`spec reopened: ${result.id}; prior reviews are cleared`, { id: result.id, status: result.status });
                }
                if (action === "list") {
                    const result = await specs.list(tool.sessionID);
                    return textResult(JSON.stringify(result, null, 2), { specs: result });
                }
                if (action === "status") {
                    const result = await specs.status(stringInput(input, "id"), tool.sessionID);
                    return textResult(JSON.stringify(result, null, 2), { ...result });
                }
                throw new UlwError("ACTION_UNKNOWN", `unknown ulw_spec action: ${String(action)}`);
            },
        });
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
            async execute(raw, tool) {
                const input = raw;
                const action = stringInput(input, "action");
                const { workspace } = await runtime.workspaceOfSession(tool.sessionID);
                if ((await runtime.store(workspace).getBinding(tool.sessionID)) !== undefined) {
                    throw new UlwError("ROLE_FORBIDDEN", "role sessions may not mutate run state");
                }
                const runId = stringInput(input, "runId", false) ?? (action === "status" ? (await runs.findSessionRun(workspace, tool.sessionID))?.id : (await runs.findActiveRun(workspace, tool.sessionID))?.id);
                if (runId === undefined)
                    throw new UlwError("RUN_REQUIRED", "no active run for this session");
                if (action === "status") {
                    const result = await runs.status(runId, tool.sessionID);
                    return textResult(result.text, { run: result.run });
                }
                if (action === "claim") {
                    const run = await runs.claim(runId, stringInput(input, "taskId"), tool.sessionID);
                    return textResult(`task ${String(input.taskId)} claimed; attempts=${run.tasks[String(input.taskId)]?.attempts ?? 0}`);
                }
                if (action === "checkpoint") {
                    const result = await runs.checkpoint(runId, stringInput(input, "taskId"), tool.sessionID);
                    return textResult(`task ${String(input.taskId)} checked at ${result.run.tasks[String(input.taskId)]?.fingerprint?.slice(0, 12) ?? "?"}`);
                }
                if (action === "block") {
                    const reason = stringInput(input, "reason");
                    const run = await runs.block(runId, stringInput(input, "taskId"), reason, tool.sessionID);
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
                    const run = await runs.reopen(runId, stringInput(input, "taskId"), tool.sessionID, stringInput(input, "reason", false));
                    return textResult(`task ${String(input.taskId)} reopened; run ${run.id} is running again`);
                }
                if (action === "finalize") {
                    const result = await runs.finalize(runId, tool.sessionID);
                    return textResult(`RUN SUCCEEDED: ${result.run.id}\nreport: ${result.run.reportPath ?? ""}`, { run: result.run });
                }
                throw new UlwError("ACTION_UNKNOWN", `unknown ulw_run action: ${action}`);
            },
        });
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
            async execute(raw, tool) {
                const input = raw;
                const checkId = stringInput(input, "checkId");
                const result = await runs.check({ ...(stringInput(input, "runId", false) === undefined ? {} : { runId: stringInput(input, "runId", false) }), ...(stringInput(input, "taskId", false) === undefined ? {} : { taskId: stringInput(input, "taskId", false) }), checkId }, tool.sessionID, tool.signal, async (id) => {
                    await ctx.permission.assert({
                        sessionID: tool.sessionID,
                        agent: tool.agent,
                        source: { type: "tool", messageID: tool.messageID, id: tool.id },
                        action: "ulw-check",
                        resources: [id],
                        save: [id],
                    });
                });
                return textResult(result.content, { evidence: result.evidence });
            },
        });
        editor.add({
            name: "ulw_role",
            description: "Start or wait for an independent ulw role. explorer/librarian/consultant accept a draft id or only an assignment; reviewers need a spec; workers and final roles need a run. background=true returns immediately: call action=wait with the invocation id before using the result.",
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
            async execute(raw, tool) {
                const input = raw;
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
                    const result = await roles.wait(stringInput(input, "invocationId"), tool.sessionID, workspace, tool.signal);
                    return textResult(result.summary, { ...result });
                }
                if (action === "cancel") {
                    const result = await roles.cancel(stringInput(input, "invocationId"), tool.sessionID, workspace);
                    return textResult(result.summary, { ...result });
                }
                if (action === "start") {
                    const role = stringInput(input, "role");
                    const result = await roles.start({
                        role,
                        ...(stringInput(input, "specId", false) === undefined ? {} : { specId: stringInput(input, "specId", false) }),
                        ...(stringInput(input, "runId", false) === undefined ? {} : { runId: stringInput(input, "runId", false) }),
                        ...(stringInput(input, "taskId", false) === undefined ? {} : { taskId: stringInput(input, "taskId", false) }),
                        ...(stringInput(input, "assignment", false) === undefined ? {} : { assignment: stringInput(input, "assignment", false) }),
                        background: boolInput(input, "background"),
                    }, { sessionID: tool.sessionID, agent: tool.agent, signal: tool.signal });
                    return textResult(result.summary, { ...result });
                }
                throw new UlwError("ACTION_UNKNOWN", `unknown ulw_role action: ${action}`);
            },
        });
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
            async execute(raw, tool) {
                const input = raw;
                const payload = input.payload;
                if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
                    throw new UlwError("REPORT_SHAPE", "payload must be an object");
                }
                const report = await roles.report(tool.sessionID, payload);
                return textResult(`report accepted: ${report.id}\nrole=${report.role} target=${report.targetHash?.slice(0, 12) ?? "unversioned"}`, {
                    reportId: report.id,
                    role: report.role,
                    targetHash: report.targetHash,
                });
            },
        });
        editor.add({
            name: "ulw_diagnose",
            description: "Read-only Host snapshot of specs, runs, role invocations, the workspace lock and recent failures. Use it to monitor a long ulw flow or to explain a stuck run.",
            input: {
                type: "object",
                properties: {
                    limit: { type: "number" },
                },
                additionalProperties: false,
            },
            async execute(raw, tool) {
                const input = raw;
                const limit = Math.max(1, Math.min(200, Math.floor(numberInput(input, "limit", 20))));
                const result = await diagnose.report(tool.sessionID, limit);
                return textResult(result.text, result.metadata);
            },
        });
    });
}
//# sourceMappingURL=tools.js.map